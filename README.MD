# Gemini Live 游乐场 / Gemini Playground

### [English Version](README_EN.MD)

### 作者：技术爬爬虾

B站，YouTube，抖音，公众号 全网同名。转载请注明作者。

## 项目简介

准备一个 Gemini API Key，几分钟即可部署一个 Gemini 多模态实时对话网站：

- **实时语音 / 视频 / 屏幕共享对话**（Gemini Live API），支持打断、语音转写、会话自动续连（超过 10 分钟的连接限制也不会断）。
- **OpenAI 兼容 API 中转**：`/v1/chat/completions`、`/v1/embeddings`、`/v1/models`、`/v1/images/generations`，可接入 ChatBox、Cursor 等客户端。请求直接转发到 Google 官方的 OpenAI 兼容接口，支持流式输出、函数调用、结构化输出。
- 不限地区 / 网络环境，打开即用，适配手机端；使用 Deno Deploy 或 Cloudflare Workers 无服务器部署。
- 安全：API Key 不出现在任何 URL 或服务器日志中；可选"访问密码 + 服务器端 Key"模式，密钥只保存在平台的环境变量（Secret）里。

## Deno Deploy 部署（推荐）

> Deno Deploy Classic（dash.deno.com）已于 2026-07-20 停止服务，以下为新版 Deno Deploy（console.deno.com）的步骤。

### 方式一：连接 GitHub（推送即部署）

1. [Fork](https://github.com/tech-shrimp/gemini-playground/fork) 本项目。
2. 登录 <https://console.deno.com>，创建组织（organization）。
3. 点击 **+ New App**，选择你 fork 的仓库。
4. 点击 **Edit build config**：
   - Framework preset：`No Preset`
   - Install command、Build command：留空
   - Runtime configuration：`Dynamic`
   - Dynamic Entrypoint：`src/deno_index.ts`
5. （可选）点击 **Add/Edit environment variables** 配置环境变量（见下方[配置](#配置)）。`GEMINI_API_KEY`、`ACCESS_PASSWORD` 请选择 **Secret** 类型。也可以用 **+ Add from .env file** 粘贴本地 `.env` 的内容批量导入。
6. 点击 **Create App**。之后每次推送到 GitHub 都会自动部署，部署后获得的域名即可直接使用，也可作为 API 代理。

### 方式二：命令行直接推送（`deno deploy`）

需要较新的 Deno 2（能运行 `deno deploy --help` 即可，可用 `deno upgrade` 升级）。

```bash
deno task deploy:create   # 只需一次：创建应用（按提示选择组织、填写应用名）
deno task deploy:env      # 可选：把本地 .env 上传为应用环境变量（Key/密码自动作为 Secret）
deno task deploy          # 推送当前目录到生产环境
```

`.env` 已被 `.gitignore` 和 `deno.json` 的 `exclude` 排除，**不会被上传**；服务器在 Deno Deploy 上也不会读取 `.env` 文件，只读取平台环境变量。

也可以用 GitHub Actions 自动部署：在仓库中添加 Secret `DENO_DEPLOY_TOKEN` 和变量 `DENO_DEPLOY_ORG`、`DENO_DEPLOY_APP`，见 `.github/workflows/deno-deploy.yml`（已连接 GitHub 的话无需此步骤）。

## Cloudflare Workers 部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tech-shrimp/gemini-playground)

1. 点击部署按钮，登录 Cloudflare 账号，填入 Account ID 与 API Token。
2. Fork 本项目，在仓库 Secrets 中添加 `CF_API_TOKEN`、`CF_ACCOUNT_ID`，并开启 GitHub Actions。之后推送到 `main` 且测试通过后自动部署（Pull Request 不会部署）。
3. 服务器端密钥请用 `deno run -A npm:wrangler secret put GEMINI_API_KEY`（及 `ACCESS_PASSWORD`）设置，不要写进 `wrangler.toml`。
4. 国内使用需要绑定一个自定义域名。

   <details>
   <summary>如图</summary>

   ![image](/docs/images/3.png)
   </details>

> 国内使用 Cloudflare 有时可能出现 400: User location is not supported for the API use，可能是粤港地区 Cloudflare 路由到了香港节点导致的，建议换成 Deno 部署。

## 本地运行

安装 Deno：

```bash
# Windows
irm https://deno.land/install.ps1 | iex
# Mac/Linux
curl -fsSL https://deno.land/install.sh | sh
```

启动：

```bash
cd 项目目录
cp .env.example .env      # 可选：配置环境变量
deno task start           # 打开 http://localhost:8000
```

## 配置

所有环境变量都是可选的。不配置任何变量时，访问者需要填写自己的 Gemini API Key。完整说明见 [`.env.example`](.env.example)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 空 | 服务器端 Key。必须同时设置 `ACCESS_PASSWORD` 才会启用。 |
| `ACCESS_PASSWORD` | 空 | 访问密码，至少 12 位。访问者输入它即可使用服务器端 Key（网页和 API 都适用）。 |
| `ALLOWED_ORIGINS` | 空（任意来源） | 允许调用的网页来源，逗号分隔。同源请求始终允许。设置后可防止别人的网站盗用你的部署。 |
| `RATE_LIMIT_PER_MINUTE` | `60` | 每个 IP 每分钟 API 请求数，`0` 为不限。 |
| `WS_CONNECTIONS_PER_MINUTE` | `10` | 每个 IP 每分钟新建实时会话数，`0` 为不限。 |
| `TRUST_PROXY_HEADERS` | `false` | 仅在自建反向代理后面时开启，信任 `X-Forwarded-For`。 |
| `DEFAULT_CHAT_MODEL` | `gemini-3.8-flash` | 请求未指定模型时使用的对话模型。 |
| `DEFAULT_EMBEDDING_MODEL` | `gemini-embedding-001` | 请求未指定模型时使用的向量模型。 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`。日志中的 Key、Token、密码会被自动脱敏。 |

**关于密钥安全**

- `.env` 只用于本地开发：不提交到 Git、不上传到 Deno Deploy、不会被网站对外提供；生产环境请在平台中设置为 Secret。
- 浏览器端的 Key 默认只保存在当前标签页（sessionStorage），勾选"Remember key"才会保存在本机；"Forget saved key"可一键清除。
- 网页通过 WebSocket 首条消息发送 Key，Key 不会出现在 URL 中，服务器日志也不会记录。

## 使用方法

### 多模态对话

填入 API Key（或访问密码），点击 Connect 即可对话。下方三个按钮分别是：麦克风、摄像头、屏幕共享。右上角设置中可以选择模型、声音、语言，以及"仅文字"回复模式。

<details>
<summary>如图</summary>

![image](/docs/images/2.png)
</details>

### API 代理

接口为 OpenAI 格式，注意替换域名与 Gemini API Key（启用了访问密码时也可以用访问密码代替 Key）。

#### 可用模型列表

```bash
curl 'https://your.domain.com/v1/models' \
  --header 'Authorization: Bearer YOUR-GEMINI-API-KEY'
```

#### 对话

```bash
curl 'https://your.domain.com/v1/chat/completions' \
  --header 'Authorization: Bearer YOUR-GEMINI-API-KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "system", "content": "You are a test assistant."},
      {"role": "user", "content": "Testing. Just say hi and nothing else."}
    ]
  }'
```

### ChatBox

<details>
<summary>如图</summary>

![image](/docs/images/4.png)
</details>

### Cursor 编程

<details>
<summary>如图</summary>

![image](/docs/images/5.png)
</details>

## 开发

```bash
deno task dev        # 本地开发，文件变化自动重启
deno task check      # 格式检查 + lint + 类型检查
deno task test       # 单元测试 + 集成测试（真实服务器 + 模拟 Gemini）
deno task test:e2e   # 端到端测试：无头 Chrome（虚拟麦克风/摄像头）+ 真实服务器 + 模拟 Gemini
deno task smoke      # 用真实 Gemini 冒烟测试（设置了 GEMINI_API_KEY 时跑一轮真实语音对话）
```

目录结构：

```
src/
  deno_index.ts        Deno 入口（本地 / Deno Deploy）
  worker.ts            Cloudflare Workers 入口
  server/              两个平台共用的服务端代码：路由、实时会话中转、OpenAI 兼容代理、鉴权、限流、日志脱敏
  static/              网页前端（原生 ES Modules，无需构建）
    js/shared/         前后端共用的协议定义
tests/                 server/ frontend/ e2e/ 三层测试
```

## 致谢 / 引用

网站 UI：

```
Author: ChrisKyle
Project: https://github.com/ViaAnthroposBenevolentia/gemini-2-live-api-demo
MIT License : https://github.com/ViaAnthroposBenevolentia/gemini-2-live-api-demo/blob/main/LICENSE
```

图标：[Feather Icons](https://feathericons.com)（MIT License）

早期版本的 Gemini 转 OpenAI 格式参考了：

```
Author: PublicAffairs
Project: https://github.com/PublicAffairs/openai-gemini
MIT License : https://github.com/PublicAffairs/openai-gemini/blob/main/LICENSE
```
