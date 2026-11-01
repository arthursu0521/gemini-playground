import { assert, assertEquals } from '@std/assert';
import { createApp, type Platform } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { hashPassword, SessionAuth } from '../../src/server/session.ts';
import { FakeWebSocket } from '../helpers/fake_websocket.ts';
import { LIVE_WS_PATH } from '../../src/static/js/shared/protocol.js';

Deno.test('idle sockets close across instances on revocation, version rotation and KV failure', async () => {
    const kv = await Deno.openKv(':memory:');
    const hash = await hashPassword('test password');
    let available = true;
    const auth = new SessionAuth({
        kv: () => available ? Promise.resolve(kv) : Promise.reject(new Error('offline')),
        passwordHash: hash,
    });
    const other = new SessionAuth({ kv: () => Promise.resolve(kv), passwordHash: hash });
    const clients: FakeWebSocket[] = [], upstreams: FakeWebSocket[] = [];
    const platform: Platform = {
        sessions: auth,
        sessionCheckMs: 5,
        serveStatic: () => Promise.resolve(new Response('static')),
        upgradeWebSocket() {
            const socket = new FakeWebSocket('client');
            socket.open();
            clients.push(socket);
            return { socket, response: new Response('ok') };
        },
        connectUpstream(url) {
            const socket = new FakeWebSocket(url);
            upstreams.push(socket);
            return socket;
        },
        fetch: () => Promise.resolve(new Response('upstream')),
    };
    const app = createApp(
        loadConfig((n) => ({ ACCESS_PASSWORD_HASH: hash, GEMINI_API_KEY: 'test_server_key_000000000' })[n]),
        platform,
    );
    const open = async () => {
        const token = await auth.login('test password', crypto.randomUUID());
        assert(token);
        const response = await app.handle(
            new Request(`https://test.example${LIVE_WS_PATH}`, {
                headers: {
                    origin: 'https://test.example',
                    upgrade: 'websocket',
                    cookie: `__Host-gemini_session=${token}`,
                },
            }),
            { clientIp: '1' },
        );
        assertEquals(response.status, 200);
        clients.at(-1)!.receive('{"auth":{}}');
        await new Promise((r) => setTimeout(r, 1));
        upstreams.at(-1)!.open();
        return token;
    };
    try {
        await other.revoke(await open());
        await new Promise((r) => setTimeout(r, 35));
        assertEquals(clients.at(-1)!.closedWith?.code, 4401);
        assertEquals(upstreams.at(-1)!.closedWith?.code, 1000);
        await open();
        available = false;
        await new Promise((r) => setTimeout(r, 35));
        assertEquals(clients.at(-1)!.closedWith?.code, 4401);
        available = true;
        await open();
        const rotated = new SessionAuth({
            kv: () => Promise.resolve(kv),
            passwordHash: await hashPassword('new password'),
            passwordVersion: '2',
        });
        await rotated.publishVersion();
        await new Promise((r) => setTimeout(r, 35));
        assertEquals(clients.at(-1)!.closedWith?.code, 4401);
    } finally {
        for (const client of clients) client.close();
        kv.close();
    }
});

Deno.test('configured sessions absent fail closed for all protected surfaces without leaking cacheable errors', async () => {
    const platform: Platform = {
        serveStatic: () => Promise.resolve(new Response('static')),
        upgradeWebSocket() {
            throw new Error('must not upgrade');
        },
        connectUpstream() {
            throw new Error('must not connect');
        },
        fetch() {
            throw new Error('must not fetch');
        },
    };
    const app = createApp(
        loadConfig((n) => ({ ACCESS_PASSWORD_HASH: 'malformed', GEMINI_API_KEY: 'test_server_key_0000000' })[n]),
        platform,
    );
    for (const path of ['/v1/models', LIVE_WS_PATH, '/auth/login']) {
        const response = await app.handle(
            new Request('https://test.example' + path, {
                method: path === '/auth/login' ? 'POST' : 'GET',
                headers: { origin: 'https://test.example', ...(path === LIVE_WS_PATH ? { upgrade: 'websocket' } : {}) },
            }),
            { clientIp: '1' },
        );
        assertEquals(response.status, 503);
        assertEquals(response.headers.get('cache-control'), 'no-store');
    }
});
