# Cookie session authentication

## Deployment interface

- `ACCESS_PASSWORD_HASH`: encoded Argon2id v19, `m=19456,t=2,p=1`, random 16-byte salt, 32-byte output. Tested under real Deno 2.9.6 using portable `hash-wasm@4.12.0`; no native bindings or PBKDF2 fallback.
- `AUTH_PASSWORD_VERSION`: positive monotonic integer, default `1`. Increment on every rotation or forced logout. Generation and hash fingerprint are stored in each session and checked against the strongly consistent KV version. Old deployments cannot overwrite a newer generation. Reusing a generation with a different hash fails closed. Rollback requires a **new larger generation**, never decreasing it.
- `ALLOWED_ORIGINS`: explicit exact browser origins, e.g. `https://gemini.spdt.work,https://talk.aesc.ai`. Include preview origins if preview browser login is needed. No wildcard acceptance for login/WS; absent/foreign Origin rejected. Request URL must itself be HTTPS in session mode. Forwarded host/proto are not trusted.
- `GEMINI_API_KEY`: server upstream key; a logged-in user may optionally choose a personal key. Personal keys never bypass cookie authentication.
- Console-managed passwords: set nonempty `ACCESS_PASSWORD`, remove `ACCESS_PASSWORD_HASH`, and increment `AUTH_PASSWORD_VERSION` together on each rotation. A hash takes precedence if both remain set. Passwords shorter than 12 characters warn but remain usable; 12+ unique characters are recommended. Plaintext is held in server environment/runtime only, never accepted in bearer tokens or WS password frames.
- Runtime feature flag: keep `"unstable": ["kv"]` at the top level of `deno.json`. Git-integrated Deno Deploy runs the entrypoint directly; `--unstable-kv` inside local tasks alone does not enable `Deno.openKv` in that runtime. Without it, login fails closed with HTTP 503, not a password mismatch. Run `deno test --allow-read tests/server/runtime_config_test.ts` to guard this configuration.
- Bind a dedicated **shared Deno KV database** before enabling sessions (`Deno.openKv()` lazily initializes). No database/binding or KV errors fail closed. Other adapters preserve personal-key operation when sessions are not configured; session configuration without an injected compatible backend fails closed.
- `TRUST_PROXY_HEADERS` remains false unless deployment guarantees sanitization. Default login throttle uses platform remote IP; unknown/shared proxies share a bucket (safe but potentially restrictive).

## Shared KV assignment and release verification

Assign the existing KV instance with the official CLI: `deno deploy database assign kv --org homer --app gemini` (see current CLI help for global option placement). The underlying console operation is `apps.assignDatabaseAttachment({org:'homer', app:'gemini', databaseInstance:'kv'})`. It provisions standard per-context logical databases on the existing instance; it does not require a second KV instance. Keep production, branch preview and standalone preview separate. Reassignment may switch databases and invalidate existing sessions; never delete the previous database during this repair.

An instance showing an app assignment is insufficient proof. After every Git-triggered release, read `revisions.listTimelines` for the actual new revision: Production must include a `denokv` database, normally `{deno.app.short_id}-production`. Verify preview contexts separately. A one-off revision deployment with an explicit database reference is not a substitute for the reusable app assignment used by future Git builds.

Then issue one known-wrong-password HTTPS login request with a same-origin Origin (expect 401, never 503), triggering the lazy `Deno.openKv()` initialization. Query that revision's runtime logs after the request: `no KV database is attached` / `temporary in-memory store` means the runtime still lacks shared persistence. Do not report shared sessions verified merely from a healthy page or successful login. The platform may silently supply in-memory KV despite app-level fail-closed error handling. Validate refresh/logout and real connection with the owner when no test credential is available. Never log credentials or cookies.

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
