import { assert, assertEquals } from '@std/assert';
import { loadConfig, publicConfig } from '../../src/server/config.ts';

const env = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test('defaults: no server key, sensible limits, Google upstream', () => {
    const config = loadConfig(env({}));
    assertEquals(config.serverKeyEnabled, false);
    assertEquals(config.allowedOrigins, []);
    assertEquals(config.rateLimitPerMinute, 60);
    assertEquals(config.wsConnectionsPerMinute, 10);
    assertEquals(config.upstreamBaseUrl, 'https://generativelanguage.googleapis.com');
    assertEquals(config.defaultChatModel, 'gemini-3.8-flash');
    assertEquals(config.defaultEmbeddingModel, 'gemini-embedding-001');
    assertEquals(config.logLevel, 'info');
    assertEquals(config.warnings, []);
});

Deno.test('server key requires an access password of at least 12 characters', () => {
    const noPassword = loadConfig(env({ GEMINI_API_KEY: 'AIzaKey' }));
    assertEquals(noPassword.serverKeyEnabled, false);
    assert(noPassword.warnings.some((w) => w.includes('ACCESS_PASSWORD is empty')));

    const weak = loadConfig(env({ GEMINI_API_KEY: 'AIzaKey', ACCESS_PASSWORD: 'short' }));
    assertEquals(weak.serverKeyEnabled, false);
    assert(weak.warnings.some((w) => w.includes('shorter than 12')));

    const strong = loadConfig(env({ GEMINI_API_KEY: 'AIzaKey', ACCESS_PASSWORD: 'correct horse battery' }));
    assertEquals(strong.serverKeyEnabled, true);
});

Deno.test('ALLOWED_ORIGINS is normalised and invalid entries are dropped with a warning', () => {
    const config = loadConfig(env({ ALLOWED_ORIGINS: 'https://a.example/path, http://b.example:8080 ,nonsense,' }));
    assertEquals(config.allowedOrigins, ['https://a.example', 'http://b.example:8080']);
    assertEquals(config.warnings.length, 1);
});

Deno.test('invalid numbers and log levels fall back to defaults', () => {
    const config = loadConfig(env({ RATE_LIMIT_PER_MINUTE: '-3', WS_CONNECTIONS_PER_MINUTE: 'x', LOG_LEVEL: 'loud' }));
    assertEquals(config.rateLimitPerMinute, 60);
    assertEquals(config.wsConnectionsPerMinute, 10);
    assertEquals(config.logLevel, 'info');
    assertEquals(config.warnings.length, 3);
    assertEquals(loadConfig(env({ RATE_LIMIT_PER_MINUTE: '0' })).rateLimitPerMinute, 0);
});

Deno.test('UPSTREAM_BASE_URL must be https except for localhost', () => {
    assertEquals(
        loadConfig(env({ UPSTREAM_BASE_URL: 'http://127.0.0.1:9999/x' })).upstreamBaseUrl,
        'http://127.0.0.1:9999',
    );
    const insecure = loadConfig(env({ UPSTREAM_BASE_URL: 'http://evil.example' }));
    assertEquals(insecure.upstreamBaseUrl, 'https://generativelanguage.googleapis.com');
    assertEquals(insecure.warnings.length, 1);
});

Deno.test('publicConfig never exposes secrets', () => {
    const config = loadConfig(env({ GEMINI_API_KEY: 'AIzaSecretKey123', ACCESS_PASSWORD: 'correct horse battery' }));
    const text = JSON.stringify(publicConfig(config));
    assertEquals(text, '{"serverKeyAvailable":true,"sessionRequired":true}');
});
