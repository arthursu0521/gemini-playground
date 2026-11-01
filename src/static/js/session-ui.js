// @ts-check
/** Probe before connecting and after any socket close: browser WS hides HTTP 401 handshakes. */
/** @param {boolean} required @param {() => void} showLogin @param {typeof fetch} fetcher */
export async function ensureSession(required, showLogin, fetcher = globalThis.fetch) {
    if (!required) return true;
    try {
        const response = await fetcher('/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (response.ok) return true;
    } catch { /* fail closed */ }
    showLogin();
    return false;
}
