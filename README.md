# CF_AOG — Cloudflare Workers AI OpenAI Gateway

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uzxz/CF_AOG)

把 **Cloudflare Workers AI** 包装成**标准 OpenAI-compatible 上游**，供 [sub2api](https://github.com/Wei-Shaw/sub2api) 之类的网关直接接入。

- **一键部署**：点上面的按钮，在 Cloudflare 引导页填 3 个值即可（约 2 分钟）。
- **零基础设施**：一个 Worker，不需要 KV / D1 / R2 / 服务器。
- **凭据隔离**：Cloudflare API 令牌只存在 Worker Secret 里，不下发给下游客户端。
- **额度保护**：默认把 `max_tokens` 钳制在 512，防止一次请求耗尽每日免费额度。
- **监控工作台**：用量 / 额度 / 模型分布 / 错误统计的自带看板，支持今天/周/月/年与自定义日期范围，见[监控工作台](#监控工作台)。

---

## 为什么需要它

### 先说「免费」到底能做什么

Cloudflare Workers AI 的 **Free 计划每天送 10,000 Neurons**（00:00 UTC 重置），不用信用卡、不按小时计费、不限流量带宽。本仓库收录的 10 个底层模型全部实测在 Free 上可用，把额度换算成实际工作量大约是：

| 工作类型 | 单次实测消耗 | 每天 10,000 Neurons 能做多少 |
| --- | --- | --- |
| 短问答 / 分类 / 打标（约 150 output tokens） | 5.6 Neurons | **约 1,800 次** |
| 一篇几百字的总结或改写（约 500 output tokens） | 约 18 Neurons | **约 550 篇** |
| 写一段完整短文 / 邮件（约 2,200 output tokens） | 80 Neurons | **约 120 篇** |
| 向量化一条短文本（`@cf/baai/bge-m3`） | 0.026 Neurons | **约 38 万条** |
| 生成一张 512×512 图（4 steps） | 约 43 Neurons | **约 230 张** |

也就是说：**一个人、一个小团队、一个副业项目，日常 AI 用量基本花不完免费额度**；就算真超了，Free 是「直接失败」而不是偷偷扣费，升级 Paid 后超出部分也只要 `$0.011 / 1,000 Neurons`。这套东西的价值不是「便宜」，而是**把一堆零散的 AI 小需求，用一个不需要运维、不会突然产生账单的端点全部接住**。

### 具体能拿来做什么（都是真实可落地的例子）

**1. 给现有软件塞一个「AI 按钮」，零改造**
很多应用只认 OpenAI 格式（`base_url` + `api_key` + `model`）。把 `base_url` 指向本 Worker，就能直接用上免费模型，代码一行不改：

- 博客 / 文档站的「AI 摘要」「相关文章推荐」「术语解释」
- 后台管理系统的「把这段日志翻译成人话」「根据表格生成一段说明」
- 客服工单系统里的「自动回复草稿」「情绪与优先级判定」
- 笔记 / 知识库工具的「给当前页面生成 3 个复习问题」

配 `granite-4-micro`（实测单次 0.07 Neurons）跑这类轻量任务，一天几千次也几乎不消耗额度。

**2. 批量结构化处理（最划算的一类）**
任务窄、输出短，正好卡在免费额度最甜的位置：

- 把一堆商品评论 / 问卷 / 工单批量打上 `{"sentiment": "...", "category": "...", "priority": "..."}` 的 JSON
- 从邮件、简历、发票文本里抽取固定字段
- 给爬虫抓来的网页做标题归一化、去重、关键词提取
- 每天定时把新增内容分类后写进表格或数据库

用 `gpt-4o-mini`（`llama-3.3-70b`）或 `mistral-small-3.1` + 强制 `max_tokens`，每天能处理上千条，成本为零。

**3. 个人 / 小团队助手**
- Telegram / 飞书 / Slack 群机器人：群内问答、每日简报、链接摘要、待办提醒
- 命令行小工具：`git diff | ai "写一句 commit message"`、README 生成、报错解释
- CI 里的 PR 摘要与风险提示、单测草稿生成
- 多语言翻译、润色、改写

因为 Worker 隐藏了真实的 Cloudflare 令牌，这些脚本里只需要放一个自己生成的 `GATEWAY_KEY`。

**4. RAG / 语义检索**
Workers AI 的 embedding 模型极便宜（一条短文本 0.026 Neurons）。把文档、笔记、产品资料向量化后配合 Vectorize 做检索，问答时只把命中的片段交给生成模型：一次性索引几万条也几乎不花额度，日常问答又是短输出。适合做「私人知识库」「站内语义搜索」「客服 FAQ 匹配」。

**5. 多模型试验台，不用管账号和计费**
收录了 10 个不同定位的免费模型，可以一个 `model` 参数就横向对比效果：

| 想干什么 | 用哪个别名 |
| --- | --- |
| 通用稳妥、要 `content` 直接有值 | `gpt-4o-mini` / `gpt-4o` |
| 中文、推理、复杂一点的题 | `qwen3-30b` / `glm-4.7-flash` |
| 代码、需要推理链 | `gpt-oss-120b` / `gpt-oss-20b` |
| 长文本、质量优先 | `nemotron-3-120b` |
| 高并发低成本、简单任务 | `granite-4-micro` / `llama-4-scout` |

不用为每个模型单独注册账号、不用配多套 key，也不用担心试错产生费用。

### 那为什么还需要这一层网关

上面这些事，直接用 Cloudflare 的 `/ai/v1` 也能做 —— 但**塞进现成工具链时会踩四个坑**（均已用真实账户实测）：

| 坑 | 实测结果 | 本 Worker 的解法 |
| --- | --- | --- |
| sub2api / 各类客户端默认转成 Responses API 转发 | Cloudflare `/ai/v1/responses` 用标准 `input` 字段返回 **400** | 只对外提供 `/v1/chat/completions`，并在 sub2api 强制 `force_chat_completions` |
| Cloudflare 没有模型列表 | `GET /ai/v1/models` → **405**，POST → 400 | 补齐 `/v1/models`，sub2api 能直接拉取 |
| 模型名不兼容 | 下游发 `gpt-4o-mini`，Cloudflare 只认 `@cf/...` | 内置 12 个别名映射，也允许直接传 `@cf/...` |
| reasoning 模型输出空白 | `glm-4.7-flash` / `gpt-oss-20b` 的输出在 `reasoning_content`，`content` 为 `null` | 非流式与 SSE 都把 `reasoning_content` / `reasoning` 归一到 `content` |

**一句话**：Cloudflare 提供的是「便宜好用的模型」，本 Worker 把它变成「任何 OpenAI-compatible 工具都能直接插上、且不会突然出账单的标准插座」。附带还有：隐藏真实 Cloudflare 令牌、限制 `max_tokens` 保护免费额度、发请求前做 host 安全校验（拒绝 `localhost` / 环回 / 私有 / 保留地址）、上游错误码原样透传。

### 和其他「免费模型」比：以 opencode 为例

结论：**Cloudflare 是「有公开配额、可被调用的免费 API」，opencode 免费模型是「限时、限客户端、不公开额度的试用」**。两者不是一类东西 —— opencode 按官方规定**不能从 OpenCode 之外调用**，因此无法作为本项目的上游。

| 对比项 | Cloudflare Workers AI Free | opencode 免费模型 |
| --- | --- | --- |
| 定位 | 正式的免费额度（serverless 推理 API） | 限时反馈/试用，非永久服务，列表会轮换 |
| **能否从自己的代码调用** | ✅ 标准 REST / OpenAI 兼容端点 | ❌ 官方明确禁止；外部调用返回 403 `FreeTierError`，带 API key 也一样 |
| 额度是否公开 | ✅ **10,000 Neurons/天** + 按任务类型的 RPM 白纸黑字 | ❌ 只说「有每日请求上限」，数字动态、不公开 |
| 速率限制 | 文本生成 **300 次/分钟**、Embeddings 3000/分钟、文生图 720/分钟；部分小模型另有单独限额 | 未公开；社区实测另有短时频率上限 |
| 计量方式 | Neurons（按模型 input/output 折算，响应直接给 `usage.neurons`） | 请求次数，按**出口 IP** 分桶，免费模型共享同一个桶 |
| 重置 | 00:00 UTC | 00:00 UTC（同样按 UTC，容易与本地日期错位） |
| 共享影响 | 不按 IP 共享，是你账户自己的额度 | 同出口 IP 的其他用户用完会连累你（校园网 / 办公网 / VPN 常见） |
| 超额后果 | 直接失败，**不会扣费** | 429 + `retry-after`（最长 24h），引导升级 Go（$10/月起） |
| 升级路径 | Workers Paid $5/月，仍含 10,000/天，超出按 `$0.011 / 1,000 Neurons` | Go $10/月（Go Plus $40/月），按 5 小时 / 周 / 月窗口计 |
| 模型稳定性 | 目录稳定，弃用提前公告 | 每个都标「for a limited time」，无结束日期 |
| 能力 | 文本、embedding、图像、ASR、翻译、分类等 | 主要面向编码 agent，200K 上下文、无 vision |
| 数据条款 | 按 Cloudflare 账户条款 | 部分免费模型明确「数据可能用于改进模型 / 保留 30 天 / 不要提交机密」 |
| 可观测性 | dashboard 可查 Neuron 用量 | 无剩余额度计数器，只能从 429 推断 |

**Cloudflare Free 的三层限制**（都会「超额即失败」而非扣费）：

1. **Neurons**：10,000/天 —— 对本网关是实际瓶颈；
2. **按任务速率**：文本生成 300 RPM（要连续跑满 33 分钟才会先撞到它，Neurons 早用完了）；
3. **Worker 运行时**：请求 100,000/天、CPU 10 ms/调用、子请求 50/次。

另外 `kimi-k2.7-code`、`glm-5.2`、`kimi-k2.6` 在 Free 上直接 403（error 5035），需 Paid。

**opencode 侧的数字仅供说明，不是承诺**：官方 Go FAQ 只说「free models have a daily request limit」；社区 issue 与第三方实测记录到约 **168 ~ 939 次/天**的波动（维护者公开表示额度随容量与需求动态调整），2026-10 后明显收紧。这些内容来自社区实测，可能随时变化，请以官方文档为准。

**对本项目意味着什么**：opencode 的免费模型更适合在它自己的客户端里做交互式编码；Cloudflare 这套适合「给自己的程序接入一个稳定、可规划、按官方允许的免费额度运行的小模型后端」。社区里「用代理 / 换 IP 绕过免费额度接进别的客户端」的做法与官方条款冲突，本项目不采用，也不需要 —— Cloudflare 本身就是官方允许的免费 API 用法。

参考：[Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Workers AI Limits](https://developers.cloudflare.com/workers-ai/platform/limits/) · [opencode Free models](https://opencode.ai/docs/models/#free-models) · [Console Models（数据条款）](https://opencode.ai/v2/docs/console/models/) · [Inference API（403）](https://dev.opencode.ai/v2/docs/console/api/inference) · [Go FAQ](https://opencode.ai/console/go) · [社区实测](https://github.com/anomalyco/opencode/issues/57540)

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

> ⚠️ **一键部署会克隆出一个新仓库**（如 `cf-ai-openai-gateway`），Workers Builds 连的是那个**副本**，不是源仓库 `CF_AOG`。之后要更新线上代码，请 push 到副本仓库，或在本地用 `npm run deploy` 直接部署。改 secret 也不会触发构建，需一次部署动作。

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

> 这 3 个 secret 由仓库里的 `.dev.vars.example` 声明，Cloudflare 会自动识别并在引导页生成输入框；每个字段的说明来自 `package.json` 的 `cloudflare.bindings`。**必须把每个 `replace-with-...` 占位值换成真实值**，否则 `/v1/models` 能返回但推理会 404。值只会存为 Worker Secret，不会写回仓库。

**3. 点 Create and deploy**

Cloudflare 会克隆仓库、用 Workers Builds 构建并部署。完成后得到：

```
https://cf-ai-openai-gateway.<你的子域>.workers.dev
```

记为 `GATEWAY_URL`。之后往**克隆出来的副本仓库**的 `main` 分支 push 代码会自动重新部署。

**4. 验证**

```bash
curl -s "${GATEWAY_URL}/health"
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
npm test            # 52 个离线测试，mock 上游，不需要任何凭据
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

- 别名：`gpt-4o-mini`（→ `@cf/meta/llama-3.3-70b-instruct-fp8-fast`）、`gpt-4o`（→ `@cf/google/gemma-4-26b-a4b-it`）等 12 个，见[可用模型](#可用模型)
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

## 可用模型

`/v1/models` 返回下列 **12 个别名**（sub2api 拉取模型列表时会自动出现）。全部已用真实账户实测（2026-11-09，Workers Free 计划，HTTP 200）：

| 别名 | → Workers AI 模型 | 特点 |
| --- | --- | --- |
| `gpt-4o-mini` / `llama-3.3-70b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 通用、非 reasoning，默认推荐 |
| `gpt-4o` / `gemma-4-26b` | `@cf/google/gemma-4-26b-a4b-it` | 通用，输出稳定 |
| `llama-4-scout` | `@cf/meta/llama-4-scout-17b-16e-instruct` | 轻量通用，便宜 |
| `mistral-small-3.1` | `@cf/mistralai/mistral-small-3.1-24b-instruct` | 通用，非 reasoning |
| `nemotron-3-120b` | `@cf/nvidia/nemotron-3-120b-a12b` | 大模型，质量高、单价也高 |
| `glm-4.7-flash` | `@cf/zai-org/glm-4.7-flash` | 推理型，输出已归一到 `content` |
| `gpt-oss-120b` / `gpt-oss-20b` | `@cf/openai/gpt-oss-*` | OpenAI 开源推理模型 |
| `qwen3-30b` | `@cf/qwen/qwen3-30b-a3b-fp8` | 推理型，中文较好 |
| `granite-4-micro` | `@cf/ibm-granite/granite-4.0-h-micro` | 极小极便宜（实测 0.07 Neurons） |

**不含**：`@cf/moonshotai/kimi-k2.7-code`、`@cf/zai-org/glm-5.2`（实测 403 / error 5035，需 Workers Paid）；升级 Paid 后可自行加入。

**直接用原始模型名**：除别名外，也可在请求里传任意 `@cf/...` 模型名（如 `@cf/openai/gpt-oss-20b`），Worker 会原样转发 —— 只是这些名字不会出现在 `/v1/models` 列表里。

## 增删模型

编辑 `src/worker.js` 顶部的 `MODEL_MAP`，加一行即可，`/v1/models` 与 sub2api 的模型列表自动同步：

```js
const MODEL_MAP = Object.freeze({
  "gpt-4o-mini": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "my-model": "@cf/xxx/yyy",   // ← 新增
  // ...
});
```

改完 `npm test`，push 后 Workers Builds 自动部署（或手动 `npm run deploy`）。完整清单见 [Workers AI 模型目录](https://developers.cloudflare.com/workers-ai/models/)。

## 监控工作台

访问 `https://<你的 Worker>/dashboard`，输入 `GATEWAY_KEY` 即可看到用量看板（整页与 API 都需要鉴权，key 只存在浏览器 `sessionStorage`）。

**支持的范围筛选**：今天、近 7 天、近 30 天、本年、**自定义起止日期**（含首尾，最长 92 天，与 Analytics Engine 3 个月保留期一致）。全部按 **UTC** 计算，与 Cloudflare 00:00 UTC 重置一致 —— 页面顶部有显著标注。

**显示内容**：所选范围的 Neurons 消耗、请求数、成功率、Input/Output tokens、平均延迟、按天用量趋势、模型分布（调用数 / Neurons / 占比）、错误分布；「今天」范围额外显示 10,000 Neurons/天 的额度进度条。

**启用方式**（**默认关闭**，因为 Analytics Engine 需要账户级手动启用，否则部署会直接失败）：

> ⚠️ 若在未启用时声明 binding，`wrangler deploy` 会报 `You need to enable Analytics Engine.`，**整个部署失败**（连推理都上不了线）。因此仓库里的 `wrangler.toml` 默认把这两段**注释掉**，保证首次部署 / 一键部署 / 自动构建 100% 成功。

三步启用：

1. 打开 `https://dash.cloudflare.com/<你的账户 ID>/workers/analytics-engine`，点击启用（Free 计划含 100,000 写入/天 + 10,000 查询/天，当前不计费）；
2. 取消 `wrangler.toml` 里这两段注释：

```toml
[[analytics_engine_datasets]]
binding = "AOG_METRICS"
dataset = "cf_aog_metrics"

[analytics]
binding = "ANALYTICS_SQL"
```

3. 重新部署（push 后 Workers Builds 自动部署，或 `npm run deploy`）。

- Analytics Engine 数据集**不需要预创建**，表在首次写入时自动生成；`ANALYTICS_SQL` 是 Wrangler ≥ 4.145 的免 token 查询 binding。
- `.dev.vars.example` **不新增任何 secret**，一键部署仍只填原来的 3 个值。
- 不启用监控时：网关推理、`/v1/models`、`/health` 全部正常，只有 `/dashboard` 显示「监控未启用」。
- 设 `METRICS_ENABLED = "false"` 可一键关闭写入。

**为什么不会产生额外费用**：

- 只要保持 **Workers Free 不升级**，所有资源都是「超额即失败，不计费」—— 这是 $0 的根本保障。
- Workers Analytics Engine Free 含 **100,000 写入/天 + 10,000 读查询/天**；本方案每次推理写 1 个点、每次看板刷新 4 条聚合 SQL + 60 秒缓存 + 30 秒最小刷新间隔，以「偶尔看」的频率用量极低。
- 工作台**不调用 Workers AI**，不消耗任何 Neurons。
- 官方目前明确表示 Analytics Engine「暂不计费」；未来若开始计费，Free 计划仍按硬上限处理（此为 `[INFERENCE]`，非官方承诺）。

**隐私**：只记录模型别名、状态类别、错误码摘要、Neurons、tokens、延迟等**元数据**；不记录 prompt / completion 正文、不记录 token / IP。SQL 全部是静态常量 + 官方 `$1/$2` 位置参数绑定，不接受客户端传入的 SQL。

**已知限制**：

- 数据保留 **3 个月**，更早的范围会显示为空（本年视图可能因此缺前几个月）。
- **SSE 流式请求的 Neurons 记为 0**：上游 usage 在最后一个 chunk，Worker 不缓冲整条流；流式用量会被低估，页面相应位置有说明。
- 本地 `wrangler dev --local` 下 `ANALYTICS_SQL` 无本地实现（总是访问远端），看板会显示「部分统计不可用」但不会 500；要看真实数据请部署后用线上地址访问。
- 详细设计见 [docs/DASHBOARD_DESIGN.md](docs/DASHBOARD_DESIGN.md)。

---

# 五、排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一键部署按钮打不开 / 提示仓库不可用 | 仓库是 private，或 URL 不是 `github.com` | 把仓库设为 **Public** |
| 引导页没有 secret 输入框 | `.dev.vars.example` 没被提交（曾被 `.gitignore` 误伤） | 确认文件在仓库根目录且已 commit |
| 部署成功但请求返回 `500 gateway not configured` | secret 没配好 | dashboard → Worker → Settings → Variables and Secrets，或用 `wrangler secret put` 补齐 3 个值 |
| 报错 `Could not route to /client/v4/accounts/replace-with-your-cloudflare-account-id/...` 或 `error 7003` | **`CF_ACCOUNT_ID` 仍是 `.dev.vars.example` 的占位值**，一键部署时没替换 | dashboard → Worker → Settings → Variables and Secrets 把 3 个 secret 都改成真实值；**改完需重新部署一次**。新版本会直接返回 `upstream credentials are still placeholder values` 并列出未填的字段 |
| `/v1/models` 只有 2 个模型 | 旧版本硬编码了 2 个别名 | 更新到最新版本（12 个），重新部署后在 sub2api 重新拉取模型列表 |
| push 到 `CF_AOG` 后线上没变化 | 一键部署克隆了**副本仓库**，Workers Builds 连的是副本 | push 到克隆出来的副本仓库；或本地 `npm run deploy`；或在 dashboard 的 Settings → Builds 里改连接的仓库 |
| 改了 secret 但没生效 | 改 secret 不会触发构建 | 手动 Redeploy 一次，或往 production 分支 push 一个 commit |
| 一键部署按钮报「GitHub 授权已过期」 | 账户级 GitHub App 授权失效 | <https://github.com/settings/installations> 卸载并重装 Cloudflare Workers and Pages，再重新打开按钮 |
| 请求返回 401 | `GATEWAY_KEY` 与 sub2api 里填的不一致 | 两边对齐；注意不要带多余空格 |
| 返回 `403 / error 5035` | 用了仅 Workers Paid 的模型 | 换 Free 可用模型，或升级 Paid |
| 超出免费额度、请求失败 | Free 每天 10,000 Neurons，00:00 UTC 重置 | 等重置，或升级 Workers Paid |
| sub2api 报 404 / 空回复 | 上游被当成 Responses 转发 | 设 `openai_responses_mode: force_chat_completions`，且客户端只走 `/v1/chat/completions` |
| `content` 为空 | reasoning 模型输出在 `reasoning_content` | 本 Worker 已自动归一；若仍为空改用非 reasoning 模型 |
| `/dashboard` 显示「监控未启用」 | 监控 binding 默认关闭（`wrangler.toml` 里被注释） | 先启用 Analytics Engine，再取消 `wrangler.toml` 里两段注释并重新部署 |
| 部署报 `You need to enable Analytics Engine` | 账户未启用该服务，但配置里声明了 binding | 打开 <https://dash.cloudflare.com/> → Workers → Analytics Engine 启用；或先把 `wrangler.toml` 里那两段注释掉即可恢复部署 |
| 看板显示「部分统计不可用」 | 本地 dev 下 Analytics SQL 无本地实现，或某条查询失败 | 用线上地址访问；查询失败只影响该视图，其他数据照常显示 |
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
| `npm test`（离线，mock 上游） | **52/52 通过** |
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
├── src/worker.js            # Worker 主体（URL 安全校验、别名映射、SSE 归一、路由分发）
├── src/metrics.js           # 埋点与汇总编排（日期范围、缓存、降级）
├── src/ae-sql.js            # 4 条静态参数化 SQL 常量
├── src/ae-params.js         # 日期 → 纯数字位置参数
├── src/ae-query.js          # Analytics SQL binding 执行层
├── src/dashboard.js         # 监控工作台静态页面（内联 CSS/JS）
├── wrangler.toml            # Wrangler 配置（含两个可选监控 binding）
├── package.json             # 含 cloudflare.bindings 说明，供一键部署引导页展示
├── .dev.vars.example        # 一键部署读取的 secrets 声明（占位值，必须提交）
├── .gitignore               # 忽略 .dev.vars / .wrangler / node_modules
├── scripts/smoke.sh         # 本地/线上冒烟脚本
├── tests/gateway.test.mjs   # 26 个网关离线单元测试
├── tests/dashboard.test.mjs # 26 个监控工作台离线单元测试
├── docs/DASHBOARD_DESIGN.md # 监控工作台设计说明
└── README.md
```

## 参考

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers AI OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI 模型目录](https://developers.cloudflare.com/workers-ai/models/)
- [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [sub2api](https://github.com/Wei-Shaw/sub2api)
