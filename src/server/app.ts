/**
 * Platform-independent request router. The Deno and Cloudflare entry points only provide a
 * {@link Platform} (static files + WebSocket primitives) and the configuration.
 */
import { LIVE_WS_PATH_PATTERN, RelayCloseCode } from '../static/js/shared/protocol.js';
import { type AppConfig, publicConfig } from './config.ts';
import { createLogger, type Logger } from './log.ts';
import { closeSocket, relayLiveSession, type UpstreamConnector, type WebSocketLike } from './live-relay.ts';
import { handleOpenAI, matchOpenAIPath } from './openai.ts';
import { COOKIE, SESSION_MS, type SessionAuth } from './session.ts';
import { RateLimiter } from './rate-limit.ts';
import { corsHeaders, isOriginAllowed, withSecurityHeaders } from './security.ts';

export interface Platform {
    sessions?: SessionAuth;
    /** Test-only timer injection; production checks every 15 seconds. */
    sessionCheckMs?: number;
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
    return new Response(text, {
        status,
        headers: { 'content-type': 'text/plain;charset=UTF-8', 'cache-control': 'no-store' },
    });
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

    const protectedMode = !!(config.accessPassword || config.accessPasswordHash);
    const sockets = new Map<string, Set<WebSocketLike>>();
    function exactOrigin(req: Request, url: URL) {
        const origin = req.headers.get('origin');
        const allowed = config.allowedOrigins.length ? config.allowedOrigins : [url.origin];
        return (!protectedMode || url.protocol === 'https:') && !!origin && allowed.includes(origin);
    }
    function tokenFor(req: Request) {
        const matches = (req.headers.get('cookie') ?? '').split(';').map((v) => v.trim()).filter((v) =>
            v.startsWith(COOKIE + '=')
        );
        return matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : '';
    }
    async function authorized(req: Request) {
        return !!platform.sessions && await platform.sessions.validate(tokenFor(req));
    }
    async function handleLive(req: Request, url: URL, ctx: RequestContext): Promise<Response> {
        if (!LIVE_WS_PATH_PATTERN.test(url.pathname)) return plain(404, 'Unknown WebSocket endpoint');
        if (!exactOrigin(req, url)) {
            log.warn('live session origin rejected', { origin: req.headers.get('origin') ?? '' });
            return plain(403, 'Origin not allowed');
        }
        if (protectedMode && !await authorized(req)) return plain(platform.sessions ? 401 : 503, 'Session required');
        const sessionToken = tokenFor(req);
        const { socket, response } = platform.upgradeWebSocket(req);
        if (protectedMode) {
            const token = sessionToken;
            const related = sockets.get(token) ?? new Set<WebSocketLike>();
            related.add(socket);
            sockets.set(token, related);
            let checking = false;
            const timer = setInterval(async () => {
                if (checking) return;
                checking = true;
                try {
                    if (!await platform.sessions!.validate(token)) {
                        closeSocket(socket, RelayCloseCode.UNAUTHORIZED, 'Session expired or revoked');
                    }
                } finally {
                    checking = false;
                }
            }, platform.sessionCheckMs ?? 15000);
            socket.addEventListener('close', () => {
                clearInterval(timer);
                related.delete(socket);
                if (!related.size) sockets.delete(token);
            });
        }
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
            authenticated: protectedMode,
        });
        return response;
    }

    async function route(req: Request, url: URL, ctx: RequestContext): Promise<Response> {
        if (url.pathname.startsWith('/auth/')) {
            if (url.protocol !== 'https:') return plain(403, 'HTTPS required');
            if (url.pathname === '/auth/session' && req.method === 'GET') {
                const valid = await authorized(req);
                return json({ authenticated: valid }, { status: valid ? 200 : 401 });
            }
            if (!exactOrigin(req, url)) return plain(403, 'Origin not allowed');
            if (req.method !== 'POST') return plain(405, 'Method Not Allowed');
            if (!protectedMode || !platform.sessions) return plain(503, 'Sessions unavailable');
            if (url.pathname === '/auth/login') {
                if (!req.headers.get('content-type')?.startsWith('application/json')) {
                    return plain(415, 'JSON required');
                }
                let raw = '';
                let byteLength = 0;
                const decoder = new TextDecoder();
                const reader = req.body?.getReader();
                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        byteLength += value.byteLength;
                        if (byteLength > 4096) {
                            await reader.cancel();
                            return plain(413, 'Body too large');
                        }
                        raw += decoder.decode(value, { stream: true });
                    }
                    raw += decoder.decode();
                }
                let password: unknown;
                try {
                    password = JSON.parse(raw).password;
                } catch {
                    return plain(400, 'Invalid JSON');
                }
                if (typeof password !== 'string' || password.length > 1024) return plain(400, 'Invalid password');
                let token: string | null;
                try {
                    token = await platform.sessions.login(password, ctx.clientIp);
                } catch (e) {
                    return plain(
                        e instanceof Error && e.message === 'Login throttled' ? 429 : 503,
                        'Login unavailable',
                    );
                }
                if (!token) return plain(401, 'Invalid password');
                const previous = tokenFor(req);
                if (previous) await platform.sessions.revoke(previous);
                return json(
                    { authenticated: true },
                    {},
                    new Headers({
                        'set-cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${
                            SESSION_MS / 1000
                        }`,
                    }),
                );
            }
            if (url.pathname === '/auth/logout') {
                const token = tokenFor(req);
                try {
                    if (token) await platform.sessions.revoke(token);
                } catch {
                    return plain(503, 'Logout unavailable');
                }
                for (const socket of sockets.get(token) ?? []) {
                    closeSocket(socket, RelayCloseCode.UNAUTHORIZED, 'Logged out');
                }
                return json(
                    { authenticated: false },
                    {},
                    new Headers({ 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` }),
                );
            }
            return plain(404, 'Not Found');
        }
        const openaiPath = matchOpenAIPath(url.pathname);
        if (openaiPath !== null) {
            if (protectedMode && !await authorized(req)) {
                return plain(platform.sessions ? 401 : 503, 'Session required');
            }
            if (protectedMode && req.headers.has('origin') && !exactOrigin(req, url)) {
                return plain(403, 'Origin not allowed');
            }
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
                    return await handleLive(req, url, ctx);
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
