import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { record, resolveRange, summary, DAILY_NEURON_ALLOWANCE } from "../src/metrics.js";
import { buildParams } from "../src/ae-params.js";
import { runAll } from "../src/ae-query.js";
import { SQL } from "../src/ae-sql.js";
import { DASHBOARD_HTML } from "../src/dashboard.js";

const ENV = {
  GATEWAY_KEY: "unit-test-gateway-key",
  CF_AI_TOKEN: "unit-test-upstream-token",
  CF_ACCOUNT_ID: "unit-test-account",
  MAX_TOKENS_CAP: "512",
  MAX_TOKENS_DEFAULT: "256",
};

function req(path, { key = ENV.GATEWAY_KEY, body, method = "POST" } = {}) {
  const init = { method, headers: {} };
  if (key != null) init.headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`https://gateway.example.com${path}`, init);
}

function chatResponse(content) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, neurons: 1.5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function withMockUpstream(handler, fn) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return handler(url, init);
  };
  return Promise.resolve()
    .then(() => fn(() => captured))
    .finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------
// 日期范围
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-09T13:45:00.000Z");

test("resolveRange: today 从 UTC 00:00 开始", () => {
  const r = resolveRange(new URLSearchParams("range=today"), NOW);
  assert.equal(r.kind, "today");
  assert.equal(r.from, "2026-11-09T00:00:00.000Z");
  assert.ok(r.to.startsWith("2026-11-09T13:45"));
});

test("resolveRange: 7d / 30d / year", () => {
  const d7 = resolveRange(new URLSearchParams("range=7d"), NOW);
  assert.equal(d7.from, "2026-11-03T00:00:00.000Z");
  assert.equal(d7.label, "最近 7 天");
  const d30 = resolveRange(new URLSearchParams("range=30d"), NOW);
  assert.equal(d30.from, "2026-10-11T00:00:00.000Z");
  const dy = resolveRange(new URLSearchParams("range=year"), NOW);
  assert.equal(dy.from, "2026-01-01T00:00:00.000Z");
  assert.equal(dy.label, "2026 年");
});

test("resolveRange: custom 含首尾、非法值退化为今天", () => {
  const ok = resolveRange(new URLSearchParams("range=custom&from=2026-11-01&to=2026-11-05"), NOW);
  assert.equal(ok.from, "2026-11-01T00:00:00.000Z");
  assert.equal(ok.to, "2026-11-05T23:59:59.999Z");
  assert.equal(ok.label, "2026-11-01 ~ 2026-11-05");
  const bad = resolveRange(new URLSearchParams("range=custom&from=oops&to=2026-11-05"), NOW);
  assert.equal(bad.from, "2026-11-09T00:00:00.000Z");
});

test("resolveRange: custom 超过 92 天被截断", () => {
  const r = resolveRange(new URLSearchParams("range=custom&from=2025-01-01&to=2026-11-09"), NOW);
  const days = (Date.parse(r.to) - Date.parse(r.from)) / 86400000;
  assert.ok(days <= 92.001, `期望 <=92 天，实际 ${days}`);
});

test("resolveRange: 未知 kind 退化为 today", () => {
  const r = resolveRange(new URLSearchParams("range=hack"), NOW);
  assert.equal(r.kind, "today");
});

test("buildParams: 输出纯数字、顺序正确、非法输入抛错", () => {
  const p = buildParams("2026-11-01T00:00:00.000Z", "2026-11-05T23:59:59.999Z");
  assert.equal(p.length, 2);
  assert.equal(typeof p[0], "number");
  assert.equal(typeof p[1], "number");
  assert.equal(p[0], Date.parse("2026-11-01T00:00:00.000Z"));
  assert.equal(p[1], Date.parse("2026-11-05T23:59:59.999Z"));
  assert.throws(() => buildParams("oops", "2026-11-05T00:00:00.000Z"), /invalid/);
  assert.throws(() => buildParams("2026-11-05T00:00:00.000Z", "2026-11-01T00:00:00.000Z"), /invalid/);
});

// ---------------------------------------------------------------------------
// SQL 常量与参数化
// ---------------------------------------------------------------------------

test("SQL 常量是冻结的静态字符串、使用 $1/$2 占位符", () => {
  assert.ok(Object.isFrozen(SQL));
  for (const [name, q] of Object.entries(SQL)) {
    assert.equal(typeof q, "string", name);
    assert.ok(q.includes("$1") && q.includes("$2"), `${name} 应使用位置参数占位符`);
    assert.ok(q.includes('events.analyticsEngine."cf_aog_metrics"'));
    assert.ok(!q.includes("${"), `${name} 不应含模板插值`);
  }
});

test("SQL 不含任何用户可控字符串（无拼接面）", () => {
  for (const q of Object.values(SQL)) {
    assert.ok(q.startsWith("SELECT"));
    assert.ok(!q.includes("+") || q.includes("sum(")); // 只允许聚合里出现 +
  }
});

// ---------------------------------------------------------------------------
// 埋点写入
// ---------------------------------------------------------------------------

test("record: 无 AOG_METRICS 时静默跳过", () => {
  assert.doesNotThrow(() => record(ENV, { alias: "gpt-4o-mini" }));
});

test("record: 写入字段正确、不记录正文", () => {
  let seen = null;
  const env = { ...ENV, AOG_METRICS: { writeDataPoint: (d) => { seen = d; } } };
  record(env, {
    alias: "gpt-4o-mini",
    upstreamModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    statusClass: "ok",
    errorTag: "",
    neurons: 1.5,
    promptTokens: 10,
    completionTokens: 3,
    latencyMs: 123,
    stream: false,
  });
  assert.deepEqual(seen.indexes, ["gpt-4o-mini"]);
  assert.deepEqual(seen.blobs.slice(0, 3), ["ok", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "sync"]);
  assert.deepEqual(seen.doubles, [1.5, 10, 3, 123, 1]);
  assert.ok(!JSON.stringify(seen).includes("secret"));
});

test("record: METRICS_ENABLED=false 时关闭写入", () => {
  let called = false;
  const env = { ...ENV, METRICS_ENABLED: "false", AOG_METRICS: { writeDataPoint: () => { called = true; } } };
  record(env, { alias: "x" });
  assert.equal(called, false);
});

test("record: writeDataPoint 抛错也不影响主链路", () => {
  const env = { ...ENV, AOG_METRICS: { writeDataPoint: () => { throw new Error("boom"); } } };
  assert.doesNotThrow(() => record(env, { alias: "x" }));
});

test("record: 错误标签与 index 被截断", () => {
  let seen = null;
  const env = { ...ENV, AOG_METRICS: { writeDataPoint: (d) => { seen = d; } } };
  record(env, { alias: "a".repeat(300), statusClass: "upstream_error", errorTag: "e".repeat(300) });
  assert.ok(seen.indexes[0].length <= 96);
  assert.ok(seen.blobs[3].length <= 64);
});

// ---------------------------------------------------------------------------
// 查询执行层
// ---------------------------------------------------------------------------

test("runAll: 4 条查询都使用静态 SQL + 纯数字参数", async () => {
  const calls = [];
  const binding = {
    query: async (r) => {
      calls.push(r);
      return { data: [{ neurons: 1 }], rows: 1 };
    },
  };
  const out = await runAll(binding, "2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z");
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.ok(Object.values(SQL).includes(c.query), "query 必须是冻结常量之一");
    assert.equal(c.params.length, 2);
    assert.equal(typeof c.params[0], "number");
    assert.equal(typeof c.params[1], "number");
  }
  assert.equal(out.degraded.length, 0);
  assert.equal(out.overview.neurons, 1);
  assert.equal(out.trend.length, 1);
});

test("runAll: 单条查询失败不影响其他视图", async () => {
  let n = 0;
  const binding = {
    query: async () => {
      n++;
      if (n === 2) throw new Error("trend failed");
      return { data: [], rows: 0 };
    },
  };
  const out = await runAll(binding, "2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z");
  assert.equal(out.degraded.length, 1);
  assert.match(out.degraded[0], /trend/);
  assert.deepEqual(out.trend, []);
  assert.deepEqual(out.models, []);
});

// ---------------------------------------------------------------------------
// 汇总编排与降级
// ---------------------------------------------------------------------------

test("summary: 未配置 ANALYTICS_SQL 时降级", async () => {
  const r = resolveRange(new URLSearchParams("range=today"), NOW);
  const out = await summary(ENV, null, r);
  assert.equal(out.available, false);
  assert.match(out.reason, /ANALYTICS_SQL/);
  assert.equal(out.dailyAllowance, DAILY_NEURON_ALLOWANCE);
});

test("summary: 有 binding 时返回 4 个视图", async () => {
  const binding = { query: async () => ({ data: [], rows: 0 }) };
  const r = resolveRange(new URLSearchParams("range=7d"), NOW);
  const out = await summary({ ...ENV, ANALYTICS_SQL: binding }, null, r);
  assert.equal(out.available, true);
  assert.equal(out.range.kind, "7d");
  assert.deepEqual(out.trend, []);
  assert.deepEqual(out.models, []);
  assert.deepEqual(out.errors, []);
});

// ---------------------------------------------------------------------------
// 工作台路由
// ---------------------------------------------------------------------------

test("/dashboard 未鉴权 -> 401", async () => {
  const res = await worker.fetch(req("/dashboard", { key: null, method: "GET" }), ENV);
  assert.equal(res.status, 401);
});

test("/dashboard 带正确 key -> 200 HTML 且含 CSP", async () => {
  const res = await worker.fetch(req("/dashboard", { method: "GET" }), ENV);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  const html = await res.text();
  assert.ok(html.includes("用量工作台"));
  assert.ok(html.includes("自定义"));
  assert.ok(html.includes("UTC"));
});

test("/dashboard/api/summary 未鉴权 -> 401", async () => {
  const res = await worker.fetch(req("/dashboard/api/summary", { key: null, method: "GET" }), ENV);
  assert.equal(res.status, 401);
});

test("/dashboard/api/summary 未配置 binding -> available:false", async () => {
  const res = await worker.fetch(req("/dashboard/api/summary?range=7d", { method: "GET" }), ENV);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.available, false);
  assert.equal(j.range.kind, "7d");
});

test("/dashboard POST -> 405", async () => {
  const res = await worker.fetch(req("/dashboard", { method: "POST", body: {} }), ENV);
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// 主链路埋点回归
// ---------------------------------------------------------------------------

test("chat/completions 成功时会写入埋点（usage 数值正确）", async () => {
  let seen = null;
  const env = { ...ENV, AOG_METRICS: { writeDataPoint: (d) => { seen = d; } } };
  await withMockUpstream(
    () => chatResponse("pong"),
    async () => {
      const res = await worker.fetch(
        req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }),
        env,
      );
      assert.equal(res.status, 200);
    },
  );
  assert.ok(seen, "应写入一条 data point");
  assert.equal(seen.doubles[0], 1.5);   // neurons
  assert.equal(seen.doubles[1], 10);    // prompt_tokens
  assert.equal(seen.doubles[2], 3);     // completion_tokens
  assert.equal(seen.doubles[4], 1);     // 请求计数
  assert.equal(seen.blobs[0], "ok");
});

test("上游 403 时埋点标记 upstream_error", async () => {
  let seen = null;
  const env = { ...ENV, AOG_METRICS: { writeDataPoint: (d) => { seen = d; } } };
  await withMockUpstream(
    () => new Response(JSON.stringify({ errors: [{ code: 5035, message: "not available" }] }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }),
    async () => {
      await worker.fetch(req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }), env);
    },
  );
  assert.equal(seen.blobs[0], "upstream_error");
  assert.equal(seen.blobs[3], "5035");
});

test("埋点失败不影响推理返回", async () => {
  const env = { ...ENV, AOG_METRICS: { writeDataPoint: () => { throw new Error("boom"); } } };
  await withMockUpstream(
    () => chatResponse("pong"),
    async () => {
      const res = await worker.fetch(
        req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }),
        env,
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).choices[0].message.content, "pong");
    },
  );
});

test("DASHBOARD_HTML 不含外部资源引用", () => {
  assert.ok(!DASHBOARD_HTML.includes("http://"));
  assert.ok(!DASHBOARD_HTML.includes("https://"));
  assert.ok(!/<script[^>]+src=/.test(DASHBOARD_HTML));
  assert.ok(!/<link[^>]+href=/.test(DASHBOARD_HTML));
});
