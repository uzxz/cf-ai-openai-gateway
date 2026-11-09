/**
 * 用量埋点与聚合编排。
 *
 * 本文件不含任何 SQL 文本 —— 查询委托给 src/ae-query.js（静态 SQL + 参数化）。
 * 设计原则：
 *  - 统计失败绝不影响推理：record() 全程 try/catch，且不 await writeDataPoint。
 *  - 不记录 prompt / completion 正文、不记录 token / IP。
 *  - 所有 binding 可选：未配置 AOG_METRICS / ANALYTICS_SQL 时静默降级。
 *  - 查询结果缓存 60 秒，避免「偶尔看」时放大读查询次数。
 *
 * 时间口径：全部 UTC（与 Cloudflare 00:00 UTC 重置一致）。
 */

import { runAll } from "./ae-query.js";

export const DAILY_NEURON_ALLOWANCE = 10000;
const CACHE_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * 把一次推理请求写成一个 data point。
 * 任何异常都吞掉 —— 监控永远是旁路，不能影响主链路。
 *
 * @param {object} env  Worker env（含可选的 AOG_METRICS）
 * @param {object} info { alias, upstreamModel, statusClass, errorTag, neurons,
 *                        promptTokens, completionTokens, latencyMs, stream }
 */
export function record(env, info) {
  try {
    if (env.METRICS_ENABLED === "false" || env.METRICS_ENABLED === false) return;
    const ds = env.AOG_METRICS;
    if (!ds || typeof ds.writeDataPoint !== "function") return;

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const str = (v, max = 96) => String(v == null ? "" : v).slice(0, max);

    ds.writeDataPoint({
      indexes: [str(info.alias || "unknown")],
      blobs: [
        str(info.statusClass || "unknown", 32),         // blob1: ok / client_error / upstream_error
        str(info.upstreamModel || "", 96),               // blob2: @cf/... 原始模型名
        info.stream ? "stream" : "sync",                 // blob3
        str(info.errorTag || "", 64),                   // blob4: 错误码摘要（截断）
      ],
      doubles: [
        num(info.neurons),           // double1: Neurons
        num(info.promptTokens),      // double2
        num(info.completionTokens),  // double3
        num(info.latencyMs),         // double4: 延迟 ms
        1,                           // double5: 请求计数
      ],
    });
  } catch {
    // 故意吞掉：统计不可用时主链路必须照常工作
  }
}

// ---------------------------------------------------------------------------
// 日期范围
// ---------------------------------------------------------------------------

/**
 * 解析客户端传来的范围。全部按 UTC 计算。
 * 支持：today / 7d / 30d / year / custom(from=YYYY-MM-DD&to=YYYY-MM-DD，含首尾)。
 * 自定义范围最大 92 天（Analytics Engine 保留 3 个月），超出会截断到 92 天。
 */
export function resolveRange(searchParams, now = new Date()) {
  const raw = searchParams.get("range");
  const kind = ["today", "7d", "30d", "year", "custom"].includes(raw) ? raw : "today";
  const MAX_DAYS = 92;
  let from;
  let to = new Date(now.getTime());
  let label = "今天";

  if (kind === "custom") {
    const f = parseDateParam(searchParams.get("from"));
    const t = parseDateParam(searchParams.get("to"));
    if (f && t) {
      from = f;
      to = new Date(t.getTime() + 86400000 - 1); // 含当天
      label = `${isoDay(from)} ~ ${isoDay(t)}`;
    } else {
      from = startOfUtcDay(now);
    }
    if (from && to.getTime() - from.getTime() > MAX_DAYS * 86400000) {
      from = new Date(to.getTime() - MAX_DAYS * 86400000);
    }
  } else if (kind === "7d") {
    from = new Date(startOfUtcDay(now).getTime() - 6 * 86400000);
    label = "最近 7 天";
  } else if (kind === "30d") {
    from = new Date(startOfUtcDay(now).getTime() - 29 * 86400000);
    label = "最近 30 天";
  } else if (kind === "year") {
    from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    label = `${now.getUTCFullYear()} 年`;
  } else {
    from = startOfUtcDay(now);
  }

  return { kind, label, from: from.toISOString(), to: to.toISOString() };
}

function parseDateParam(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 汇总查询：委托 ae-query.js 执行 4 条参数化 SQL，结果缓存 60 秒。
 * 任一查询失败不影响其他视图，返回空数组并在 degraded 里标出原因。
 */
export async function summary(env, ctx, range) {
  const binding = env.ANALYTICS_SQL;
  if (!binding || typeof binding.query !== "function") {
    return {
      available: false,
      reason: "ANALYTICS_SQL binding 未配置；写入可能仍在进行，请在 wrangler.toml 添加 [analytics] 并重新部署",
      range: { kind: range.kind, label: range.label, from: range.from, to: range.to },
      dailyAllowance: DAILY_NEURON_ALLOWANCE,
      overview: null, trend: [], models: [], errors: [], degraded: [],
    };
  }

  // caches 是 Workers 运行时全局；本地 Node 测试或非 Worker 环境下可能不存在
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = [
    "https://cf-aog.internal/dashboard/summary",
    "?kind=", encodeURIComponent(range.kind),
    "&from=", encodeURIComponent(range.from),
    "&to=", encodeURIComponent(range.to),
  ].join("");
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return await cached.json();
    } catch {
      // 缓存不可用就直查
    }
  }

  const data = await runAll(binding, range.from, range.to);
  const out = {
    available: true,
    range: { kind: range.kind, label: range.label, from: range.from, to: range.to },
    dailyAllowance: DAILY_NEURON_ALLOWANCE,
    generatedAt: new Date().toISOString(),
    ...data,
  };

  const body = JSON.stringify(out);
  if (cache) {
    try {
      const toCache = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      });
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(cache.put(cacheKey, toCache));
      } else {
        await cache.put(cacheKey, toCache);
      }
    } catch {
      // 缓存写入失败不影响返回
    }
  }

  return out;
}
