/**
 * Cloudflare Workers AI -> 标准 OpenAI-compatible 上游适配层
 *
 * 解决的问题（均已用真实账户实测）：
 *  - sub2api 默认把请求转成 Responses API 转发；Cloudflare 的 /ai/v1/responses
 *    不认标准 `input` 字段（返回 400），所以这里对外只提供 chat/completions。
 *  - Cloudflare 没有 /ai/v1/models（GET 405），这里补齐，供 sub2api 同步模型列表。
 *  - 下游客户端发 gpt-4o-mini 之类名字，Cloudflare 只认 @cf/... ，这里做别名映射。
 *  - reasoning 模型把输出放在 reasoning_content / reasoning 而非 content，这里归一。
 *  - 限制 max_tokens，保护 Workers Free 每天 10,000 Neurons 的额度。
 *  - 隐藏 Cloudflare 的真实 API token 与 account id。
 *
 * 凭据：只从 env（wrangler secret / .dev.vars / 运行环境）读取。
 *       源码、示例、测试中不包含任何可用凭据字面量。
 */

const UPSTREAM_HOST = "api.cloudflare.com";

// 别名 -> Workers AI 模型名。这两个模型已用当前账户实测可用（非 reasoning）。
const MODEL_MAP = Object.freeze({
  "gpt-4o-mini": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4o": "@cf/google/gemma-4-26b-a4b-it",
});
const ALIAS_LIST = Object.keys(MODEL_MAP);

/**
 * 发请求前的 URL 安全校验：
 *  - 仅允许 http/https（实际上游强制 https）
 *  - host 必须在 allowlist 内
 *  - 拒绝 localhost、环回、私有、链路本地、保留、组播地址
 *  - 拒绝 URL 内嵌 userinfo
 */
export function assertSafeUpstreamUrl(rawUrl, allowedHosts = [UPSTREAM_HOST]) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid upstream url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("upstream scheme must be http/https");
  }
  if (url.protocol !== "https:") {
    throw new Error("upstream must use https");
  }
  if (url.username || url.password) {
    throw new Error("upstream url must not carry credentials");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new Error("upstream host is empty");

  // 环回 / 本地 / 保留域名：优先级高于 allowlist，避免误配 allowlist 时被绕过。
  // 规范化 FQDN 尾部的点（例如 "localhost."）。
  const canonical = host.replace(/\.+$/, "");
  if (
    canonical === "localhost" ||
    canonical.endsWith(".localhost") ||
    /(^|\.)(local|internal|localdomain|test|example|invalid)$/.test(canonical)
  ) {
    throw new Error("loopback/reserved hostname refused");
  }

  if (!allowedHosts.includes(host) && !allowedHosts.includes(canonical)) {
    throw new Error("upstream host is not allowlisted");
  }

  // IPv4：环回、私有、链路本地、CGNAT、保留、组播、文档网段
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const o = host.split(".").map(Number);
    if (o.some((n) => n > 255)) throw new Error("invalid ipv4");
    const [a, b] = o;
    if (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    ) {
      throw new Error("private/loopback/reserved ipv4 refused");
    }
  }

  // IPv6：环回、未指定、唯一本地、链路本地、组播
  if (host.includes(":")) {
    if (
      host === "::1" || host === "::" ||
      /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || /^ff/i.test(host)
    ) {
      throw new Error("private/loopback/reserved ipv6 refused");
    }
  }

  return url.toString();
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

/** 把 SSE 每行的 delta.reasoning_content / reasoning 折叠进 delta.content。 */
export function rewriteSseLine(line) {
  const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!bare.startsWith("data:")) return line;
  const payload = bare.slice(5).trim();
  if (!payload || payload === "[DONE]") return line;
  try {
    const obj = JSON.parse(payload);
    let changed = false;
    for (const ch of obj.choices || []) {
      const d = ch.delta || {};
      const alt = foldReasoning(d);
      if (d.content == null && alt) {
        d.content = alt;
        changed = true;
      }
    }
    if (!changed) return line;
    const cr = line.endsWith("\r") ? "\r" : "";
    return `data: ${JSON.stringify(obj)}${cr}`;
  } catch {
    return line;
  }
}

function foldReasoning(m) {
  if (typeof m.reasoning_content === "string" && m.reasoning_content.length) {
    return m.reasoning_content;
  }
  if (typeof m.reasoning === "string" && m.reasoning.length) return m.reasoning;
  return null;
}

function normalizeSseStream() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(rewriteSseLine(line) + "\n"));
      }
    },
    flush(controller) {
      buf += decoder.decode();
      if (buf) controller.enqueue(encoder.encode(rewriteSseLine(buf)));
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 健康检查：不触达上游
    if (path === "/health") {
      return json({ status: "ok", upstream: UPSTREAM_HOST, models: ALIAS_LIST });
    }

    // 模型列表：Cloudflare 原生没有，这里补齐
    if (path === "/v1/models" || path === "/models") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({
        object: "list",
        data: ALIAS_LIST.map((id) => ({ id, object: "model", owned_by: "workers-ai" })),
      });
    }

    // sub2api 的 /v1/chat/completions 与 /chat/completions 两个目标都兼容
    const isChat = path === "/v1/chat/completions" || path === "/chat/completions";
    if (!isChat) return json({ error: "not found", hint: "try /v1/chat/completions" }, 404);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

    // 自有网关 key：只来自 env
    const expected = env.GATEWAY_KEY;
    if (!expected) {
      return json({ error: "gateway not configured: GATEWAY_KEY is missing" }, 500);
    }
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!timingSafeEqual(token, expected)) return json({ error: "unauthorized" }, 401);

    // 上游凭据：只来自 env，绝不转发 GATEWAY_KEY
    const cfToken = env.CF_AI_TOKEN;
    const accountId = env.CF_ACCOUNT_ID;
    if (!cfToken || !accountId) {
      return json({ error: "upstream credentials missing (CF_AI_TOKEN / CF_ACCOUNT_ID)" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid body" }, 400);
    }

    // 模型别名映射；也允许直接传 @cf/... 供进阶使用
    const requested = body.model;
    let model = MODEL_MAP[requested];
    if (!model && typeof requested === "string" && requested.startsWith("@cf/")) {
      model = requested;
    }
    if (!model) {
      return json(
        { error: "unsupported model", supported: ALIAS_LIST, hint: "or pass a raw @cf/... model name" },
        400,
      );
    }
    body.model = model;

    // 输出长度限制，保护每日免费额度
    const cap = clampInt(env.MAX_TOKENS_CAP, 512, 1, 4096);
    const def = clampInt(env.MAX_TOKENS_DEFAULT, 256, 1, cap);
    if (body.max_tokens == null && body.max_completion_tokens != null) {
      body.max_tokens = body.max_completion_tokens;
    }
    body.max_tokens = Math.min(
      Math.max(1, Math.trunc(Number(body.max_tokens) || def)),
      cap,
    );

    const isStream = body.stream === true;

    // host 是硬编码常量，不取自请求输入；发请求前仍完整校验一次
    let upstream;
    try {
      const raw = `https://${UPSTREAM_HOST}/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
      upstream = assertSafeUpstreamUrl(raw);
    } catch (e) {
      return json({ error: "upstream url refused", detail: String(e.message || e) }, 500);
    }

    let res;
    try {
      res = await fetch(upstream, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json({ error: "upstream request failed", detail: String(e.message || e) }, 502);
    }

    const contentType = res.headers.get("content-type") || "application/json";

    // 流式：透传 SSE，并逐行归一 reasoning_content
    if (isStream && res.ok && res.body) {
      return new Response(res.body.pipeThrough(normalizeSseStream()), {
        status: res.status,
        headers: {
          "Content-Type": contentType.startsWith("text/event-stream")
            ? contentType
            : "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Upstream": "workers-ai",
        },
      });
    }

    // 非流式：解析后归一 reasoning_content
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return new Response(text, { status: res.status, headers: { "Content-Type": contentType } });
    }
    if (res.ok) {
      for (const ch of data?.choices || []) {
        const m = ch?.message || {};
        const alt = foldReasoning(m);
        if (m.content == null && alt) m.content = alt;
      }
    }
    return json(data, res.status);
  },
};
