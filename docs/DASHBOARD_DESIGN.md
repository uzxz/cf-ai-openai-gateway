# 监控统计工作台 · 设计方案（规划稿，未实现）

> 状态：**设计阶段**。本文只做方案规划与取舍，不包含任何功能代码。`src/worker.js` 当前行为不变。
> 目标：给 CF_AOG 增加一个「自己能看到用量」的 Web 工作台，用于回答四个问题 ——
> **用了多少、还剩多少额度、哪个模型最费、有没有异常/失败**。

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

预置查询（参数化，不接受任意 SQL，**避免注入**）：

| 视图 | SQL 聚合 | 返回 |
| --- | --- | --- |
| 今日概览 | `SUM(neurons)`、`SUM(请求数)`、成功率、`AVG(延迟)` | 1 行 |
| 额度进度 | 今日 `SUM(neurons)` / 10,000 | 百分比 + 预计耗尽时间 |
| 时间趋势 | 按小时 `toStartOfHour` 分组 | ≤ 24 行 |
| 模型分布 | 按 `index1` 分组的调用数 / Neurons / 平均 tokens | ≤ 12 行 |
| 错误分布 | 按 `blob1`/`blob4` 分组 | ≤ 10 行 |
| 最近请求 | 按时间倒序，只取元数据 | ≤ 20 行 |

> 一个重要限制：Analytics Engine 的 SQL API 需要 **Account Analytics: Read** 权限的 token；若用 `analytics` SQL binding（Wrangler ≥ 4.145）则在 Worker 内免 token 查询，但需要确认一键部署是否会自动配置该 binding `[INFERENCE]`。**兜底方案**：额外增加一个可选 secret `CF_ANALYTICS_TOKEN`（仅 Account Analytics Read），走 REST SQL API；未配置时工作台显示「查询未配置，写入仍在进行」。

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

`wrangler.toml` 新增（**可选**，有默认值）：

```toml
[[analytics_engine_datasets]]
binding = "AOG_METRICS"
dataset = "cf_aog_metrics"
```

- 一键部署的自动供给支持 Analytics Engine 数据集（官方支持的计算/存储资源之一），但需要在引导页确认资源名 `[INFERENCE]`。
- 老部署（无此 binding）：代码检测 `env.AOG_METRICS` 是否存在，不存在就跳过写入；`/dashboard` 显示「监控未启用，按 README 添加 binding」。
- `.dev.vars.example` **不新增必填 secret**；`CF_ANALYTICS_TOKEN` 作为可选兜底写进文档，不进 secrets 声明（否则一键部署会强制弹框）。

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
1. 页面查询结果在 Worker 内用 `caches.default` 缓存 60 秒；
2. 一次刷新合并成**一条** SQL（用 `UNION ALL` / 多聚合）而不是 6 条；
3. 提供 `METRICS_ENABLED` 开关，可一键关闭写入。

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

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| **P0 设计（本轮）** | 本文 | 用户确认方案与范围 |
| **P1 埋点** | `src/metrics.js` + worker 接入 + 单测 | 26 → 约 32 个测试通过；无 binding 时行为与现在完全一致 |
| **P2 查询 API** | `/dashboard/api/summary`，SQL binding 或 token 兜底 | 本地用 `wrangler dev --remote` 验证能读到数据点 |
| **P3 页面** | `/dashboard` 静态页 + 缓存 + 复制 curl | 浏览器打开能看到今日额度、趋势、模型分布 |
| **P4 文档与部署** | README + docs + 可选 binding + 一键部署回归 | 新一键部署能自动建数据集；老部署不报错 |

---

## 8. 待确认的决策点（需要你拍板）

1. **是否接受新增一个 Analytics Engine binding**（会让 `wrangler.toml` 从「零资源」变成「一个可选资源」）？还是坚持零绑定、改用「本地/外部看板」方案？
2. **查询走哪条路**：优先 `analytics` SQL binding（免 token，但需 Wrangler ≥ 4.145 且一键部署兼容性待验证），还是直接用 `CF_ANALYTICS_TOKEN` REST SQL API（多一个可选 secret，但确定可用）？
3. **页面鉴权**：HTML 页面公开、只有 API 要 key（便于分享只读视图），还是整页都要 key？
4. **是否需要按「调用方」拆分统计**（例如给不同下游分配不同 `GATEWAY_KEY` 前缀）？当前设计只有一把共享 key，无法区分。
5. **保留期 3 个月是否够**？若需要长期趋势，得另外做每日汇总（D1/KV 存日聚合，会引入第二个资源）。

---

## 9. 参考

- [Workers Analytics Engine Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Analytics Engine Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)（20 blobs / 20 doubles / 1 index、16 KB、250 点/请求、保留 3 个月）
- [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Analytics SQL binding（免 token 查询）](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
- [Wrangler `analytics_engine_datasets` 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Deploy buttons 自动资源供给](https://developers.cloudflare.com/workers/platform/deploy-buttons/#automatic-resource-provisioning)
- [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [D1/KV Free 额度](https://developers.cloudflare.com/d1/platform/pricing/)
