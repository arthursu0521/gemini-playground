// @ts-check
/**
 * @fileoverview Binary helpers used on hot paths (audio every 100 ms, video frames).
 */

const CHUNK = 0x8000;

/**
 * Encodes bytes as base64 without building a giant intermediate string char by char.
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {string}
 */
export function arrayBufferToBase64(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    /** @type {any} */
    const native = bytes;
    if (typeof native.toBase64 === 'function') return native.toBase64();
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(base64) {
    /** @type {any} */
    const U8 = Uint8Array;
    if (typeof U8.fromBase64 === 'function') return U8.fromBase64(base64).buffer;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * Converts little-endian PCM16 to Float32 samples in [-1, 1).
 * @param {ArrayBuffer} buffer
 * @returns {Float32Array}
 */
export function pcm16ToFloat32(buffer) {
    const view = new DataView(buffer);
    const count = Math.floor(buffer.byteLength / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
    return out;
}

/**
 * Decodes a WebSocket message payload (string, ArrayBuffer or Blob) into text.
 * @param {unknown} data
 * @returns {Promise<string>}
 */
export async function messageToText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return await data.text();
    throw new TypeError('Unsupported message payload');
}

/**
 * Clamps a number into [min, max], falling back for NaN.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
