/** Cloudflare adapter tests with WebSocketPair / ASSETS doubles. */
import { assertEquals, assertStringIncludes } from '@std/assert';
import { LIVE_WS_PATH } from '../../src/static/js/shared/protocol.js';
import worker from '../../src/worker.ts';
import { FakeWebSocket } from '../helpers/fake_websocket.ts';

class FakeServerSocket extends FakeWebSocket {
    accepted = false;
    accept() {
        this.accepted = true;
        this.readyState = 1;
    }
}

const pairs: FakeServerSocket[][] = [];
const outbound: FakeWebSocket[] = [];

function install() {
    const g = globalThis as Record<string, unknown>;
    const original = { WebSocketPair: g.WebSocketPair, WebSocket: g.WebSocket, Response: g.Response };
    g.WebSocketPair = class {
        0: FakeServerSocket;
        1: FakeServerSocket;
        constructor() {
            this[0] = new FakeServerSocket('client');
            this[1] = new FakeServerSocket('server');
            pairs.push([this[0], this[1]]);
        }
    };
    g.WebSocket = class extends FakeWebSocket {
        constructor(url: string) {
            super(url);
            outbound.push(this);
        }
    };
    // Workers allow status 101 with a webSocket; the standard Response constructor does not.
    const RealResponse = original.Response as typeof Response;
    g.Response = class extends RealResponse {
        webSocket?: unknown;
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
            const is101 = init?.status === 101;
            super(body, is101 ? { ...init, status: 200 } : init);
            if (is101) this.webSocket = init?.webSocket;
        }
    };
    return () => Object.assign(g, original);
}

Deno.test('cloudflare: static requests go to the ASSETS binding with security headers', async () => {
    const env = {
        ASSETS: { fetch: () => Promise.resolve(new Response('<html>', { headers: { 'content-type': 'text/html' } })) },
    };
    const res = await worker.fetch(new Request('https://w.example/'), env);
    assertEquals(await res.text(), '<html>');
    assertStringIncludes(res.headers.get('content-security-policy') ?? '', "default-src 'self'");
});

Deno.test('cloudflare: /api/config reflects bindings without leaking them', async () => {
    const env = { GEMINI_API_KEY: 'AIzaCfKey', ACCESS_PASSWORD: 'a long enough password' };
    const res = await worker.fetch(new Request('https://w.example/api/config'), env);
    assertEquals(await res.json(), { serverKeyAvailable: true, sessionRequired: true });
});

Deno.test({
    name: 'cloudflare: live sessions use WebSocketPair and relay through an outbound WebSocket',
    sanitizeOps: false,
    async fn() {
        const restore = install();
        try {
            const env = { ASSETS: { fetch: () => Promise.resolve(new Response('x')) } };
            const req = new Request(`https://w.example${LIVE_WS_PATH}`, {
                headers: { upgrade: 'websocket', origin: 'https://w.example', 'cf-connecting-ip': '9.9.9.9' },
            });
            const res = await worker.fetch(req, env) as Response & { webSocket?: unknown };
            const [client, server] = pairs.at(-1)!;
            assertEquals(res.webSocket, client);
            assertEquals(server.accepted, true);

            server.receive(JSON.stringify({ auth: { apiKey: 'AIzaCloudflareKey_00000000' } }));
            server.receive('{"setup":{}}');
            await new Promise((r) => setTimeout(r, 20));
            const upstream = outbound.at(-1)!;
            assertStringIncludes(upstream.url, 'key=AIzaCloudflareKey_00000000');
            upstream.open();
            assertEquals(upstream.sent, ['{"setup":{}}']);
            upstream.receive('{"setupComplete":{}}');
            assertEquals(server.sent, ['{"setupComplete":{}}']);
            server.remoteClose(1000);
            assertEquals(upstream.closedWith?.code, 1000);
        } finally {
            restore();
        }
    },
});
