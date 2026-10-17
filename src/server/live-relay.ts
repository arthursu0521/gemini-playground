/**
 * Relays one Gemini Live API session between a browser WebSocket and Google.
 *
 * Handshake: the client either puts `?key=` in the URL (legacy / third-party clients) or sends
 * `{"auth":{"apiKey"|"accessPassword": ...}}` as its first message. The relay consumes that
 * message, opens the upstream socket with the resolved key and then forwards frames verbatim.
 * Credentials never appear in logs.
 */
import { encodeCloseCode, RelayCloseCode, truncateCloseReason } from '../static/js/shared/protocol.js';
import type { AppConfig } from './config.ts';
import { type CredentialResult, resolveCredentials } from './credentials.ts';
import type { Logger } from './log.ts';

/** The subset of the WebSocket API that both Deno and Cloudflare Workers implement. */
export interface WebSocketLike {
    readonly readyState: number;
    binaryType?: string;
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    // Deno and Workers use different event classes; listeners narrow the type themselves.
    // deno-lint-ignore no-explicit-any
    addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export type UpstreamConnector = (url: string) => WebSocketLike;

const OPEN = 1;
const CONNECTING = 0;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export interface RelayOptions {
    client: WebSocketLike;
    /** Request path, already validated against LIVE_WS_PATH_PATTERN. */
    path: string;
    searchParams: URLSearchParams;
    config: AppConfig;
    connectUpstream: UpstreamConnector;
    logger: Logger;
    connectionId: string;
}

function byteLength(data: unknown): number {
    if (typeof data === 'string') return data.length * 2;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (data instanceof Blob) return data.size;
    return 0;
}

async function asText(data: unknown): Promise<string | null> {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    if (data instanceof Blob) return await data.text();
    return null;
}

/** Closes a socket, waiting for it to open first if needed (Deno server sockets start CONNECTING). */
export function closeSocket(socket: WebSocketLike, code: number, reason: string) {
    const safeReason = truncateCloseReason(reason);
    if (socket.readyState === CONNECTING) {
        socket.addEventListener('open', () => socket.close(code, safeReason));
        return;
    }
    if (socket.readyState === OPEN) socket.close(code, safeReason);
}

export function relayLiveSession(options: RelayOptions): void {
    const { client, path, searchParams, config, connectUpstream, logger, connectionId } = options;
    const startedAt = Date.now();
    let upstream: WebSocketLike | null = null;
    // auth: waiting for the first message · authenticating/connecting: queue client frames
    let state: 'auth' | 'authenticating' | 'connecting' | 'open' | 'closed' = 'auth';
    let queue: unknown[] = [];
    let queuedBytes = 0;
    let bytesUp = 0;
    let bytesDown = 0;
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number, reason: string, side: 'client' | 'upstream' | 'relay') => {
        if (state === 'closed') return;
        state = 'closed';
        clearTimeout(authTimer);
        queue = [];
        logger.info('live session closed', {
            id: connectionId,
            by: side,
            code,
            reason: reason || undefined,
            seconds: Math.round((Date.now() - startedAt) / 1000),
            bytesUp,
            bytesDown,
        });
    };

    const fail = (code: number, reason: string) => {
        finish(code, reason, 'relay');
        closeSocket(client, code, reason);
        if (upstream && (upstream.readyState === OPEN || upstream.readyState === CONNECTING)) {
            try {
                upstream.close(1000, 'client gone');
            } catch { /* already closing */ }
        }
    };

    const openUpstream = (credential: CredentialResult & { ok: true }, accessToken?: string) => {
        state = 'connecting';
        clearTimeout(authTimer);
        const target = new URL(path, config.upstreamBaseUrl.replace(/^http/, 'ws'));
        if (accessToken) target.searchParams.set('access_token', accessToken);
        else target.searchParams.set('key', credential.apiKey);

        logger.info('live session upstream connecting', { id: connectionId, keySource: credential.source });
        let socket: WebSocketLike;
        try {
            socket = connectUpstream(target.toString());
        } catch (error) {
            logger.error('live session upstream connect threw', { id: connectionId, error });
            fail(RelayCloseCode.UPSTREAM_UNAVAILABLE, 'Failed to connect to Gemini');
            return;
        }
        upstream = socket;
        socket.binaryType = 'arraybuffer';

        socket.addEventListener('open', () => {
            if (state !== 'connecting') {
                socket.close(1000, 'client gone');
                return;
            }
            state = 'open';
            for (const message of queue) socket.send(message as string);
            queue = [];
            queuedBytes = 0;
            logger.debug('live session upstream open', { id: connectionId });
        });

        socket.addEventListener('message', (event: MessageEvent) => {
            bytesDown += byteLength(event.data);
            if (client.readyState === OPEN) client.send(event.data);
        });

        socket.addEventListener('close', (event: CloseEvent) => {
            const wasOpen = state === 'open';
            finish(event.code, event.reason, 'upstream');
            if (client.readyState === OPEN) {
                // A handshake failure shows up as 1006 (or 0 in Deno) before 'open' ever fired.
                const handshakeFailed = !wasOpen && (event.code < 1000 || event.code === 1006);
                const code = handshakeFailed ? RelayCloseCode.UPSTREAM_UNAVAILABLE : encodeCloseCode(event.code);
                const reason = event.reason || (wasOpen ? '' : 'Could not reach Gemini');
                client.close(code, truncateCloseReason(reason));
            }
        });

        socket.addEventListener('error', () => {
            logger.warn('live session upstream error', { id: connectionId, state });
        });
    };

    const authenticate = async (presented: { apiKey?: unknown; accessPassword?: unknown }) => {
        state = 'authenticating';
        clearTimeout(authTimer);
        const credential = await resolveCredentials(presented, config);
        if (state !== 'authenticating') return; // closed meanwhile
        if (!credential.ok) {
            logger.warn('live session rejected', { id: connectionId, reason: credential.reason });
            fail(RelayCloseCode.UNAUTHORIZED, credential.reason);
            return;
        }
        openUpstream(credential);
    };

    client.addEventListener('message', async (event: MessageEvent) => {
        const data = event.data;
        bytesUp += byteLength(data);
        if (state === 'open' && upstream) {
            upstream.send(data);
            return;
        }
        if (state === 'connecting' || state === 'authenticating') {
            queuedBytes += byteLength(data);
            if (queuedBytes > MAX_QUEUED_BYTES) {
                fail(RelayCloseCode.QUEUE_OVERFLOW, 'Too much data before Gemini connected');
                return;
            }
            queue.push(data);
            return;
        }
        if (state !== 'auth') return;

        // First message must be the auth envelope. Later frames queue while we check it.
        state = 'authenticating';
        clearTimeout(authTimer);
        const text = await asText(data);
        let parsed: unknown;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = null;
        }
        if (state !== 'authenticating') return;
        const auth = (parsed as { auth?: unknown } | null)?.auth;
        if (!auth || typeof auth !== 'object') {
            fail(RelayCloseCode.UNAUTHORIZED, 'Missing API key: send {"auth":{...}} first or use ?key=');
            return;
        }
        await authenticate(auth as Record<string, unknown>);
    });

    client.addEventListener('close', (event: CloseEvent) => {
        finish(event.code, event.reason, 'client');
        if (upstream && (upstream.readyState === OPEN || upstream.readyState === CONNECTING)) {
            try {
                upstream.close(1000, 'client closed');
            } catch { /* ignore */ }
        }
    });

    client.addEventListener('error', () => {
        logger.debug('live session client error', { id: connectionId });
    });

    // Credentials in the URL (legacy clients, ephemeral tokens) skip the auth message.
    const urlKey = searchParams.get('key');
    const accessToken = searchParams.get('access_token');
    if (accessToken) {
        openUpstream({ ok: true, apiKey: '', source: 'client' }, accessToken);
    } else if (urlKey) {
        void authenticate({ apiKey: urlKey });
    } else {
        authTimer = setTimeout(() => {
            if (state === 'auth') fail(RelayCloseCode.AUTH_TIMEOUT, 'No credentials received');
        }, config.authTimeoutMs);
    }
}
