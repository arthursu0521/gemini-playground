import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { createApp, type Platform } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { SessionAuth } from '../../src/server/session.ts';
import { FakeWebSocket } from '../helpers/fake_websocket.ts';
import { LIVE_WS_PATH } from '../../src/static/js/shared/protocol.js';

Deno.test('HTTPS login issues host cookie; missing/foreign origins and password/key bypasses rejected before upgrade or fetch', async () => {
    const kv = await Deno.openKv(':memory:');
    const password = 'correct horse battery';
    const auth = new SessionAuth({ kv: () => Promise.resolve(kv), password });
    let upgrades = 0, fetches = 0;
    const sockets: FakeWebSocket[] = [];
    const platform: Platform = {
        sessions: auth,
        serveStatic: () => Promise.resolve(new Response('static')),
        upgradeWebSocket() {
            upgrades++;
            const socket = new FakeWebSocket('client');
            socket.open();
            sockets.push(socket);
            return { socket, response: new Response('upgraded') };
        },
        connectUpstream: (url) => new FakeWebSocket(url),
        fetch: () => {
            fetches++;
            return Promise.resolve(new Response('{}'));
        },
    };
    const app = createApp(
        loadConfig((n) =>
            ({
                ACCESS_PASSWORD: password,
                GEMINI_API_KEY: 'test_server_key_00000000000',
                ALLOWED_ORIGINS: 'https://gemini.spdt.work,https://talk.aesc.ai',
            })[n]
        ),
        platform,
    );
    const call = (path: string, init: RequestInit = {}, origin: string | null = 'https://gemini.spdt.work') => {
        const headers = new Headers(init.headers);
        if (origin) headers.set('origin', origin);
        return app.handle(new Request(`https://gemini.spdt.work${path}`, { ...init, headers }), { clientIp: 'test' });
    };
    try {
        for (const origin of [null, 'https://evil.example', 'null', 'https://gemini.spdt.work.evil']) {
            assertEquals(
                (await call('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }, origin)).status,
                403,
            );
            assertEquals((await call(LIVE_WS_PATH, { headers: { upgrade: 'websocket' } }, origin)).status, 403);
        }
        for (
            const path of [
                '/models',
                '/v1/models',
                '/openai/models',
                '/openai/v1/models',
                '/v1beta/openai/models',
                '/chat/completions',
                '/embeddings',
                '/images/generations',
            ]
        ) {
            assertEquals(
                (await call(path, { headers: { authorization: 'Bearer test_personal_key_000000000' } })).status,
                401,
            );
        }
        assertEquals(
            (await call(LIVE_WS_PATH + '?key=test_personal_key_000000000', { headers: { upgrade: 'websocket' } }))
                .status,
            401,
        );
        assertEquals(upgrades, 0);
        assertEquals(fetches, 0);
        const alias = await app.handle(
            new Request('https://preview.homer.deno.net/auth/login', {
                method: 'POST',
                headers: { origin: 'https://talk.aesc.ai', 'content-type': 'application/json' },
                body: JSON.stringify({ password }),
            }),
            { clientIp: 'alias' },
        );
        assertEquals(alias.status, 200);
        const login = await call('/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        assertEquals(login.status, 200);
        const cookie = login.headers.get('set-cookie')!;
        for (
            const attr of ['__Host-gemini_session=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']
        ) assertStringIncludes(cookie, attr);
        const headers = { cookie: cookie.split(';')[0] };
        assertEquals((await call('/auth/session', { headers })).status, 200);
        assertEquals((await call('/v1/models', { headers })).status, 200);
        assertEquals(fetches, 1);
        assertEquals((await call(LIVE_WS_PATH, { headers: { ...headers, upgrade: 'websocket' } })).status, 200);
        assertEquals(upgrades, 1);
        assertEquals((await call('/auth/logout', { method: 'POST', headers })).status, 200);
        assert(sockets[0].closedWith);
        assertEquals((await call('/v1/models', { headers })).status, 401);
        assertEquals(
            (await app.handle(
                new Request('http://gemini.spdt.work/auth/login', {
                    method: 'POST',
                    headers: { origin: 'https://gemini.spdt.work' },
                    body: JSON.stringify({ password }),
                }),
                { clientIp: 'test' },
            )).status,
            403,
        );
    } finally {
        for (const socket of sockets) socket.close();
        kv.close();
    }
});
