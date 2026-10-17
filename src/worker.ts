/**
 * Cloudflare Workers entry point. Static files are served by Workers Static Assets before the
 * Worker runs (security headers for them come from `src/static/_headers`); everything else -
 * Live WebSockets, the OpenAI-compatible API, /api/config - is handled by the shared app.
 */
import { type App, createApp, type Platform } from './server/app.ts';
import { loadConfig } from './server/config.ts';
import type { WebSocketLike } from './server/live-relay.ts';

interface CloudflareWebSocket extends WebSocketLike {
    accept(): void;
}

declare const WebSocketPair: { new (): { 0: CloudflareWebSocket; 1: CloudflareWebSocket } };

export interface Env {
    ASSETS?: { fetch(req: Request): Promise<Response> };
    [name: string]: unknown;
}

export function createCloudflarePlatform(env: Env): Platform {
    return {
        async serveStatic(req) {
            if (!env.ASSETS) return new Response('Not Found', { status: 404 });
            return await env.ASSETS.fetch(req);
        },
        upgradeWebSocket() {
            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            server.accept();
            const response = new Response(null, { status: 101, webSocket: client } as ResponseInit);
            return { socket: server, response };
        },
        connectUpstream: (url) => new WebSocket(url) as unknown as WebSocketLike,
        fetch: (input, init) => fetch(input, init),
    };
}

let cached: { env: Env; app: App } | null = null;

function appFor(env: Env): App {
    if (cached?.env !== env) {
        const read = (name: string) => (typeof env[name] === 'string' ? (env[name] as string) : undefined);
        cached = { env, app: createApp(loadConfig(read), createCloudflarePlatform(env)) };
    }
    return cached.app;
}

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        const clientIp = request.headers.get('cf-connecting-ip') ?? '';
        return appFor(env).handle(request, { clientIp });
    },
};
