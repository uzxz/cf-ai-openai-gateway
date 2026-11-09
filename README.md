# CF_AOG — Cloudflare Workers AI OpenAI Gateway

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uzxz/CF_AOG)

把 **Cloudflare Workers AI** 包装成**标准 OpenAI-compatible 上游**，供 [sub2api](https://github.com/Wei-Shaw/sub2api) 之类的网关直接接入。

- **一键部署**：点上面的按钮，在 Cloudflare 引导页填 3 个值即可（约 2 分钟）。
- **零基础设施**：一个 Worker，不需要 KV / D1 / R2 / 服务器。
- **凭据隔离**：Cloudflare API 令牌只存在 Worker Secret 里，不下发给下游客户端。
- **额度保护**：默认把 `max_tokens` 钳制在 512，防止一次请求耗尽每日免费额度。

---

## 为什么需要它

直接把 Cloudflare 的 `/ai/v1` 填进 sub2api 会有四个坑（均已用真实账户实测）：

| 坑 | 实测结果 | 本 Worker 的解法 |
| --- | --- | --- |
| sub2api 默认转成 Responses API 转发 | Cloudflare `/ai/v1/responses` 用标准 `input` 字段返回 **400** | 只对外提供 `/v1/chat/completions`，并在 sub2api 强制 `force_chat_completions` |
| Cloudflare 没有模型列表 | `GET /ai/v1/models` → **405**，POST → 400 | 补齐 `/v1/models` |
| 模型名不兼容 | 下游发 `gpt-4o-mini`，Cloudflare 只认 `@cf/...` | 内置别名映射，也允许直接传 `@cf/...` |
| reasoning 模型输出空白 | `glm-4.7-flash` / `gpt-oss-20b` 的输出在 `reasoning_content`，`content` 为 `null` | 非流式与 SSE 都把 `reasoning_content` / `reasoning` 归一到 `content` |

另外：隐藏真实 Cloudflare token、发请求前做 host 安全校验（拒绝 `localhost` / 环回 / 私有 / 保留地址）、上游错误码原样透传。

---

# 一、一键部署到 Cloudflare（推荐）

## 前置条件

| 项目 | 说明 |
| --- | --- |
| Cloudflare 账户 | [免费注册](https://dash.cloudflare.com/sign-up/workers-and-pages)，Workers AI 在 Free 计划即可用 |
| GitHub 账户 | 一键部署会把本仓库克隆到你的 GitHub 账户下，并配置 Workers Builds（之后 push 自动部署） |
| Workers AI API 令牌 | dashboard → **AI** → **Workers AI** → **Use REST API** → **Create a Workers AI API Token**，需要 `Workers AI - Read` 与 `Workers AI - Edit` 权限 |
| Cloudflare 账户 ID | dashboard 右侧栏，或 `npx wrangler whoami` |
| 一个随机字符串 | 作为 `GATEWAY_KEY`，用 `openssl rand -hex 32` 生成 |

> **仓库必须是 Public**，否则 Cloudflare 无法克隆（[官方限制](https://developers.cloudflare.com/workers/platform/deploy-buttons/#limitations)）。本仓库请设为公开。

## 部署步骤

**1. 点按钮**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uzxz/CF_AOG)

或直接打开：<https://deploy.workers.cloudflare.com/?url=https://github.com/uzxz/CF_AOG>

**2. 在 Cloudflare 引导页配置**

| 字段 | 填什么 |
| --- | --- |
| Git account | 选你的 GitHub 账户；Cloudflare 会在其下新建一个仓库副本 |
| Create private Git repository | 保持**不勾选**（必须 public） |
| Project / Worker name | 默认 `cf-ai-openai-gateway` 即可，也可自定义 |
| Build command | 留空（本项目无需构建）；`package.json` 未定义 `build` 脚本，Cloudflare 会自动留空 |
| Deploy command | `npm run deploy`（等价于 `npx wrangler deploy`），Cloudflare 会从 `package.json` 自动预填 |
| **GATEWAY_KEY** | `openssl rand -hex 32` 生成的随机串，**保存好**，第 4 步填进 sub2api |
| **CF_AI_TOKEN** | 上面创建的 Workers AI API 令牌 |
| **CF_ACCOUNT_ID** | 你的 Cloudflare 账户 ID |

> 这 3 个 secret 由仓库里的 `.dev.vars.example` 声明，Cloudflare 会自动识别并在引导页生成输入框；每个字段的说明来自 `package.json` 的 `cloudflare.bindings`。值只会存为 Worker Secret，**不会写回仓库**。

**3. 点 Create and deploy**

Cloudflare 会克隆仓库、用 Workers Builds 构建并部署。完成后得到：

```
https://cf-ai-openai-gateway.<你的子域>.workers.dev
```

记为 `GATEWAY_URL`。之后往新仓库的 `main` 分支 push 代码会自动重新部署。

**4. 验证**

```bash
curl -s "${GATEWAY_URL}/health"
# {"status":"ok","upstream":"api.cloudflare.com","models":["gpt-4o-mini","gpt-4o"]}

curl -s "${GATEWAY_URL}/v1/models"

curl -s -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
# 期望 choices[0].message.content == "pong"
```

一键冒烟（凭据从环境变量读取，脚本内无凭据字面量）：

```bash
GATEWAY_URL=https://你的域名 GATEWAY_KEY=你的key bash scripts/smoke.sh
```

**5. 接入 sub2api** → 见 [第三节](#三接入-sub2api)。

## 一键部署的原理

- Cloudflare 读取仓库里的 `wrangler.toml` 判断需要的资源；本项目**不需要任何 KV / D1 / R2 绑定**，所以没有自动供给步骤。
- 读取 `.dev.vars.example` 得到 secret 名单，读取 `package.json` 的 `cloudflare.bindings` 得到每个字段的说明。
- 用 `npm run deploy` → `wrangler deploy` 部署；后续由 Workers Builds 提供 CI/CD 与 PR 预览 URL。
- 参考：[Deploy to Cloudflare buttons 官方文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

---

# 二、手动部署（不用按钮）

适合本地开发、或想自己控制 CI。

## 2.1 本地开发

```bash
git clone https://github.com/uzxz/CF_AOG.git
cd CF_AOG
npm install
npm test            # 25 个离线测试，mock 上游，不需要任何凭据
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`（已被 `.gitignore` 忽略，不会进版本库）：

```dotenv
GATEWAY_KEY=自己生成的随机串
CF_AI_TOKEN=你的 Workers AI API 令牌
CF_ACCOUNT_ID=你的 Cloudflare 账户 ID
```

```bash
npm run dev
```

默认监听 `http://127.0.0.1:8787`。另开终端：

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/models
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{"model":"gpt-4o-mini","messages":[]}'   # 401
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <GATEWAY_KEY>" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
GATEWAY_URL=http://127.0.0.1:8787 GATEWAY_KEY=<GATEWAY_KEY> bash scripts/smoke.sh
```

## 2.2 手动部署到 Cloudflare

```bash
npx wrangler login                          # 浏览器授权，凭据由 wrangler 自行管理
npx wrangler secret put GATEWAY_KEY         # 粘贴随机串
npx wrangler secret put CF_AI_TOKEN         # 粘贴 Workers AI 令牌
npx wrangler secret put CF_ACCOUNT_ID       # 粘贴账户 ID
npm run deploy
```

> **凭据安全**：`CF_AI_TOKEN` / `GATEWAY_KEY` / `CF_ACCOUNT_ID` 只从 Wrangler Secrets、`.dev.vars` 或环境变量读取。源码、`wrangler.toml`、`.dev.vars.example`、示例和测试里不写入任何可用凭据字面量。

## 2.3 GitHub Actions 自动部署（可选）

不点按钮、但想 push 即部署时：在仓库 **Settings → Secrets and variables → Actions** 添加 `CLOUDFLARE_API_TOKEN`（需 *Edit Cloudflare Workers* 权限）与 `CLOUDFLARE_ACCOUNT_ID`，再新建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          secrets: |
            GATEWAY_KEY
            CF_AI_TOKEN
            CF_ACCOUNT_ID
        env:
          GATEWAY_KEY: ${{ secrets.GATEWAY_KEY }}
          CF_AI_TOKEN: ${{ secrets.CF_AI_TOKEN }}
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

对应地还要把 `GATEWAY_KEY` / `CF_AI_TOKEN` / `CF_ACCOUNT_ID` 也加为 GitHub Secrets。参考 [Cloudflare GitHub Actions 文档](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

---

# 三、接入 sub2api

后台添加账号：

| 字段 | 值 |
| --- | --- |
| 平台 / 类型 | `OpenAI` → `API Key`（或 `Upstream`） |
| `base_url` | `${GATEWAY_URL}/v1` |
| `api_key` | `GATEWAY_KEY`（部署时填的那个值） |
| `openai_responses_mode` | **`force_chat_completions`** ← 必填 |
| `model_mapping` | 不填也行（Worker 已做别名映射）；或填 `{"gpt-4o-mini":"gpt-4o-mini","gpt-4o":"gpt-4o"}` |
| 客户端入口 | 只用 `/v1/chat/completions`；**不要**用 Codex / Claude Code 的 Responses、Messages 入口 |
| `security.url_allowlist` | `enabled: true`、`allow_insecure_http: false`（HTTPS only） |

**为什么必须 `force_chat_completions`**：sub2api 的自动探测规则是「探测 `/v1/responses` 返回 404/405 才回退到 chat/completions，其他响应（含 400）都判定为支持 Responses」。本 Worker 对 `/v1/responses` 返回 **404**，理论上能自动回退，但显式声明更稳妥。

**模型名二选一**：

- 别名：`gpt-4o-mini`（→ `@cf/meta/llama-3.3-70b-instruct-fp8-fast`）、`gpt-4o`（→ `@cf/google/gemma-4-26b-a4b-it`）
- 原始名：任意 Free 计划可用的 `@cf/...`（如 `@cf/zai-org/glm-4.7-flash`）；reasoning 模型的输出已被归一，但仍建议优先用非 reasoning 模型

**端到端验证**：

```bash
curl -s -X POST http://YOUR_SUB2API_HOST:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-你发的sub2api-key" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","max_tokens":40,"messages":[{"role":"user","content":"Reply with exactly: pong"}]}'
```

链路：`客户端 → sub2api → 本 Worker → Cloudflare Workers AI`。

---

# 四、API 与配置参考

## 端点

| 路径 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/health` | GET | 无 | 健康检查，不触达上游 |
| `/v1/models` | GET | 无 | 模型列表（补齐 Cloudflare 缺失的端点） |
| `/v1/chat/completions` | POST | Bearer `GATEWAY_KEY` | 标准 OpenAI Chat Completions，支持 `stream: true` SSE |
| `/chat/completions` | POST | 同上 | 兼容不带 `/v1` 前缀的客户端 |
| 其他 | — | — | 404（`/v1/responses`、`/v1/messages`、`/v1/embeddings` 未实现） |

## 环境变量

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `GATEWAY_KEY` | **Secret** | 必填 | 下游客户端的 Bearer Key |
| `CF_AI_TOKEN` | **Secret** | 必填 | Workers AI API 令牌 |
| `CF_ACCOUNT_ID` | **Secret** | 必填 | Cloudflare 账户 ID |
| `MAX_TOKENS_CAP` | var | `512` | `max_tokens` 上限，保护免费额度 |
| `MAX_TOKENS_DEFAULT` | var | `256` | 客户端未传 `max_tokens` 时的默认值 |

## 换模型

编辑 `src/worker.js` 顶部的 `MODEL_MAP`：

```js
const MODEL_MAP = Object.freeze({
  "gpt-4o-mini": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4o": "@cf/google/gemma-4-26b-a4b-it",
});
```

改完 `npm test`，push 后 Workers Builds 自动部署（或手动 `npm run deploy`）。注意 Free 计划不可用 `@cf/moonshotai/kimi-k2.7-code`、`@cf/zai-org/glm-5.2`（返回 403 / error 5035），完整清单见 [Workers AI 模型目录](https://developers.cloudflare.com/workers-ai/models/)。

---

# 五、排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一键部署按钮打不开 / 提示仓库不可用 | 仓库是 private，或 URL 不是 `github.com` | 把仓库设为 **Public** |
| 引导页没有 secret 输入框 | `.dev.vars.example` 没被提交（曾被 `.gitignore` 误伤） | 确认文件在仓库根目录且已 commit |
| 部署成功但请求返回 `500 gateway not configured` | secret 没配好 | dashboard → Worker → Settings → Variables and Secrets，或用 `wrangler secret put` 补齐 3 个值 |
| 请求返回 401 | `GATEWAY_KEY` 与 sub2api 里填的不一致 | 两边对齐；注意不要带多余空格 |
| 返回 `403 / error 5035` | 用了仅 Workers Paid 的模型 | 换 Free 可用模型，或升级 Paid |
| 超出免费额度、请求失败 | Free 每天 10,000 Neurons，00:00 UTC 重置 | 等重置，或升级 Workers Paid |
| sub2api 报 404 / 空回复 | 上游被当成 Responses 转发 | 设 `openai_responses_mode: force_chat_completions`，且客户端只走 `/v1/chat/completions` |
| `content` 为空 | reasoning 模型输出在 `reasoning_content` | 本 Worker 已自动归一；若仍为空改用非 reasoning 模型 |
| 本地 `wrangler dev` 报 unknown argument | wrangler 4 没有 `--local-strict` | 用 `npm run dev` 或 `npx wrangler dev --local` |

---

# 六、额度与安全边界

- Workers **Free** 计划每天 **10,000 Neurons** 免费，00:00 UTC 重置，**超额直接失败**（不能按量付费）。默认 `max_tokens` 钳制在 512。
- 若要给多人分发 key，先升级 **Workers Paid**（$5/月起，仍含 10,000 免费 Neurons/天，超出按 `$0.011 / 1,000 Neurons` 计费），并在 sub2api 侧配好每用户速率与并发限制。
- `GATEWAY_KEY` 是 sub2api 与 Worker 之间的共享密钥，跟 Cloudflare 令牌分开；泄露只影响这层网关。
- 上游 URL 的 host 是硬编码常量，不取自请求输入；发请求前用 `assertSafeUpstreamUrl()` 校验协议（仅 https）、allowlist，并拒绝 `localhost`、环回、私有、链路本地、保留 IPv4/IPv6 与 URL 内嵌凭据。
- 只支持 Chat Completions（含 SSE 流式）。

---

# 七、已验证结果

本地 `wrangler dev --local` + 真实 Workers AI 账户：

| 检查 | 结果 |
| --- | --- |
| `npm test`（离线，mock 上游） | **25/25 通过** |
| `/health`、`/v1/models` | 200 |
| 无鉴权 / 错误 key | 401 |
| `/v1/responses`、未知模型 | 404 / 400 |
| `gpt-4o-mini` → `llama-3.3-70b` | 200，`content: "pong"`，1.48 Neurons |
| `gpt-4o` → `gemma-4-26b` | 200，`content: "pong"`，1.20 Neurons |
| 原始 `@cf/zai-org/glm-4.7-flash`（reasoning） | 200，`reasoning` 已归一到 `content` |
| `stream: true` | 200，标准 SSE `chat.completion.chunk` |
| 源码 / 示例 / 测试凭据字面量扫描 | clean |

---

## 目录结构

```
CF_AOG/
├── src/worker.js            # Worker 主体（URL 安全校验、别名映射、SSE 归一）
├── wrangler.toml            # Wrangler 配置（仅非敏感默认值）
├── package.json             # 含 cloudflare.bindings 说明，供一键部署引导页展示
├── .dev.vars.example        # 一键部署读取的 secrets 声明（占位值，必须提交）
├── .gitignore               # 忽略 .dev.vars / .wrangler / node_modules
├── scripts/smoke.sh         # 本地/线上冒烟脚本
├── tests/gateway.test.mjs   # 25 个离线单元测试
└── README.md
```

## 参考

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers AI OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI 模型目录](https://developers.cloudflare.com/workers-ai/models/)
- [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [sub2api](https://github.com/Wei-Shaw/sub2api)
