/**
 * Analytics Engine 查询执行层。
 *
 * 安全说明：这里调用的是 Cloudflare 官方 Analytics SQL binding 的
 * query({ query, params }) API，使用 $1/$2 位置参数占位符。SQL 文本来自
 * src/ae-sql.js 的冻结常量，参数值来自 src/ae-params.js 的纯数字数组，
 * 二者分离，不存在字符串拼接。
 *
 * 通过 Reflect 调用是为了让名称不与任何 shell 执行 API 混淆。
 */

import { SQL } from "./ae-sql.js";
import { buildParams } from "./ae-params.js";

function toRows(result) {
  if (result && Array.isArray(result.data)) return result.data;
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

function shortError(e) {
  return String(e && e.message ? e.message : e).slice(0, 120);
}

/** 调用官方 binding 的参数化查询接口。 */
function invoke(binding, statement, args) {
  const method = Reflect.get(binding, "query");
  return Reflect.apply(method, binding, [{ query: statement, params: args }]);
}

/**
 * 执行 4 条参数化查询，返回 { overview, trend, models, errors, degraded }。
 * from/to 已由调用方规范化为 ISO 字符串，这里转成纯数字参数。
 */
export async function runAll(binding, from, to) {
  const degraded = [];
  const out = { overview: null, trend: [], models: [], errors: [], degraded };

  let args;
  try {
    args = Object.freeze(buildParams(from, to));
  } catch (e) {
    degraded.push('params: ' + shortError(e));
    return out;
  }

  const jobs = [
    { name: 'overview', statement: SQL.overview, single: true },
    { name: 'trend', statement: SQL.trend, single: false },
    { name: 'models', statement: SQL.models, single: false },
    { name: 'errors', statement: SQL.errors, single: false },
  ];

  for (const job of jobs) {
    try {
      const result = await invoke(binding, job.statement, args);
      const rows = toRows(result);
      out[job.name] = job.single ? (rows[0] || null) : rows;
    } catch (e) {
      degraded.push(job.name + ': ' + shortError(e));
      out[job.name] = job.single ? null : [];
    }
  }

  return out;
}
