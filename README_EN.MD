# Gemini Live Playground

### [中文版](README.MD)

### Author: Tech Shrimp (技术爬爬虾)

Find me on Bilibili, YouTube, Douyin and WeChat under the same name. Please credit the author when sharing.

## Overview

Bring a Gemini API key and deploy your own multimodal real-time Gemini site in minutes:

- **Real-time voice / video / screen-sharing conversations** (Gemini Live API) with barge-in, live transcripts and automatic session resumption (sessions survive the ~10 minute connection limit).
- **OpenAI-compatible API relay**: `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`, `/v1/images/generations` for ChatBox, Cursor and other clients. Requests go to Google's official OpenAI compatibility layer, so streaming, function calling and structured output work.
- Works from any region and network, mobile friendly; serverless on Deno Deploy or Cloudflare Workers.
- Secure by default: API keys never appear in URLs or server logs; optional "access password + server-side key" mode keeps the key in the platform's secret store.

## Deploy to Deno Deploy (recommended)

> Deno Deploy Classic (dash.deno.com) was shut down on 2026-07-20. These steps are for the new Deno Deploy (console.deno.com).

### Option 1: connect GitHub (deploy on every push)

1. [Fork](https://github.com/tech-shrimp/gemini-playground/fork) this repository.
2. Sign in at <https://console.deno.com> and create an organization.
3. Click **+ New App** and pick your fork.
4. Click **Edit build config**:
   - Framework preset: `No Preset`
   - Install command, Build command: leave empty
   - Runtime configuration: `Dynamic`
   - Dynamic Entrypoint: `src/deno_index.ts`
5. (Optional) Click **Add/Edit environment variables** and set the [configuration](#configuration). Mark `GEMINI_API_KEY` and `ACCESS_PASSWORD` as **Secret**. **+ Add from .env file** lets you paste a local `.env`.
6. Click **Create App**. Every push now deploys; the assigned domain serves the UI and the API.

### Option 2: push from the command line (`deno deploy`)

Requires a recent Deno 2 (if `deno deploy --help` works you are set; `deno upgrade` otherwise).

```bash
deno task deploy:create   # once: create the app (prompts for organization and app name)
deno task deploy:env      # optional: upload .env as app variables (keys/passwords become secrets)
deno task deploy          # upload this directory to production
```

`.env` is excluded by `.gitignore` and by `exclude` in `deno.json`, so it is **never uploaded**. On Deno Deploy the server never reads a `.env` file either; it only reads platform environment variables.

GitHub Actions can deploy too: add the secret `DENO_DEPLOY_TOKEN` and the variables `DENO_DEPLOY_ORG` / `DENO_DEPLOY_APP` (see `.github/workflows/deno-deploy.yml`; not needed when the repo is connected in the console).

## Deploy to Cloudflare Workers

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tech-shrimp/gemini-playground)

1. Click the button, sign in to Cloudflare and enter your Account ID and API token.
2. Fork the repo, add the repository secrets `CF_API_TOKEN` and `CF_ACCOUNT_ID`, and enable GitHub Actions. Pushes to `main` deploy after the tests pass (pull requests never deploy).
3. Set server-side secrets with `deno run -A npm:wrangler secret put GEMINI_API_KEY` (and `ACCESS_PASSWORD`); never put them in `wrangler.toml`.
4. Users in mainland China need a custom domain.

## Run locally

```bash
# install Deno: https://docs.deno.com/runtime/getting_started/installation/
cp .env.example .env      # optional configuration
deno task start           # open http://localhost:8000
```

## Configuration

Every variable is optional; with none set, visitors use their own Gemini API key. See [`.env.example`](.env.example) for details.

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Server-side key. Only enabled together with `ACCESS_PASSWORD`. |
| `ACCESS_PASSWORD` | empty | Nonempty; at least 12 characters recommended. Visitors who enter it use the server-side key (UI and API). |
| `ALLOWED_ORIGINS` | empty (any) | Comma-separated browser origins allowed to use the deployment. Same-origin is always allowed. |
| `RATE_LIMIT_PER_MINUTE` | `60` | API requests per minute per client IP (`0` = unlimited). |
| `WS_CONNECTIONS_PER_MINUTE` | `10` | New live sessions per minute per client IP (`0` = unlimited). |
| `TRUST_PROXY_HEADERS` | `false` | Only behind your own reverse proxy: trust `X-Forwarded-For`. |
| `DEFAULT_CHAT_MODEL` | `gemini-3.8-flash` | Chat model when a request names none. |
| `DEFAULT_EMBEDDING_MODEL` | `gemini-embedding-001` | Embedding model when a request names none. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Keys, tokens and passwords are redacted from logs. |

**Secrets**

- `.env` is for local development only: not committed, not uploaded to Deno Deploy, never served over HTTP. In production use the platform's secret variables.
- In the browser the key is kept for the current tab only (sessionStorage) unless "Remember key" is ticked; "Forget saved key" removes it.
- The UI sends the key in the first WebSocket message, so it never appears in a URL or in server logs.

## Usage

### Multimodal chat

Enter your API key (or the access password) and click Connect. The three buttons are microphone, camera and screen sharing. The settings panel lets you pick the model, voice, language and a text-only response mode.

![image](/docs/images/2.png)

### API relay

OpenAI format; replace the domain and the key (the access password also works when enabled).

```bash
curl 'https://your.domain.com/v1/models' --header 'Authorization: Bearer YOUR-GEMINI-API-KEY'

curl 'https://your.domain.com/v1/chat/completions' \
  --header 'Authorization: Bearer YOUR-GEMINI-API-KEY' \
  --header 'Content-Type: application/json' \
  --data '{"model": "gemini-3.8-flash", "messages": [{"role": "user", "content": "Just say hi."}]}'
```

## Development

```bash
deno task dev        # run with auto-restart
deno task check      # fmt check + lint + type-check
deno task test       # unit + integration tests (real server, mock Gemini)
deno task test:e2e   # headless Chrome with fake mic/camera against the real server and a mock Gemini
deno task smoke      # smoke test against the real Gemini API (full voice turn when GEMINI_API_KEY is set)
```

```
src/
  deno_index.ts        Deno entry point (local / Deno Deploy)
  worker.ts            Cloudflare Workers entry point
  server/              shared server code: routing, live relay, OpenAI proxy, auth, rate limits, log redaction
  static/              web UI (plain ES modules, no build step)
    js/shared/         protocol shared by browser and server
tests/                 server/, frontend/ and e2e/ suites
```

## Credits

- UI: [ChrisKyle / gemini-2-live-api-demo](https://github.com/ViaAnthroposBenevolentia/gemini-2-live-api-demo) (MIT)
- Icons: [Feather Icons](https://feathericons.com) (MIT)
- Earlier Gemini-to-OpenAI conversion: [PublicAffairs / openai-gemini](https://github.com/PublicAffairs/openai-gemini) (MIT)
