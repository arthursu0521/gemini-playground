import { assert, assertEquals, assertFalse } from '@std/assert';
import { loadConfig } from '../../src/server/config.ts';
import { resolveCredentials, tokenFromHeaders } from '../../src/server/credentials.ts';
import { RateLimiter } from '../../src/server/rate-limit.ts';
import { corsHeaders, isOriginAllowed, timingSafeEqual, withSecurityHeaders } from '../../src/server/security.ts';

const env = (vars: Record<string, string>) => (name: string) => vars[name];
const PASSWORD = 'correct horse battery';
const SERVER_KEY = 'AIzaServerKey_000000000000000000000';

Deno.test('timingSafeEqual', async () => {
    assert(await timingSafeEqual('abc', 'abc'));
    assertFalse(await timingSafeEqual('abc', 'abd'));
    assertFalse(await timingSafeEqual('abc', 'abcd'));
    assertFalse(await timingSafeEqual('', 'x'));
});

Deno.test('origin checks: same-origin and non-browser always allowed, allowlist enforced', () => {
    const url = new URL('https://play.example/ws');
    const open = loadConfig(env({}));
    const locked = loadConfig(env({ ALLOWED_ORIGINS: 'https://friend.example' }));
    assert(isOriginAllowed(null, url, locked));
    assert(isOriginAllowed('https://play.example', url, locked));
    assert(isOriginAllowed('https://friend.example', url, locked));
    assertFalse(isOriginAllowed('https://evil.example', url, locked));
    assert(isOriginAllowed('https://evil.example', url, open));
});

Deno.test('CORS: wildcard when open, echo + Vary when locked', () => {
    assertEquals(corsHeaders('https://x.example', loadConfig(env({}))).get('access-control-allow-origin'), '*');
    const locked = loadConfig(env({ ALLOWED_ORIGINS: 'https://friend.example' }));
    const ok = corsHeaders('https://friend.example', locked);
    assertEquals(ok.get('access-control-allow-origin'), 'https://friend.example');
    assertEquals(ok.get('vary'), 'Origin');
    assertEquals(corsHeaders('https://evil.example', locked).get('access-control-allow-origin'), null);
});

Deno.test('security headers: CSP only on HTML, HSTS only on https, immutable headers copied', () => {
    const html = withSecurityHeaders(
        new Response('<p>', { headers: { 'content-type': 'text/html' } }),
        new URL('https://h.example/'),
    );
    assert(html.headers.get('content-security-policy')?.includes("connect-src 'self' wss://h.example"));
    assertEquals(html.headers.get('x-frame-options'), 'DENY');
    assertEquals(html.headers.get('strict-transport-security'), 'max-age=31536000');

    const js = withSecurityHeaders(
        new Response('x', { headers: { 'content-type': 'text/javascript' } }),
        new URL('http://localhost/'),
    );
    assertEquals(js.headers.get('content-security-policy'), null);
    assertEquals(js.headers.get('strict-transport-security'), null);
    assertEquals(js.headers.get('x-content-type-options'), 'nosniff');

    const immutable = Response.redirect('https://h.example/x', 302);
    const copied = withSecurityHeaders(immutable, new URL('https://h.example/'));
    assertEquals(copied.status, 302);
    assertEquals(copied.headers.get('x-content-type-options'), 'nosniff');
});

Deno.test('credentials: client key, access password in either field, rejections', async () => {
    const config = loadConfig(env({ GEMINI_API_KEY: SERVER_KEY, ACCESS_PASSWORD: PASSWORD }));
    assertEquals(await resolveCredentials({ apiKey: 'AIzaClientKey_0000000000' }, config), {
        ok: true,
        apiKey: 'AIzaClientKey_0000000000',
        source: 'client',
    });
    assertEquals(await resolveCredentials({ accessPassword: PASSWORD }, config), {
        ok: true,
        apiKey: SERVER_KEY,
        source: 'server',
    });
    assertEquals((await resolveCredentials({ apiKey: PASSWORD }, config)).ok, true);
    assertEquals(await resolveCredentials({ accessPassword: 'wrong password!' }, config), {
        ok: false,
        reason: 'Invalid access password',
    });
    assertEquals(await resolveCredentials({}, config), { ok: false, reason: 'Missing API key' });
    assertEquals(await resolveCredentials({ apiKey: 'bad key with spaces' }, config), {
        ok: false,
        reason: 'Malformed API key',
    });
    assertEquals(await resolveCredentials({ apiKey: 42 }, config), { ok: false, reason: 'Missing API key' });

    const disabled = loadConfig(env({ GEMINI_API_KEY: SERVER_KEY }));
    assertEquals(await resolveCredentials({ accessPassword: PASSWORD }, disabled), {
        ok: false,
        reason: 'Access password login is not enabled',
    });
});

Deno.test('tokenFromHeaders reads Bearer, x-goog-api-key and api-key', () => {
    assertEquals(tokenFromHeaders(new Headers({ authorization: 'Bearer  abc ' })), 'abc');
    assertEquals(tokenFromHeaders(new Headers({ 'x-goog-api-key': 'def' })), 'def');
    assertEquals(tokenFromHeaders(new Headers({ 'api-key': 'ghi' })), 'ghi');
    assertEquals(tokenFromHeaders(new Headers()), '');
});

Deno.test('rate limiter: fixed window, per key, disabled at 0, bounded memory', () => {
    let now = 0;
    const limiter = new RateLimiter(2, { now: () => now });
    assert(limiter.take('a').allowed);
    assert(limiter.take('a').allowed);
    const blocked = limiter.take('a');
    assertFalse(blocked.allowed);
    assertEquals(blocked.retryAfterSeconds, 60);
    assert(limiter.take('b').allowed);
    now = 60_000;
    assert(limiter.take('a').allowed);

    assert(new RateLimiter(0).take('x').allowed);

    const small = new RateLimiter(5, { now: () => now, maxKeys: 10 });
    for (let i = 0; i < 100; i++) small.take(`ip${i}`);
    assert(small.size <= 10);
});
