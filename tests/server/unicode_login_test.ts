import { assertEquals } from '@std/assert';
import { createApp, type Platform } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { SessionAuth } from '../../src/server/session.ts';

Deno.test('login preserves Unicode password split inside UTF-8 character', async () => {
    const kv = await Deno.openKv(':memory:');
    const password = '分块密码-strong-password';
    const platform = {
        sessions: new SessionAuth({ kv: () => Promise.resolve(kv), password }),
        serveStatic: () => Promise.resolve(new Response('static')),
        upgradeWebSocket: () => {
            throw new Error('unexpected upgrade');
        },
        connectUpstream: () => {
            throw new Error('unexpected upstream');
        },
        fetch: () => Promise.resolve(new Response('{}')),
    } satisfies Platform;
    const config = loadConfig((name) => ({ ACCESS_PASSWORD: password })[name]);
    const app = createApp(config, platform);
    const bytes = new TextEncoder().encode(JSON.stringify({ password }));
    const split = bytes.findIndex((v) => v > 127) + 1;
    try {
        const response = await app.handle(
            new Request('https://gemini.spdt.work/auth/login', {
                method: 'POST',
                headers: { origin: 'https://gemini.spdt.work', 'content-type': 'application/json' },
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(bytes.slice(0, split));
                        controller.enqueue(bytes.slice(split));
                        controller.close();
                    },
                }),
            }),
            { clientIp: 'unicode-test' },
        );
        assertEquals(response.status, 200);
    } finally {
        kv.close();
    }
});
