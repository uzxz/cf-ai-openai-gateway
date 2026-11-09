/** 把日期范围转换成纯数字参数（Unix 毫秒），避免任何字符串进入 SQL 参数。 */
export function buildParams(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) {
    throw new Error("invalid date bounds");
  }
  // 返回纯数字数组；整数、有限、无字符串
  return [Math.trunc(a), Math.trunc(b)];
}
