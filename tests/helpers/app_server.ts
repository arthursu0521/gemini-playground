/** Starts the real Deno app on a random port, pointed at a mock upstream, with captured logs. */
import { createDenoHandler } from '../../src/deno_index.ts';
import { createLogger } from '../../src/server/log.ts';

export interface AppServer {
    origin: string;
    wsOrigin: string;
    logs: string[];
    close(): Promise<void>;
}

export function startAppServer(vars: Record<string, string>): AppServer {
    const logs: string[] = [];
    const sink = {
        log: (l: string) => logs.push(l),
        warn: (l: string) => logs.push(l),
        error: (l: string) => logs.push(l),
    };
    const env = (name: string) => vars[name];
    const logger = createLogger('debug', [vars.GEMINI_API_KEY ?? '', vars.ACCESS_PASSWORD ?? ''], sink);
    const handler = createDenoHandler(env, { logger });
    const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler);
    const { port } = server.addr as Deno.NetAddr;
    return {
        origin: `http://127.0.0.1:${port}`,
        wsOrigin: `ws://127.0.0.1:${port}`,
        logs,
        close: () => server.shutdown(),
    };
}
