# Cookie session authentication

## Deployment interface

- `ACCESS_PASSWORD_HASH`: encoded Argon2id v19, `m=19456,t=2,p=1`, random 16-byte salt, 32-byte output. Tested under real Deno 2.9.6 using portable `hash-wasm@4.12.0`; no native bindings or PBKDF2 fallback.
- `AUTH_PASSWORD_VERSION`: positive monotonic integer, default `1`. Increment on every rotation or forced logout. Generation and hash fingerprint are stored in each session and checked against the strongly consistent KV version. Old deployments cannot overwrite a newer generation. Reusing a generation with a different hash fails closed. Rollback requires a **new larger generation**, never decreasing it.
- `ALLOWED_ORIGINS`: explicit exact browser origins, e.g. `https://gemini.spdt.work,https://talk.aesc.ai`. Include preview origins if preview browser login is needed. No wildcard acceptance for login/WS; absent/foreign Origin rejected. Request URL must itself be HTTPS in session mode. Forwarded host/proto are not trusted.
- `GEMINI_API_KEY`: server upstream key; a logged-in user may optionally choose a personal key. Personal keys never bypass cookie authentication.
- Remove `ACCESS_PASSWORD` from production. A hash takes precedence over plaintext; legacy plaintext config remains supported for other/local installations but is never accepted in bearer tokens or WS password frames.
- Runtime feature flag: keep `"unstable": ["kv"]` at the top level of `deno.json`. Git-integrated Deno Deploy runs the entrypoint directly; `--unstable-kv` inside local tasks alone does not enable `Deno.openKv` in that runtime. Without it, login fails closed with HTTP 503, not a password mismatch. Run `deno test --allow-read tests/server/runtime_config_test.ts` to guard this configuration.
- Bind a dedicated **shared Deno KV database** before enabling sessions (`Deno.openKv()` lazily initializes). No database/binding or KV errors fail closed. Other adapters preserve personal-key operation when sessions are not configured; session configuration without an injected compatible backend fails closed.
- `TRUST_PROXY_HEADERS` remains false unless deployment guarantees sanitization. Default login throttle uses platform remote IP; unknown/shared proxies share a bucket (safe but potentially restrictive).

## Offline hash generation

Put the password in a protected input file, not command arguments or shell history:

```sh
deno run --allow-read=/private/password --allow-write=/private/hash scripts/hash-password.ts /private/password /private/hash
```

The output must not exist; created mode 0600. A single trailing newline is removed from input; all other characters are preserved. CLI prints neither password nor hash. Securely delete the input after environment migration. Hashes are sensitive too; do not commit either file.

## Security behavior

- HTTPS JSON POST `/auth/login`; five attempts/IP/fixed minute, atomic shared KV admission **before** Argon2. Invalid JSON/origin never invokes password verification.
- Random 256-bit opaque cookie; KV keys contain only SHA-256 verifier. Eight-hour fixed expiry, no sliding renewal. `__Host-gemini_session; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, no Domain.
- Session checks happen **before** WS upgrade and every matched OpenAI-compatible route, including models and OPTIONS. Non-browser API requests may omit Origin but still need cookie.
- POST `/auth/logout` deletes shared verifier, clears cookie and immediately closes local related sockets; other instances close on next check (15 seconds). Expiry, password version changes and KV failures also close idle sockets. No password is retained by settings or sent on reconnect.
- Deno invalidates access to Request headers after `upgradeWebSocket`. Capture session token before upgrade and use captured token for periodic checks; never retain the upgraded Request for authentication.
- Browser shows login after session failure, probes before connecting/after errors, clears password input on success, removes legacy local/session password entries. Cookies are host-only, so alias and canonical site have independent browser sessions.

## Verification

```sh
deno task check
deno task test
CI=true deno task test:e2e
```

E2E requires `openssl` and Chrome (Astral can download Chrome); creates/removes a temporary local TLS certificate, uses a mock Gemini upstream and real in-memory Deno KV. Tests verify HTTPS login, cookie-only WS, text relay, cross-instance revocation returning to login, re-login and logout. No real API key needed.

Before production: verify missing/foreign Origin 403, unauthenticated WS/API 401, valid login sets secure host cookie, no password frames/storage, personal key cannot bypass, valid cookie reaches Gemini, logout revokes on other instance within 15 seconds, and configured KV failure does not reopen access. Do not use real secrets in logs or test output.
