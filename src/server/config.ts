/**
 * Runtime configuration, read from environment variables (Deno) or bindings (Cloudflare).
 * See `.env.example` for documentation of every variable.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
    /** Server-side Gemini key. Only usable together with a valid access password. */
    geminiApiKey: string;
    accessPassword: string;
    /** True when the server key may be used (key + strong enough password configured). */
    serverKeyEnabled: boolean;
    /** Allowed browser origins; empty means any origin. Same-origin is always allowed. */
    allowedOrigins: string[];
    rateLimitPerMinute: number;
    wsConnectionsPerMinute: number;
    trustProxyHeaders: boolean;
    /** Base URL of the Gemini API, e.g. https://generativelanguage.googleapis.com */
    upstreamBaseUrl: string;
    defaultChatModel: string;
    defaultEmbeddingModel: string;
    logLevel: LogLevel;
    /** How long a Live socket may stay open without sending credentials. */
    authTimeoutMs: number;
    /** Upper bound for an OpenAI-compatible request body. */
    maxRequestBodyBytes: number;
    /** Warnings produced while parsing; logged once at startup. */
    warnings: string[];
}

export const MIN_ACCESS_PASSWORD_LENGTH = 12;
const DEFAULT_UPSTREAM = 'https://generativelanguage.googleapis.com';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export type EnvReader = (name: string) => string | undefined;

function readInt(get: EnvReader, name: string, fallback: number, warnings: string[]): number {
    const raw = get(name)?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        warnings.push(`${name}="${raw}" is not a non-negative integer; using ${fallback}`);
        return fallback;
    }
    return value;
}

function readBool(get: EnvReader, name: string): boolean {
    return ['1', 'true', 'yes', 'on'].includes((get(name) ?? '').trim().toLowerCase());
}

function normaliseOrigin(value: string, warnings: string[]): string | null {
    if (value === '*') return '*';
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol');
        return url.origin;
    } catch {
        warnings.push(`ALLOWED_ORIGINS entry "${value}" is not a valid origin and was ignored`);
        return null;
    }
}

function readUpstream(get: EnvReader, warnings: string[]): string {
    const raw = get('UPSTREAM_BASE_URL')?.trim();
    if (!raw) return DEFAULT_UPSTREAM;
    try {
        const url = new URL(raw);
        const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        // Plain http is only acceptable for local test doubles; keys must never travel unencrypted.
        if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal)) {
            return url.origin;
        }
        warnings.push(`UPSTREAM_BASE_URL must be https (http only for localhost); using ${DEFAULT_UPSTREAM}`);
    } catch {
        warnings.push(`UPSTREAM_BASE_URL="${raw}" is not a URL; using ${DEFAULT_UPSTREAM}`);
    }
    return DEFAULT_UPSTREAM;
}

export function loadConfig(get: EnvReader): AppConfig {
    const warnings: string[] = [];
    const geminiApiKey = (get('GEMINI_API_KEY') ?? '').trim();
    const accessPassword = (get('ACCESS_PASSWORD') ?? '').trim();

    let serverKeyEnabled = false;
    if (geminiApiKey && !accessPassword) {
        warnings.push('GEMINI_API_KEY is set but ACCESS_PASSWORD is empty: the server key is disabled');
    } else if (geminiApiKey && accessPassword.length < MIN_ACCESS_PASSWORD_LENGTH) {
        warnings.push(
            `ACCESS_PASSWORD is shorter than ${MIN_ACCESS_PASSWORD_LENGTH} characters: the server key is disabled`,
        );
    } else if (geminiApiKey) {
        serverKeyEnabled = true;
    }

    const allowedOrigins = (get('ALLOWED_ORIGINS') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => normaliseOrigin(s, warnings))
        .filter((s): s is string => s !== null);

    const rawLevel = (get('LOG_LEVEL') ?? 'info').trim().toLowerCase() as LogLevel;
    const logLevel = LOG_LEVELS.includes(rawLevel) ? rawLevel : 'info';
    if (logLevel !== rawLevel) warnings.push(`LOG_LEVEL="${rawLevel}" is unknown; using info`);

    return {
        geminiApiKey,
        accessPassword,
        serverKeyEnabled,
        allowedOrigins,
        rateLimitPerMinute: readInt(get, 'RATE_LIMIT_PER_MINUTE', 60, warnings),
        wsConnectionsPerMinute: readInt(get, 'WS_CONNECTIONS_PER_MINUTE', 10, warnings),
        trustProxyHeaders: readBool(get, 'TRUST_PROXY_HEADERS'),
        upstreamBaseUrl: readUpstream(get, warnings),
        defaultChatModel: (get('DEFAULT_CHAT_MODEL') ?? '').trim() || 'gemini-3.8-flash',
        defaultEmbeddingModel: (get('DEFAULT_EMBEDDING_MODEL') ?? '').trim() || 'gemini-embedding-001',
        logLevel,
        authTimeoutMs: readInt(get, 'AUTH_TIMEOUT_MS', 10_000, warnings),
        maxRequestBodyBytes: readInt(get, 'MAX_REQUEST_BODY_BYTES', 25 * 1024 * 1024, warnings),
        warnings,
    };
}

/** Public, non-secret facts the browser UI needs. Never include keys or passwords here. */
export function publicConfig(config: AppConfig) {
    return {
        serverKeyAvailable: config.serverKeyEnabled,
    };
}
