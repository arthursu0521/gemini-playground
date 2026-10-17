/**
 * Minimal leveled logger that redacts credentials before anything reaches the platform logs.
 * Request URLs can carry `?key=`, headers can carry `Bearer` tokens, and error messages from
 * Google sometimes echo the key back, so every line goes through {@link redact}.
 */
import type { LogLevel } from './config.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const PATTERNS: Array<[RegExp, string]> = [
    // Google API keys
    [/AIza[0-9A-Za-z_\-]{20,}/g, '[REDACTED_KEY]'],
    // key / access_token / password query parameters
    [/([?&](?:key|api_key|access_token|password)=)[^&#\s"']+/gi, '$1[REDACTED]'],
    // Authorization headers
    [/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=\-]+/gi, '$1 [REDACTED]'],
    // JSON fields that carry secrets
    [/("(?:apiKey|accessPassword|api_key|password|key)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2'],
];

export function redact(input: string, secrets: readonly string[] = []): string {
    let out = input;
    for (const secret of secrets) {
        // Very short values would match ordinary words; the patterns below still catch keys.
        if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
    }
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export interface LogSink {
    log(line: string): void;
    warn(line: string): void;
    error(line: string): void;
}

function formatValue(value: unknown): string {
    if (value instanceof Error) return JSON.stringify(value.message);
    if (typeof value === 'string') return /^[\w.:/@-]*$/.test(value) ? value : JSON.stringify(value);
    return JSON.stringify(value) ?? String(value);
}

export function createLogger(level: LogLevel, secrets: readonly string[] = [], sink: LogSink = console): Logger {
    const threshold = ORDER[level];
    const write = (lvl: LogLevel, message: string, fields?: LogFields) => {
        if (ORDER[lvl] < threshold) return;
        let line = `${lvl.toUpperCase()} ${message}`;
        if (fields) {
            for (const [k, v] of Object.entries(fields)) {
                if (v !== undefined) line += ` ${k}=${formatValue(v)}`;
            }
        }
        line = redact(line, secrets);
        if (lvl === 'error') sink.error(line);
        else if (lvl === 'warn') sink.warn(line);
        else sink.log(line);
    };
    return {
        debug: (m, f) => write('debug', m, f),
        info: (m, f) => write('info', m, f),
        warn: (m, f) => write('warn', m, f),
        error: (m, f) => write('error', m, f),
    };
}
