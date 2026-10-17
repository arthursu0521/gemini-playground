/**
 * Deno entry point (local `deno task start` and Deno Deploy).
 *
 * Local runs read `.env` from the project root if it exists. On Deno Deploy the file is never
 * read: configure variables (as secrets) in the Deno Deploy console instead.
 */
import { load } from '@std/dotenv';
import { serveDir } from '@std/http/file-server';
import { fromFileUrl } from '@std/path';
import { createApp, type Platform } from './server/app.ts';
import { loadConfig } from './server/config.ts';
import type { Logger } from './server/log.ts';

const STATIC_ROOT = fromFileUrl(new URL('./static', import.meta.url));
const ENV_FILE = fromFileUrl(new URL('../.env', import.meta.url));

export function createDenoPlatform(staticRoot = STATIC_ROOT): Platform {
    return {
        async serveStatic(req) {
            const res = await serveDir(req, { fsRoot: staticRoot, quiet: true, showDotfiles: false });
            // No cache-busting file names, so let browsers revalidate (ETag makes that cheap).
            if (res.status === 200 || res.status === 304) res.headers.set('cache-control', 'no-cache');
            return res;
        },
        upgradeWebSocket(req) {
            const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 120 });
            return { socket, response };
        },
        connectUpstream: (url) => new WebSocket(url),
        fetch: (input, init) => fetch(input, init),
    };
}

export function createDenoHandler(
    env: (name: string) => string | undefined = (n) => Deno.env.get(n),
    options: { logger?: Logger } = {},
) {
    const app = createApp(loadConfig(env), createDenoPlatform(), options.logger);
    return (req: Request, info: Deno.ServeHandlerInfo<Deno.NetAddr>) => {
        let clientIp = info.remoteAddr.hostname;
        if (env('TRUST_PROXY_HEADERS') === 'true') {
            clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || clientIp;
        }
        return app.handle(req, { clientIp });
    };
}

async function loadLocalEnv() {
    if (Deno.env.get('DENO_DEPLOY')) return;
    try {
        // export: true copies values into Deno.env without overriding variables already set.
        await load({ envPath: ENV_FILE, export: true });
    } catch (error) {
        console.warn(`WARN could not read .env: ${error instanceof Error ? error.message : error}`);
    }
}

if (import.meta.main) {
    await loadLocalEnv();
    const onListen = ({ hostname, port }: Deno.NetAddr) => console.log(`INFO listening on http://${hostname}:${port}`);
    if (Deno.env.get('DENO_DEPLOY')) {
        // The platform decides where to listen; never bind a port copied over from a local .env.
        Deno.serve(createDenoHandler());
    } else {
        Deno.serve({ port: Number(Deno.env.get('PORT') || 8000), onListen }, createDenoHandler());
    }
}
