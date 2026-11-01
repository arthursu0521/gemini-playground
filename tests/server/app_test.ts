import { assertEquals, assertStringIncludes } from '@std/assert';
import { createApp, type Platform } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { createLogger } from '../../src/server/log.ts';
import { LIVE_WS_PATH } from '../../src/static/js/shared/protocol.js';
import { FakeWebSocket } from '../helpers/fake_websocket.ts';

const silent = createLogger('error', [], { log() {}, warn() {}, error() {} });

function fakePlatform(overrides: Partial<Platform> = {}) {
    const upgraded: FakeWebSocket[] = [];
    const upstreams: FakeWebSocket[] = [];
    const platform: Platform = {
        serveStatic: () => Promise.resolve(new Response('<html>', { headers: { 'content-type': 'text/html' } })),
        upgradeWebSocket() {
            const socket = new FakeWebSocket('server');
            socket.readyState = 1;
            upgraded.push(socket);
            return { socket, response: new Response(null, { status: 200, headers: { 'x-upgraded': '1' } }) };
        },
        connectUpstream(url) {
            const socket = new FakeWebSocket(url);
            upstreams.push(socket);
            return socket;
        },
        fetch: () => Promise.resolve(new Response('{}')),
        ...overrides,
    };
    return { platform, upgraded, upstreams };
}

const wsRequest = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://play.example${path}`, {
        headers: { upgrade: 'websocket', origin: 'https://play.example', ...headers },
    });

Deno.test('websocket upgrades from foreign origins are refused before upgrading (CSWSH)', async () => {
    const { platform, upgraded } = fakePlatform();
    const app = createApp(
        loadConfig((n) => ({ ALLOWED_ORIGINS: 'https://friend.example,https://play.example' })[n]),
        platform,
        silent,
    );
    const res = await app.handle(wsRequest(LIVE_WS_PATH, { origin: 'https://evil.example' }), { clientIp: '1.2.3.4' });
    assertEquals(res.status, 403);
    assertEquals(upgraded.length, 0);

    const same = await app.handle(wsRequest(LIVE_WS_PATH, { origin: 'https://play.example' }), { clientIp: '1' });
    assertEquals(same.headers.get('x-upgraded'), '1');
    const friend = await app.handle(wsRequest(LIVE_WS_PATH, { origin: 'https://friend.example' }), {
        clientIp: '1',
    });
    assertEquals(friend.headers.get('x-upgraded'), '1');
});

Deno.test('relay forwards frames after auth and maps upstream close codes (fake sockets)', async () => {
    const { platform, upgraded, upstreams } = fakePlatform();
    const app = createApp(loadConfig(() => undefined), platform, silent);
    await app.handle(wsRequest(LIVE_WS_PATH), { clientIp: '1' });
    const client = upgraded[0];
    client.receive(JSON.stringify({ auth: { apiKey: 'AIzaFakeKey_000000000000000' } }));
    client.receive('{"setup":{}}');
    await new Promise((r) => setTimeout(r, 20));
    const upstream = upstreams[0];
    assertStringIncludes(upstream.url, 'wss://generativelanguage.googleapis.com/ws/');
    assertStringIncludes(upstream.url, 'key=AIzaFakeKey_000000000000000');
    assertEquals(upstream.sent, []);
    upstream.open();
    assertEquals(upstream.sent, ['{"setup":{}}']);
    upstream.receive('{"setupComplete":{}}');
    assertEquals(client.sent, ['{"setupComplete":{}}']);
    upstream.remoteClose(1011, 'Internal error');
    assertEquals(client.closedWith, { code: 4011, reason: 'Internal error' });
});

Deno.test('unexpected errors become 500 with security headers, not crashes', async () => {
    const { platform } = fakePlatform({ serveStatic: () => Promise.reject(new Error('disk on fire')) });
    const app = createApp(loadConfig(() => undefined), platform, silent);
    const res = await app.handle(new Request('https://play.example/index.html'), { clientIp: '1' });
    assertEquals(res.status, 500);
    assertEquals(res.headers.get('x-content-type-options'), 'nosniff');
});
