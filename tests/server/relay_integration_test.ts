/**
 * Integration tests: the real Deno server + relay, talking to a mock Gemini over real sockets.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { WebSocket as HeaderWebSocket } from 'npm:ws@8.18.3';
import { LIVE_WS_PATH } from '../../src/static/js/shared/protocol.js';
import { startAppServer } from '../helpers/app_server.ts';
import { startMockGemini } from '../helpers/mock_gemini.ts';

const CLIENT_KEY = 'AIzaTestKeyValid_0000000000000000000';
const SERVER_KEY = 'AIzaServerKeyValid_00000000000000000';
const PASSWORD = 'correct horse battery staple';
const opts = { sanitizeOps: false, sanitizeResources: false };

interface TestClient {
    ws: WebSocket;
    received: Record<string, unknown>[];
    closed: Promise<{ code: number; reason: string }>;
    opened: Promise<void>;
    next(predicate: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

function connect(url: string): TestClient {
    const ws = new HeaderWebSocket(url, {
        headers: { origin: new URL(url).origin.replace(/^ws/, 'http') },
    }) as unknown as WebSocket;
    ws.addEventListener('error', () => {});
    ws.binaryType = 'arraybuffer';
    const received: Record<string, unknown>[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
    );
    const opened = new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
    ws.addEventListener('message', (e) => {
        const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
        received.push(JSON.parse(text));
    });
    return {
        ws,
        received,
        closed,
        opened,
        async next(predicate) {
            for (let i = 0; i < 300; i++) {
                const hit = received.find(predicate);
                if (hit) return hit;
                await new Promise((r) => setTimeout(r, 10));
            }
            throw new Error('client: message not received');
        },
    };
}

function setup(vars: Record<string, string> = {}, mockOptions = {}) {
    const mock = startMockGemini({ validKeys: [CLIENT_KEY, SERVER_KEY], ...mockOptions });
    const app = startAppServer({ UPSTREAM_BASE_URL: mock.baseUrl, ...vars });
    return {
        mock,
        app,
        liveUrl: `${app.wsOrigin}${LIVE_WS_PATH}`,
        async close() {
            await app.close();
            await mock.close();
        },
    };
}

function assertNoSecretsLogged(logs: string[]) {
    const all = logs.join('\n');
    for (const secret of [CLIENT_KEY, SERVER_KEY, PASSWORD]) {
        assertFalse(all.includes(secret), `secret leaked into logs: ${secret}`);
    }
}

Deno.test({
    name: 'live: auth message is consumed, frames are queued until upstream opens and relayed both ways',
    ...opts,
    async fn() {
        const env = setup({}, { acceptDelayMs: 150 });
        const client = connect(env.liveUrl);
        await client.opened;
        // Send everything immediately: setup must wait in the relay queue while upstream connects.
        client.ws.send(JSON.stringify({ auth: { apiKey: CLIENT_KEY } }));
        client.ws.send(JSON.stringify({ setup: { model: 'models/gemini-3.8-live' } }));
        client.ws.send(JSON.stringify({ clientContent: { turns: [], turnComplete: true } }));

        const upstream = await env.mock.nextConnection();
        assertEquals(upstream.key, CLIENT_KEY);
        assertEquals([...upstream.url.searchParams.keys()], ['key']);
        await client.next((m) => 'setupComplete' in m);
        await upstream.waitFor((m) => 'clientContent' in m);
        assertEquals(Object.keys(upstream.messages[0]), ['setup'], 'auth envelope must not be forwarded');

        upstream.send({ serverContent: { turnComplete: true } });
        await client.next((m) => 'serverContent' in m);

        client.ws.close(1000);
        assertEquals((await upstream.closed).code, 1000);
        await new Promise((r) => setTimeout(r, 50));
        assertNoSecretsLogged(env.app.logs);
        assert(env.app.logs.some((l) => l.includes('live session closed')));
        await env.close();
    },
});

Deno.test({
    name: 'live: legacy ?key= in the URL still works and is never logged',
    ...opts,
    async fn() {
        const env = setup();
        const client = connect(`${env.liveUrl}?key=${CLIENT_KEY}`);
        await client.opened;
        client.ws.send(JSON.stringify({ setup: { model: 'models/x' } }));
        const upstream = await env.mock.nextConnection();
        assertEquals(upstream.key, CLIENT_KEY);
        await client.next((m) => 'setupComplete' in m);
        client.ws.close();
        await client.closed;
        assertNoSecretsLogged(env.app.logs);
        await env.close();
    },
});

Deno.test({
    name: 'live: configured password forbids HTTP upgrades, including personal key bypass',
    ...opts,
    async fn() {
        const env = setup({ GEMINI_API_KEY: SERVER_KEY, ACCESS_PASSWORD: PASSWORD });
        const res = await fetch(`${env.app.origin}${LIVE_WS_PATH}?key=${CLIENT_KEY}`, {
            headers: { upgrade: 'websocket', origin: env.app.origin },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();
        assertEquals(env.mock.connections.length, 0);
        await env.close();
    },
});

Deno.test({
    name: "live: Google's 1007 (bad key) reaches the browser as 4007 with the reason",
    ...opts,
    async fn() {
        const env = setup();
        const client = connect(env.liveUrl);
        await client.opened;
        client.ws.send(JSON.stringify({ auth: { apiKey: 'AIzaInvalidKey_000000000000000000' } }));
        const { code, reason } = await client.closed;
        assertEquals(code, 4007);
        assertStringIncludes(reason, 'API key not valid');
        await env.close();
    },
});

Deno.test({
    name: 'live: a first message without auth is rejected with 4401',
    ...opts,
    async fn() {
        const env = setup();
        const client = connect(env.liveUrl);
        await client.opened;
        client.ws.send(JSON.stringify({ setup: { model: 'models/x' } }));
        assertEquals((await client.closed).code, 4401);
        await env.close();
    },
});

Deno.test({
    name: 'live: silent clients time out with 4408',
    ...opts,
    async fn() {
        const env = setup({ AUTH_TIMEOUT_MS: '150' });
        const client = connect(env.liveUrl);
        assertEquals((await client.closed).code, 4408);
        await env.close();
    },
});

Deno.test({
    name: 'live: unknown WebSocket paths are refused',
    ...opts,
    async fn() {
        const env = setup();
        const client = connect(`${env.app.wsOrigin}/ws/not-gemini`);
        // Handshake rejected (HTTP 404): browsers report 1006, Deno reports 0.
        assert([0, 1006].includes((await client.closed).code));
        const res = await fetch(`${env.app.origin}/ws/not-gemini`, { headers: { upgrade: 'websocket' } });
        assertEquals(res.status, 404);
        await res.body?.cancel();
        assertEquals(env.mock.connections.length, 0);
        await env.close();
    },
});

Deno.test({
    name: 'live: per-IP session rate limit closes with 4429',
    ...opts,
    async fn() {
        const env = setup({ WS_CONNECTIONS_PER_MINUTE: '1' });
        const first = connect(env.liveUrl);
        await first.opened;
        const second = connect(env.liveUrl);
        const { code, reason } = await second.closed;
        assertEquals(code, 4429);
        assertStringIncludes(reason, 'Too many sessions');
        first.ws.close();
        await first.closed;
        await env.close();
    },
});

Deno.test({
    name: 'live: unreachable upstream closes with 4502',
    ...opts,
    async fn() {
        const app = startAppServer({ UPSTREAM_BASE_URL: 'http://127.0.0.1:9' });
        const client = connect(`${app.wsOrigin}${LIVE_WS_PATH}`);
        await client.opened;
        client.ws.send(JSON.stringify({ auth: { apiKey: CLIENT_KEY } }));
        assertEquals((await client.closed).code, 4502);
        await app.close();
    },
});

Deno.test({
    name: 'live: upstream closing normally closes the client normally',
    ...opts,
    async fn() {
        const env = setup();
        const client = connect(env.liveUrl);
        await client.opened;
        client.ws.send(JSON.stringify({ auth: { apiKey: CLIENT_KEY } }));
        const upstream = await env.mock.nextConnection();
        await new Promise((r) => setTimeout(r, 50));
        upstream.socket.close(1000, 'bye');
        assertEquals(await client.closed, { code: 1000, reason: 'bye' });
        await env.close();
    },
});

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible API
// ---------------------------------------------------------------------------------------------

Deno.test({
    name: 'openai: chat completions go to /v1beta/openai with the client key and a default model',
    ...opts,
    async fn() {
        const env = setup();
        const res = await fetch(`${env.app.origin}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json', cookie: 'x=1' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        assertEquals(res.status, 200);
        assertEquals((await res.json()).choices[0].message.content, 'hi');
        assertEquals(res.headers.get('access-control-allow-origin'), '*');
        const call = env.mock.restCalls[0];
        assertEquals(call.path, '/v1beta/openai/chat/completions');
        assertEquals(call.headers.get('authorization'), `Bearer ${CLIENT_KEY}`);
        assertEquals(call.headers.get('cookie'), null, 'client cookies must not be forwarded');
        assertEquals(JSON.parse(call.body).model, 'gemini-3.8-flash');
        assertNoSecretsLogged(env.app.logs);
        await env.close();
    },
});

Deno.test({
    name: 'openai: legacy and alternate path prefixes map to the same upstream routes',
    ...opts,
    async fn() {
        const env = setup();
        const headers = { authorization: `Bearer ${CLIENT_KEY}` };
        for (const path of ['/v1/models', '/models', '/v1beta/openai/models', '/v1/models/gemini-3.8-flash']) {
            const res = await fetch(`${env.app.origin}${path}`, { headers });
            assertEquals(res.status, 200, path);
            await res.body?.cancel();
        }
        assertEquals(env.mock.restCalls.map((c) => c.path), [
            '/v1beta/openai/models',
            '/v1beta/openai/models',
            '/v1beta/openai/models',
            '/v1beta/openai/models/gemini-3.8-flash',
        ]);
        const embed = await fetch(`${env.app.origin}/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'x' }),
        });
        await embed.body?.cancel();
        assertEquals(JSON.parse(env.mock.restCalls[4].body).model, 'gemini-embedding-001');
        await env.close();
    },
});

Deno.test({
    name: 'openai: access password bearer cannot bypass session authentication',
    ...opts,
    async fn() {
        const env = setup({ GEMINI_API_KEY: SERVER_KEY, ACCESS_PASSWORD: PASSWORD });
        const res = await fetch(`${env.app.origin}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${PASSWORD}` },
            body: JSON.stringify({ model: 'gemini-x', messages: [] }),
        });
        await res.body?.cancel();
        assertEquals(res.status, 401);
        assertEquals(env.mock.restCalls.length, 0);
        assertNoSecretsLogged(env.app.logs);
        await env.close();
    },
});

Deno.test({
    name: 'openai: streaming responses are passed through unchanged',
    ...opts,
    async fn() {
        const sse =
            'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\ndata: [DONE]\n\n';
        const env = setup({}, {
            onRest: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
        });
        const res = await fetch(`${env.app.origin}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${CLIENT_KEY}`, accept: 'text/event-stream' },
            body: JSON.stringify({ stream: true, messages: [] }),
        });
        assertEquals(res.headers.get('content-type'), 'text/event-stream');
        assertEquals(await res.text(), sse);
        assertEquals(env.mock.restCalls[0].headers.get('accept'), 'text/event-stream');
        await env.close();
    },
});

Deno.test({
    name: 'openai: upstream errors keep their status and body',
    ...opts,
    async fn() {
        const env = setup({}, {
            onRest: () => Response.json([{ error: { code: 400, message: 'API key not valid' } }], { status: 400 }),
        });
        const res = await fetch(`${env.app.origin}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${CLIENT_KEY}` },
            body: '{}',
        });
        assertEquals(res.status, 400);
        assertStringIncludes(await res.text(), 'API key not valid');
        await env.close();
    },
});

Deno.test({
    name: 'openai: request validation (auth, method, JSON, size) and preflight',
    ...opts,
    async fn() {
        const env = setup({ MAX_REQUEST_BODY_BYTES: '100' });
        const base = `${env.app.origin}/v1/chat/completions`;
        const noAuth = await fetch(base, { method: 'POST', body: '{}' });
        assertEquals(noAuth.status, 401);
        assertEquals((await noAuth.json()).error.type, 'authentication_error');

        const wrongMethod = await fetch(base, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
        assertEquals(wrongMethod.status, 405);
        await wrongMethod.body?.cancel();

        const badJson = await fetch(base, {
            method: 'POST',
            headers: { authorization: `Bearer ${CLIENT_KEY}` },
            body: 'not json',
        });
        assertEquals(badJson.status, 400);
        await badJson.body?.cancel();

        const tooBig = await fetch(base, {
            method: 'POST',
            headers: { authorization: `Bearer ${CLIENT_KEY}` },
            body: JSON.stringify({ x: 'y'.repeat(500) }),
        });
        assertEquals(tooBig.status, 413);
        await tooBig.body?.cancel();

        const preflight = await fetch(base, { method: 'OPTIONS', headers: { origin: 'https://chat.example' } });
        assertEquals(preflight.status, 204);
        assertStringIncludes(preflight.headers.get('access-control-allow-headers') ?? '', 'Authorization');
        await preflight.body?.cancel();
        assertEquals(env.mock.restCalls.length, 0);
        await env.close();
    },
});

Deno.test({
    name: 'openai: per-IP rate limit returns 429 with Retry-After',
    ...opts,
    async fn() {
        const env = setup({ RATE_LIMIT_PER_MINUTE: '2' });
        const call = () => fetch(`${env.app.origin}/v1/models`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
        for (let i = 0; i < 2; i++) await (await call()).body?.cancel();
        const limited = await call();
        assertEquals(limited.status, 429);
        assert(Number(limited.headers.get('retry-after')) > 0);
        await limited.body?.cancel();
        await env.close();
    },
});

Deno.test({
    name: 'openai: disallowed browser origins get 403',
    ...opts,
    async fn() {
        const env = setup({ ALLOWED_ORIGINS: 'https://friend.example' });
        const res = await fetch(`${env.app.origin}/v1/models`, {
            headers: { authorization: `Bearer ${CLIENT_KEY}`, origin: 'https://evil.example' },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();
        const ok = await fetch(`${env.app.origin}/v1/models`, {
            headers: { authorization: `Bearer ${CLIENT_KEY}`, origin: 'https://friend.example' },
        });
        assertEquals(ok.status, 200);
        assertEquals(ok.headers.get('access-control-allow-origin'), 'https://friend.example');
        await ok.body?.cancel();
        await env.close();
    },
});

// ---------------------------------------------------------------------------------------------
// Static files and misc endpoints
// ---------------------------------------------------------------------------------------------

Deno.test({
    name: 'static: UI is served with CSP; dotfiles, _headers and traversal are blocked',
    ...opts,
    async fn() {
        const env = setup();
        const index = await fetch(`${env.app.origin}/`);
        assertEquals(index.status, 200);
        assertStringIncludes(index.headers.get('content-security-policy') ?? '', "default-src 'self'");
        assertEquals(index.headers.get('cache-control'), 'no-cache');
        assertStringIncludes(await index.text(), '<script type="module" src="js/main.js">');

        const js = await fetch(`${env.app.origin}/js/shared/protocol.js`);
        assertEquals(js.status, 200);
        assertStringIncludes(js.headers.get('content-type') ?? '', 'javascript');
        await js.body?.cancel();

        for (const path of ['/.env', '/_headers', '/%2e%2e/deno.json', '/..%2fdeno.json', '/js/../../deno.json']) {
            const res = await fetch(`${env.app.origin}${path}`);
            assertEquals(res.status, 404, path);
            await res.body?.cancel();
        }
        const post = await fetch(`${env.app.origin}/index.html`, { method: 'POST' });
        assertEquals(post.status, 405);
        await post.body?.cancel();
        await env.close();
    },
});

Deno.test({
    name: 'misc: /api/config and /healthz',
    ...opts,
    async fn() {
        const env = setup({ GEMINI_API_KEY: SERVER_KEY, ACCESS_PASSWORD: PASSWORD });
        const config = await fetch(`${env.app.origin}/api/config`);
        assertEquals(await config.json(), { serverKeyAvailable: true, sessionRequired: true });
        const health = await fetch(`${env.app.origin}/healthz`);
        assertEquals(await health.text(), 'ok');
        await env.close();
    },
});
