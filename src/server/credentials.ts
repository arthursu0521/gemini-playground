/** Turns what a client presents (its own key, or the access password) into a Gemini API key. */
import type { AppConfig } from './config.ts';
import { timingSafeEqual } from './security.ts';

export type CredentialResult = { ok: true; apiKey: string; source: 'client' | 'server' } | {
    ok: false;
    reason: string;
};

/** Gemini keys are URL-safe tokens; anything else is rejected before it reaches a URL or header. */
const API_KEY_PATTERN = /^[A-Za-z0-9_\-.]{16,256}$/;

export async function resolveCredentials(
    presented: { apiKey?: unknown; accessPassword?: unknown },
    config: AppConfig,
): Promise<CredentialResult> {
    const apiKey = typeof presented.apiKey === 'string' ? presented.apiKey.trim() : '';
    const password = typeof presented.accessPassword === 'string' ? presented.accessPassword : '';

    // The access password may be typed into either field.
    const candidate = password || apiKey;
    if (config.serverKeyEnabled && candidate && await timingSafeEqual(candidate, config.accessPassword)) {
        return { ok: true, apiKey: config.geminiApiKey, source: 'server' };
    }
    if (password && !apiKey) {
        return {
            ok: false,
            reason: config.serverKeyEnabled ? 'Invalid access password' : 'Access password login is not enabled',
        };
    }
    if (!apiKey) return { ok: false, reason: 'Missing API key' };
    if (!API_KEY_PATTERN.test(apiKey)) return { ok: false, reason: 'Malformed API key' };
    return { ok: true, apiKey, source: 'client' };
}

/** Extracts a bearer token / key from an OpenAI-style request. */
export function tokenFromHeaders(headers: Headers): string {
    const auth = headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
    return (headers.get('x-goog-api-key') ?? headers.get('api-key') ?? '').trim();
}
