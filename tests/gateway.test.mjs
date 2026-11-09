import test from "node:test";
import assert from "node:assert/strict";
import worker, { assertSafeUpstreamUrl, rewriteSseLine } from "../src/worker.js";

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

/** 替换全局 fetch，捕获上游请求并返回构造好的 Response。 */
function withMockUpstream(handler, fn) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return handler(url, init);
  };
  return Promise.resolve()
    .then(() => fn(() => captured))
    .finally(() => {
      globalThis.fetch = original;
    });
}

function chatResponse(content, { reasoning = false } = {}) {
  const message = reasoning
    ? { role: "assistant", content: null, reasoning_content: content }
    : { role: "assistant", content };
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// URL 安全校验
// ---------------------------------------------------------------------------

test("assertSafeUpstreamUrl: 放行官方 https 主机", () => {
  const u = assertSafeUpstreamUrl(
    "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
  );
  assert.match(u, /^https:\/\/api\.cloudflare\.com\//);
});

test("assertSafeUpstreamUrl: 拒绝非 http/https 协议", () => {
  for (const scheme of ["javascript:", "file:", "data:", "ftp:"]) {
    assert.throws(
      () => assertSafeUpstreamUrl(`${scheme}//api.cloudflare.com/x`),
      /scheme|https/,
    );
  }
});

test("assertSafeUpstreamUrl: 拒绝 http（要求 https）", () => {
  assert.throws(
    () => assertSafeUpstreamUrl("http://api.cloudflare.com/x"),
    /https/,
  );
});

test("assertSafeUpstreamUrl: 拒绝 localhost 与本地/保留域名", () => {
  for (const host of [
    "localhost", "localhost.", "foo.localhost", "svc.internal",
    "x.local", "y.test", "z.example", "w.invalid",
  ]) {
    assert.throws(
      () => assertSafeUpstreamUrl(`https://${host}/x`, [host]),
      /refused/i,
      host,
    );
  }
});

test("assertSafeUpstreamUrl: 拒绝环回/私有/保留 IPv4", () => {
  for (const host of [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "198.18.0.1", "203.0.113.1",
  ]) {
    assert.throws(
      () => assertSafeUpstreamUrl(`https://${host}/x`, [host]),
      /refused/i,
      host,
    );
  }
});

test("assertSafeUpstreamUrl: 拒绝私有/环回 IPv6", () => {
  for (const host of ["[::1]", "[::]", "[fd00::1]", "[fe80::1]", "[ff02::1]"]) {
    assert.throws(
      () => assertSafeUpstreamUrl(`https://${host}/x`, [host.replace(/\[|\]/g, "")]),
      /refused/i,
      host,
    );
  }
});

test("assertSafeUpstreamUrl: 拒绝不在 allowlist 的主机", () => {
  assert.throws(
    () => assertSafeUpstreamUrl("https://evil.example.com/x"),
    /allowlist/,
  );
});

test("assertSafeUpstreamUrl: 拒绝 URL 内嵌凭据", () => {
  assert.throws(
    () => assertSafeUpstreamUrl("https://user:pass@api.cloudflare.com/x"),
    /credentials/,
  );
});

// ---------------------------------------------------------------------------
// SSE reasoning 归一
// ---------------------------------------------------------------------------

test("rewriteSseLine: reasoning_content 折叠进 content", () => {
  const line =
    'data: {"choices":[{"delta":{"reasoning_content":"hi"},"index":0,"finish_reason":null}]}';
  const out = rewriteSseLine(line);
  const payload = JSON.parse(out.slice(5).trim());
  assert.equal(payload.choices[0].delta.content, "hi");
});

test("rewriteSseLine: [DONE] 与非 data 行原样返回", () => {
  assert.equal(rewriteSseLine("data: [DONE]"), "data: [DONE]");
  assert.equal(rewriteSseLine("event: ping"), "event: ping");
  assert.equal(rewriteSseLine(""), "");
});

// ---------------------------------------------------------------------------
// Worker 端点（mock 上游）
// ---------------------------------------------------------------------------

test("/health 不触达上游", async () => {
  const res = await worker.fetch(req("/health", { method: "GET" }), ENV);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.status, "ok");
  assert.deepEqual(j.models, ["gpt-4o-mini", "gpt-4o"]);
});

test("/v1/models 返回模型列表", async () => {
  const res = await worker.fetch(req("/v1/models", { method: "GET" }), ENV);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.object, "list");
  assert.ok(j.data.some((m) => m.id === "gpt-4o-mini"));
});

test("无 Authorization -> 401", async () => {
  const res = await worker.fetch(req("/v1/chat/completions", { key: null, body: { model: "gpt-4o-mini", messages: [] } }), ENV);
  assert.equal(res.status, 401);
});

test("错误 key -> 401", async () => {
  const res = await worker.fetch(req("/v1/chat/completions", { key: "wrong", body: { model: "gpt-4o-mini", messages: [] } }), ENV);
  assert.equal(res.status, 401);
});

test("未知路径 -> 404", async () => {
  const res = await worker.fetch(req("/v1/responses", { body: { input: "x" } }), ENV);
  assert.equal(res.status, 404);
});

test("GET chat/completions -> 405", async () => {
  const res = await worker.fetch(req("/v1/chat/completions", { method: "GET" }), ENV);
  assert.equal(res.status, 405);
});

test("缺少上游凭据 -> 500", async () => {
  const res = await worker.fetch(req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }), { GATEWAY_KEY: ENV.GATEWAY_KEY });
  assert.equal(res.status, 500);
});

test("不支持的模型 -> 400", async () => {
  const res = await worker.fetch(req("/v1/chat/completions", { body: { model: "claude-3", messages: [] } }), ENV);
  assert.equal(res.status, 400);
});

test("chat/completions: 模型别名映射 + max_tokens 钳制 + 上游鉴权", async () => {
  await withMockUpstream(
    () => chatResponse("pong"),
    async (getCaptured) => {
      const res = await worker.fetch(
        req("/v1/chat/completions", {
          body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "say pong" }], max_tokens: 99999 },
        }),
        ENV,
      );
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.equal(j.choices[0].message.content, "pong");

      const cap = getCaptured();
      assert.match(cap.url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/unit-test-account\/ai\/v1\/chat\/completions/);
      assert.equal(cap.init.headers.Authorization, `Bearer ${ENV.CF_AI_TOKEN}`);
      const sent = JSON.parse(cap.init.body);
      assert.equal(sent.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      assert.equal(sent.max_tokens, 512, "超上限应被钳制到 MAX_TOKENS_CAP");
    },
  );
});

test("chat/completions: 未传 max_tokens 时使用默认值", async () => {
  await withMockUpstream(
    () => chatResponse("pong"),
    async (getCaptured) => {
      await worker.fetch(
        req("/v1/chat/completions", { body: { model: "gpt-4o", messages: [] } }),
        ENV,
      );
      const sent = JSON.parse(getCaptured().init.body);
      assert.equal(sent.model, "@cf/google/gemma-4-26b-a4b-it");
      assert.equal(sent.max_tokens, 256);
    },
  );
});

test("chat/completions: 允许直接传 @cf/ 模型名", async () => {
  await withMockUpstream(
    () => chatResponse("pong"),
    async (getCaptured) => {
      await worker.fetch(
        req("/chat/completions", { body: { model: "@cf/openai/gpt-oss-20b", messages: [] } }),
        ENV,
      );
      const sent = JSON.parse(getCaptured().init.body);
      assert.equal(sent.model, "@cf/openai/gpt-oss-20b");
    },
  );
});

test("chat/completions: reasoning_content 归一到 content", async () => {
  await withMockUpstream(
    () => chatResponse("from reasoning", { reasoning: true }),
    async () => {
      const res = await worker.fetch(
        req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }),
        ENV,
      );
      const j = await res.json();
      assert.equal(j.choices[0].message.content, "from reasoning");
    },
  );
});

test("chat/completions: 上游错误原样透传状态码", async () => {
  await withMockUpstream(
    () => new Response(JSON.stringify({ error: "model not available" }), { status: 403, headers: { "Content-Type": "application/json" } }),
    async () => {
      const res = await worker.fetch(
        req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }),
        ENV,
      );
      assert.equal(res.status, 403);
    },
  );
});

test("chat/completions: 上游网络异常 -> 502", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const res = await worker.fetch(
      req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } }),
      ENV,
    );
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = original;
  }
});

test("chat/completions: 流式 SSE 逐行归一", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"hel"},"index":0,"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"lo"},"index":0,"finish_reason":null}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  await withMockUpstream(
    () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    async () => {
      const res = await worker.fetch(
        req("/v1/chat/completions", { body: { model: "gpt-4o-mini", messages: [], stream: true } }),
        ENV,
      );
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /"content":"hel"/);
      assert.match(text, /"content":"lo"/);
      assert.match(text, /\[DONE\]/);
    },
  );
});
