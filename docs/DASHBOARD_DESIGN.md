# 监控统计工作台 · 设计说明（已实现）

> 状态：**已定方案并实现**。实现说明见本文 §4.6 与 `README.md` 的「监控工作台」小节。
> 目标：偶尔看看**今天 / 最近几天 / 周 / 月 / 年**用了多少，并支持**自定义日期范围筛选**。
>
> **不出账单的硬前提**：保持 **Workers Free 计划不升级**。Free 下所有资源（含 Analytics Engine）都是「超额即失败，不计费」；$0 费用的保障来自计划本身，而不是某个资源。官方目前明确表示 Analytics Engine「暂不计费」，未来若开始计费，Free 计划仍按硬上限处理（`[INFERENCE]`，非官方承诺）。

---

## 1. 需求与目标

### 1.1 用户故事

| 角色 | 想知道 |
| --- | --- |
| 部署者（你） | 今天消耗了多少 Neurons / 离 10,000 上限还剩多少、什么时候会撞限 |
| 使用者 | 每个模型调用了多少次、成功率、平均延迟、平均 output tokens |
| 排查者 | 最近有哪些 4xx/5xx、是鉴权失败还是上游 403/429、集中在哪个模型 |
| 运维 | sub2api 接进来之后，各模型占比是否合理，要不要调 `max_tokens` |

### 1.2 明确不做的（范围控制）

- ❌ 不做多用户 / 登录体系之外的权限模型（复用现有 `GATEWAY_KEY`）
- ❌ 不做计费、不做对外账单、不做按用户拆分（当前只有一把共享 key）
- ❌ 不记录 prompt / completion 正文（隐私 + 存储成本，见 §6）
- ❌ 不做实时推送（WebSocket / SSE 轮询），首版用「打开页面时拉一次 + 手动刷新」
- ❌ 不引入前端框架 / 构建步骤（保持「零构建、一键部署」的核心卖点）

---

## 2. 关键约束（决定了架构）

| 约束 | 事实（已核实） | 对设计的影响 |
| --- | --- | --- |
| 一键部署 | Cloudflare 会克隆仓库并自动供给 `wrangler.toml` 里声明的资源 | 加一个 binding 是可以的，但必须给默认值，且不能破坏「无资源需求」的轻量定位 |
| Workers Free | 请求 100,000/天、CPU 10 ms/调用、子请求 50/次 | 统计写入必须**非阻塞**、查询要**聚合后返回少量行**，不能在 Worker 里扫全量数据 |
| Workers AI Free | 10,000 Neurons/天，超额直接失败 | 工作台本身**不能消耗 Neurons**（不能调 AI 做摘要） |
| Analytics Engine | Free 含 **100,000 写入/天 + 10,000 读查询/天**，数据保留 **3 个月**；官方目前「暂不计费」，未来按写入点数/查询次数计费 | 最合适的时序存储；但**一旦开始计费**，一次请求写一个点 + 一次页面刷新几条查询会放大成本，需要限流与聚合 |
| D1 / KV | D1 Free 写 100,000 行/天；KV Free 写 **1,000/天** | KV 写额度太小（1,000/天），不适合逐请求计数；D1 可作为备选 |
| SQL 查询 | Workers Analytics Engine 的 SQL API 需要 Account Analytics Read 权限的 token；另有 Analytics SQL binding（Wrangler ≥ 4.145）可在 Worker 内免 token 查询 | **优先用 binding**，避免再引入第四个 secret |

---

## 3. 方案对比与选型

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A. Analytics Engine（推荐）** | `writeDataPoint` 每次请求写一条；页面用 SQL binding 聚合查询 | 专为高基数时序设计、写入非阻塞、Free 额度充足、SQL 聚合能力强、无需新 secret | 官方标注「未来会计费」；数据保留 3 个月；本地 `wrangler dev` 默认丢弃数据点 | ✅ **选它** |
| B. KV 计数器 | 按 `date:model` 原子累加 | 实现最简单 | KV Free **写 1,000/天**，逐请求写必爆；最终一致性导致计数不准 | ❌ |
| C. D1 | 每次请求 INSERT 一行 + 定时聚合 | 关系型、可控 | 写 10 万行/天上限、需要建表迁移、每次请求多一次 DB 往返、增加 CPU | ⚠️ 备选（需要精确审计时） |
| D. 纯内存 / Durable Object | DO 里维护计数器 | 精确、低延迟 | 引入 DO 绑定、一键部署复杂度上升、重启/迁移易丢数据 | ❌ |

**最终选型：A（Analytics Engine）+ 一个静态 HTML 页面**，且做成**可选绑定**（见 §4.5）：未配置 binding 时网关功能完全不变，工作台显示「未启用」。

> 为什么强调「可选」：本项目卖点是零基础设施、一键部署。加一个必需 binding 会让已经部署过的用户必须重新配置。可选绑定让老用户无感，新用户可选开启。

---

## 4. 详细设计

### 4.1 数据模型（一条 data point / 一次推理请求）

`writeDataPoint` 上限：20 blobs、20 doubles、1 index，blobs 总计 ≤ 16 KB，单次调用最多 250 个点。我们只用 1 个点/请求。

| 字段 | 存什么 | 用途 |
| --- | --- | --- |
| `indexes[0]` | 模型别名（如 `gpt-4o-mini`），≤ 96 字节 | 按模型分组；**不**用请求级高基数 ID 做 index |
| `blobs[0]` | HTTP 状态类别（`ok` / `client_error` / `upstream_error`） | 成功率、错误分布 |
| `blobs[1]` | 上游原始模型名（`@cf/...`） | 别名 ↔ 真实模型对照 |
| `blobs[2]` | 流式标志（`stream` / `sync`） | 区分 SSE |
| `blobs[3]` | 错误码摘要（如 `403`、`5028`、`unauthorized`），**截断** | 排错；不含响应正文 |
| `doubles[0]` | `usage.neurons` | **核心指标**：额度消耗 |
| `doubles[1]` | `prompt_tokens` | 输入规模 |
| `doubles[2]` | `completion_tokens` | 输出规模（成本主因） |
| `doubles[3]` | 端到端延迟 ms（Worker 内 `Date.now()` 差值） | 性能 |
| `doubles[4]` | `1`（请求计数） | 便于 `SUM` |

**不记录**：prompt / completion 文本、完整 `Authorization`、`CF_AI_TOKEN`、客户端 IP、原始请求体。

### 4.2 写入路径（在现有 `fetch` 里最小侵入）

```
请求进入 → 鉴权 → 转发上游 → 拿到 usage → 组装 data point
        → ctx.waitUntil( 或 非阻塞 writeDataPoint ) → 返回原响应
```

关键原则：
- **统计失败绝不影响推理**：`writeDataPoint` 不 `await`，用 try/catch 包住，任何异常都吞掉。
- **不增加可感知延迟**：写入是非阻塞的。
- **流式也要记**：SSE 场景上游通常只在最后一个 chunk 给 `usage`；若拿不到，退化为「记录请求数 + 状态，Neurons 记 0 并单独标记」，在工作台注明「流式用量可能低估」。这是一个需要在实现时确认的细节 `[INFERENCE]`。
- 健康检查 `/health`、`/v1/models`、401、404 **不写**（避免污染指标）。

### 4.3 查询路径

工作台页面 `GET /dashboard` 返回静态 HTML（内联 CSS/JS，无外部依赖、无构建）。
页面 JS 调 `GET /dashboard/api/summary?range=24h`（携带与网关相同的 Bearer key），Worker 用 **Analytics SQL binding** 执行预置聚合 SQL，返回小 JSON。

预置查询（`analytics` SQL binding，**全部参数化**，不接受任意 SQL）：

| 视图 | SQL 聚合 | 返回 |
| --- | --- | --- |
| 概览 | `SUM(neurons)`、`SUM(请求数)`、成功率、`AVG(延迟)` | 1 行 |
| 时间趋势 | 按小时 / 天分组（依所选范围自动选桶） | ≤ 31 行 |
| 模型分布 | 按 `index1` 分组的调用数 / Neurons / 平均 tokens | ≤ 12 行 |
| 错误分布 | 按 `blob1`/`blob4` 分组 | ≤ 10 行 |

> **实现修正**：Analytics Engine 的 SQL **不支持 `UNION` / `JOIN`**（官方文档明确「queries can only operate on a single table」），因此设计稿里「合并成一条 SQL」的假设**不成立**。实际实现为 **4 条独立聚合查询 + 60 秒 `caches.default` 缓存 + 页面最小刷新间隔**。以「偶尔看」的频率，每次刷新 4 次读查询，远低于 Free 的 10,000 次/天。

> 查询走 **`analytics` SQL binding**（`[analytics] binding = "ANALYTICS_SQL"`，需 Wrangler ≥ 4.145，本项目 4.158 满足）：Worker 内免 token 查询，作用域自动限定为该账户，**不需要新增第四个 secret**。数据集引用名 `events.analyticsEngine."cf_aog_metrics"`，列名仍是 `index1` / `blob1` / `double1`。未配置该 binding 时降级显示「查询未配置，写入仍在进行」。

### 4.4 页面内容（低保真布局）

```
┌─────────────────────────────────────────────────────────┐
│ CF_AOG · 监控工作台        [24h ▾] [刷新]  [复制 curl]   │
├─────────────────────────────────────────────────────────┤
│ 今日 Neurons  3,842 / 10,000  ███████░░░ 38%            │
│ 请求 1,204  │ 成功率 99.2%  │ 平均延迟 1.8s  │ 错误 10 │
├─────────────────────────────────────────────────────────┤
│ 用量趋势（每小时 Neurons）        │  模型分布（Top 5）   │
│      ▁▃▅▇▆▄▂▁ …                │  gpt-4o-mini  62%    │
│                                  │  qwen3-30b    18% …  │
├─────────────────────────────────────────────────────────┤
│ 模型      调用  Neurons  In/Out  P50延迟  错误           │
│ gpt-4o-m…  842   2,310   12/180  1.6s     2             │
├─────────────────────────────────────────────────────────┤
│ 最近错误：403 kimi-k2.7-code ×3（Free 计划不可用）       │
└─────────────────────────────────────────────────────────┘
```

视觉：单页、深色/浅色自适应、纯 CSS 条形图（不引图表库）、移动端可用、无外部 CDN 请求。
「复制 curl」生成一条带 `GATEWAY_KEY` 占位符的测试命令，方便直接验证。

### 4.5 配置与一键部署兼容

`wrangler.toml` 里保留两段**默认注释掉**的配置（需要时手动启用）：

```toml
# [[analytics_engine_datasets]]
# binding = "AOG_METRICS"
# dataset = "cf_aog_metrics"

# [analytics]
# binding = "ANALYTICS_SQL"
```

> **实测教训（2026-11-09）**：Analytics Engine 需要在账户级**先手动启用**。若未启用就声明 `analytics_engine_datasets` binding，`wrangler deploy` 会直接失败并返回 `You need to enable Analytics Engine.`，**整个部署中断**（连推理都上不了线）。因此默认配置不声明 binding，改为文档化的三步启用流程。这是设计稿里标 `[INFERENCE]` 却没能提前验证的点，现已修正。

- Analytics Engine 数据集只需 `binding` + `dataset`，**不需要预创建资源 ID**；表在首次写入时自动创建。
- 未启用时：代码检测 `env.AOG_METRICS` / `env.ANALYTICS_SQL` 不存在，自动跳过写入 / 显示「未启用」，网关功能完全不变。
- `.dev.vars.example` **不新增 secret**，一键部署仍只填原来的 3 个值。
- 可选开关 `METRICS_ENABLED = "false"` 可一键关闭写入。

### 4.6 新增文件规划

| 文件 | 内容 |
| --- | --- |
| `src/metrics.js` | 组装 / 写入 data point、预置 SQL 常量（与 worker.js 解耦） |
| `src/dashboard.js` | 返回内联 HTML 字符串（无外部资源） |
| `src/worker.js` | 仅增加 3 处：路由分发、调用 `record()`、调用 `summary()` |
| `wrangler.toml` | 增加可选 `analytics_engine_datasets` |
| `tests/metrics.test.mjs` | mock binding，验证写入字段、失败不影响主流程、SQL 参数化 |
| `docs/DASHBOARD.md` | 启用步骤、额度说明、SQL 示例、隐私说明 |
| `README.md` | 新增「监控工作台」小节 |

---

## 5. 额度与成本影响（重要）

| 项 | Free 上限 | 本方案用量 | 结论 |
| --- | --- | --- | --- |
| Analytics Engine 写入 | 100,000 点/天 | 每次推理 1 点（≈ 1,800 点/天典型） | 充裕 |
| Analytics Engine 查询 | 10,000 次/天 | 每次页面刷新约 5~6 条聚合 SQL | 充裕；但**需给页面加最小刷新间隔**（如 30s）并缓存 60s，防止误刷爆 |
| Worker 请求 | 100,000/天 | `/dashboard` + API 各 1 次 | 可忽略 |
| Worker CPU 10 ms | 组装 data point + 少量 JSON 解析 | 远低于 10 ms | 可忽略 |
| Workers AI Neurons | 10,000/天 | **0**（工作台不调 AI） | 不影响核心额度 |

**风险点**：官方明确 Analytics Engine「未来会开始计费」（Paid 1000 万写入/月 + 100 万查询/月包含，超出 $0.25/百万写入、$1/百万查询）。届时的成本放大点是「每次页面刷新 = 多次读查询」。缓解：
1. 页面查询结果在 Worker 内用 `caches.default` 缓存 **60 秒**；
2. 一次刷新合并为 **4 条聚合 SQL**（Analytics Engine 不支持 UNION/JOIN，无法合成 1 条），每条都带 `LIMIT`、返回少量行；
3. 页面设**最小刷新间隔 30 秒**，「偶尔看」的场景下用量极低；
4. 提供 `METRICS_ENABLED` 开关，可一键关闭写入。

---

## 6. 隐私与安全

- **不记录 prompt / completion 正文**：工作台只存元数据与数值。这是与「AI Gateway 日志」最关键的区别，也避免 16 KB blob 上限被内容撑爆。
- `GATEWAY_KEY` 校验复用现有 `timingSafeEqual`，`/dashboard` 与 `/dashboard/api/*` 都要鉴权（页面本身可公开，API 必须带 key）。
- 所有 SQL **预置 + 参数化**（时间范围用 `params`），不接受客户端传入 SQL 字符串。
- `blobs[3]` 错误摘要要截断并转义，避免把上游返回的敏感文本带进存储。
- 上游 host 校验逻辑不变；工作台不得成为新的 SSRF 入口（不发起任何由用户输入决定目标的 fetch）。
- 页面不加载外部 CDN 资源（CSP 可设为 `default-src 'self'`）。

---

## 7. 分阶段实施计划

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| **P0 设计** | 本文 | ✅ 已完成，方案经用户确认 |
| **P1 埋点** | `src/metrics.js` + worker 接入 + 单测 | ✅ 已实现 |
| **P2 查询 API** | `/dashboard/api/summary`，`analytics` SQL binding，日期范围参数 | ✅ 已实现 |
| **P3 页面** | `/dashboard` 静态页 + 今天/7天/30天/本年/自定义筛选 + 缓存 | ✅ 已实现 |
| **P4 文档与部署** | README 启用步骤、可选 binding、两仓库同步 | ✅ 已实现 |

---

## 8. 已定方案（用户已确认）

用户要求：**偶尔看看今天 / 最近几天 / 周 / 月 / 年用了多少，并支持筛选日期范围**，且**不产生额外费用**。据此确定：

| # | 决策 | 结论 | 落实方式 |
| --- | --- | --- | --- |
| 1 | 是否新增 binding | ✅ 接受，但**可选** | 无 binding 时网关行为完全不变，看板显示「未启用」 |
| 2 | 查询通道 | ✅ **`analytics` SQL binding（零新增 secret）** | `[analytics] binding = "ANALYTICS_SQL"`；不做 token 兜底 |
| 3 | 页面鉴权 | ✅ **整页 + API 都要 `GATEWAY_KEY`** | 复用现有 key，用量数据不公开 |
| 4 | 按调用方拆分 | ❌ 不做 | 当前只有一把共享 key，拆分收益为零 |
| 5 | 每日汇总 / 长期趋势 | ❌ 不做，直接用 Analytics Engine 的 **3 个月**保留期 | 日期范围筛选覆盖今天 / 7 天 / 30 天 / 本年 / 自定义 |

**不出账单的硬约束（写进实现）**：

- 保持 **Workers Free** 不升级 —— 这是 $0 的根本保障；
- 查询 **4 条 + 缓存 60 秒 + 页面最小刷新间隔**，防止误刷放大读查询；
- 提供 `METRICS_ENABLED` 开关，可随时关掉写入；
- 工作台**不调用 Workers AI**，不消耗任何 Neurons。

**日期范围口径**：全部按 **UTC**（与 Cloudflare 的 00:00 UTC 重置一致），页面标注「时间为 UTC」，避免与本地日期错位。上年及更早数据超出 3 个月保留期会显示为空，这是预期行为。

---

## 9. 参考

- [Workers Analytics Engine Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Analytics Engine Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)（20 blobs / 20 doubles / 1 index、16 KB、250 点/请求、保留 3 个月）
- [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Analytics SQL binding（免 token 查询）](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
- [Wrangler `analytics_engine_datasets` 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Deploy buttons 自动资源供给](https://developers.cloudflare.com/workers/platform/deploy-buttons/#automatic-resource-provisioning)
- [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [D1/KV Free 额度](https://developers.cloudflare.com/d1/platform/pricing/)
