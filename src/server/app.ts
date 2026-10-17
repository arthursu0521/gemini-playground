/**
 * Platform-independent request router. The Deno and Cloudflare entry points only provide a
 * {@link Platform} (static files + WebSocket primitives) and the configuration.
 */
import { LIVE_WS_PATH_PATTERN, RelayCloseCode } from '../static/js/shared/protocol.js';
import { type AppConfig, publicConfig } from './config.ts';
import { createLogger, type Logger } from './log.ts';
import { closeSocket, relayLiveSession, type UpstreamConnector, type WebSocketLike } from './live-relay.ts';
import { handleOpenAI, matchOpenAIPath } from './openai.ts';
import { RateLimiter } from './rate-limit.ts';
import { corsHeaders, isOriginAllowed, withSecurityHeaders } from './security.ts';

export interface Platform {
    /** Serves a file from the static directory, or returns a 404 response. */
    serveStatic(req: Request): Promise<Response>;
    /** Accepts a WebSocket upgrade. */
    upgradeWebSocket(req: Request): { socket: WebSocketLike; response: Response };
    /** Opens an outbound WebSocket to the Gemini API. */
    connectUpstream: UpstreamConnector;
    fetch: typeof fetch;
}

export interface RequestContext {
    /** Client IP as seen by the platform ('' when unknown). */
    clientIp: string;
}

export interface App {
    handle(req: Request, ctx: RequestContext): Promise<Response>;
    logger: Logger;
}

function json(data: unknown, init: ResponseInit = {}, extra?: Headers): Response {
    const headers = extra ?? new Headers();
    headers.set('content-type', 'application/json');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify(data), { ...init, headers });
}

function plain(status: number, text: string): Response {
    return new Response(text, { status, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
}

/** Files that exist in the static directory for other platforms and must not be served. */
function isHiddenPath(pathname: string): boolean {
    return pathname.split('/').some((segment) => segment.startsWith('.') || segment.startsWith('_'));
}

let connectionCounter = 0;

export function createApp(config: AppConfig, platform: Platform, logger?: Logger): App {
    const log = logger ?? createLogger(config.logLevel, [config.geminiApiKey, config.accessPassword]);
    for (const warning of config.warnings) log.warn(warning);
    if (config.serverKeyEnabled) log.info('server-side Gemini key enabled (access password required)');

    const apiLimiter = new RateLimiter(config.rateLimitPerMinute);
    const wsLimiter = new RateLimiter(config.wsConnectionsPerMinute);

    function handleLive(req: Request, url: URL, ctx: RequestContext): Response {
        if (!LIVE_WS_PATH_PATTERN.test(url.pathname)) return plain(404, 'Unknown WebSocket endpoint');
        if (!isOriginAllowed(req.headers.get('origin'), url, config)) {
            log.warn('live session origin rejected', { origin: req.headers.get('origin') ?? '' });
            return plain(403, 'Origin not allowed');
        }
        const { socket, response } = platform.upgradeWebSocket(req);
        const id = `ws${++connectionCounter}`;
        const limit = wsLimiter.take(ctx.clientIp || 'unknown');
        if (!limit.allowed) {
            log.warn('live session rate limited', { id, retryAfter: limit.retryAfterSeconds });
            closeSocket(
                socket,
                RelayCloseCode.RATE_LIMITED,
                `Too many sessions, retry in ${limit.retryAfterSeconds}s`,
            );
            return response;
        }
        log.info('live session opened', { id, path: url.pathname });
        relayLiveSession({
            client: socket,
            path: url.pathname,
            searchParams: url.searchParams,
            config,
            connectUpstream: platform.connectUpstream,
            logger: log,
            connectionId: id,
        });
        return response;
    }

    async function route(req: Request, url: URL, ctx: RequestContext): Promise<Response> {
        const openaiPath = matchOpenAIPath(url.pathname);
        if (openaiPath !== null) {
            const origin = req.headers.get('origin');
            if (!isOriginAllowed(origin, url, config)) {
                return json({ error: { message: 'Origin not allowed', type: 'permission_error' } }, { status: 403 });
            }
            if (req.method !== 'OPTIONS') {
                const limit = apiLimiter.take(ctx.clientIp || 'unknown');
                if (!limit.allowed) {
                    const headers = corsHeaders(origin, config);
                    headers.set('retry-after', String(limit.retryAfterSeconds));
                    return json(
                        { error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 429 } },
                        { status: 429 },
                        headers,
                    );
                }
            }
            return await handleOpenAI(req, openaiPath, { config, logger: log, fetch: platform.fetch });
        }

        if (url.pathname === '/api/config') {
            if (req.method !== 'GET') return plain(405, 'Method Not Allowed');
            return json(publicConfig(config));
        }
        if (url.pathname === '/healthz') return plain(200, 'ok');

        if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method Not Allowed');
        if (isHiddenPath(url.pathname)) return plain(404, 'Not Found');
        return await platform.serveStatic(req);
    }

    return {
        logger: log,
        async handle(req, ctx) {
            const url = new URL(req.url);
            if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                try {
                    return handleLive(req, url, ctx);
                } catch (error) {
                    log.error('websocket upgrade failed', { error });
                    return plain(400, 'WebSocket upgrade failed');
                }
            }
            let response: Response;
            try {
                response = await route(req, url, ctx);
            } catch (error) {
                log.error('request failed', { method: req.method, path: url.pathname, error });
                response = plain(500, 'Internal Server Error');
            }
            log.debug('request', { method: req.method, path: url.pathname, status: response.status });
            return withSecurityHeaders(response, url);
        },
    };
}
