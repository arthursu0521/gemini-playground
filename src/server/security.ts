/** Security helpers: constant-time comparison, origin checks, response headers. */
import type { AppConfig } from './config.ts';

const encoder = new TextEncoder();

/**
 * Compares two secrets without leaking where they differ. Both sides are hashed first so
 * the comparison time does not depend on the length of the guess either.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(a)),
        crypto.subtle.digest('SHA-256', encoder.encode(b)),
    ]);
    const va = new Uint8Array(ha);
    const vb = new Uint8Array(hb);
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
    return diff === 0;
}

/**
 * Browsers always send `Origin` on WebSocket handshakes and cross-origin fetches, so checking it
 * blocks other websites from driving this relay (cross-site WebSocket hijacking). Requests
 * without an Origin come from non-browser clients (curl, SDKs) and are allowed.
 */
export function isOriginAllowed(origin: string | null, requestUrl: URL, config: AppConfig): boolean {
    if (!origin) return true;
    if (origin === requestUrl.origin) return true;
    if (config.allowedOrigins.length === 0) return true;
    return config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin);
}

/** CORS headers for the OpenAI-compatible API. */
export function corsHeaders(origin: string | null, config: AppConfig): Headers {
    const headers = new Headers();
    if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes('*')) {
        headers.set('Access-Control-Allow-Origin', '*');
    } else if (origin && config.allowedOrigins.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
    }
    return headers;
}

export function preflightHeaders(origin: string | null, config: AppConfig): Headers {
    const headers = corsHeaders(origin, config);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-goog-api-key, api-key');
    headers.set('Access-Control-Max-Age', '86400');
    return headers;
}

/** Content-Security-Policy for the web UI. Everything is first-party; no CDNs, no inline code. */
export function contentSecurityPolicy(requestUrl: URL): string {
    const wsOrigin = `${requestUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${requestUrl.host}`;
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: mediastream:",
        `connect-src 'self' ${wsOrigin}`,
        "worker-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; ');
}

/** Adds hardening headers to a response (returns a new Response when headers are immutable). */
export function withSecurityHeaders(response: Response, requestUrl: URL): Response {
    let res = response;
    try {
        res.headers.set('X-Content-Type-Options', 'nosniff');
    } catch {
        // Headers of fetch() responses are immutable; copy the response.
        res = new Response(response.body, response);
        res.headers.set('X-Content-Type-Options', 'nosniff');
    }
    const h = res.headers;
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Frame-Options', 'DENY');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    if (requestUrl.protocol === 'https:') {
        h.set('Strict-Transport-Security', 'max-age=31536000');
    }
    const type = h.get('content-type') ?? '';
    if (type.startsWith('text/html')) {
        h.set('Content-Security-Policy', contentSecurityPolicy(requestUrl));
    }
    return res;
}
