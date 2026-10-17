// @ts-check
/**
 * @fileoverview Wire protocol shared by the browser client and the relay server.
 * Imported by both sides so the close codes and the auth handshake cannot drift apart.
 */

/** WebSocket path of the Gemini Live API (v1beta). The relay forwards it verbatim to Google. */
export const LIVE_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Paths the relay accepts for Live sessions. Anything else is rejected with 404. */
export const LIVE_WS_PATH_PATTERN =
    /^\/ws\/google\.ai\.generativelanguage\.(v1alpha|v1beta)\.GenerativeService\.(BidiGenerateContent|BidiGenerateContentConstrained)$/;

/**
 * The first client message on a Live socket when no `?key=` is in the URL.
 * It is consumed by the relay and never forwarded to Google.
 * @typedef {{ auth: { apiKey?: string, accessPassword?: string } }} AuthMessage
 */

/** Close codes the relay itself sends (4400-4599, private-use range). */
export const RelayCloseCode = Object.freeze({
    BAD_REQUEST: 4400,
    UNAUTHORIZED: 4401,
    AUTH_TIMEOUT: 4408,
    QUEUE_OVERFLOW: 4413,
    RATE_LIMITED: 4429,
    UPSTREAM_UNAVAILABLE: 4502,
});

/** Close codes the upstream may send that are fatal: reconnecting cannot help. */
const FATAL_UPSTREAM_CODES = new Set([1007, 1008]);

/**
 * Browsers only let a script close a socket with 1000 or 3000-4999, so the relay cannot
 * forward Google's 1007/1008/1011 as is. It maps 1001-1015 into 4001-4015 and the client
 * maps them back with {@link decodeCloseCode}.
 * @param {number} code
 * @returns {number}
 */
export function encodeCloseCode(code) {
    if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
    if (code === 1005) return 1000; // "no status received": treat as a normal close
    if (code >= 1001 && code <= 1015) return 4000 + (code - 1000);
    return 4006; // abnormal / unknown
}

/**
 * @param {number} code
 * @returns {number}
 */
export function decodeCloseCode(code) {
    if (code >= 4001 && code <= 4015) return code - 3000;
    return code;
}

/**
 * Whether a (decoded) close code means "do not retry": bad credentials, policy violations,
 * invalid setup, rate limiting, or the relay refusing the request.
 * @param {number} code
 */
export function isFatalCloseCode(code) {
    const decoded = decodeCloseCode(code);
    return FATAL_UPSTREAM_CODES.has(decoded) || (decoded >= 4400 && decoded < 4500);
}

/**
 * Close reasons are limited to 123 bytes of UTF-8. Truncates on a character boundary.
 * @param {string} reason
 * @param {number} [maxBytes=123]
 * @returns {string}
 */
export function truncateCloseReason(reason, maxBytes = 123) {
    const encoder = new TextEncoder();
    if (encoder.encode(reason).length <= maxBytes) return reason;
    let out = '';
    let size = 0;
    for (const char of reason) {
        const charSize = encoder.encode(char).length;
        if (size + charSize > maxBytes - 3) break;
        out += char;
        size += charSize;
    }
    return out + '...';
}
