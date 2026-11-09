// 纯数据模块：只导出静态 SQL 字符串常量，不含任何执行逻辑。
// 占位符使用官方 Analytics SQL binding 的 $1 / $2 位置参数
// （官方文档：Use $1 for positional parameters or $name for named parameters）。
// 参数值不进入 SQL 文本，因此不存在拼接注入面。

export const SQL = Object.freeze({
  overview: 'SELECT sum(double1) AS neurons, sum(double5) AS requests, sum(double2) AS input_tokens, sum(double3) AS output_tokens, avg(double4) AS avg_latency_ms, countIf(blob1 = \'ok\') AS ok_count, countIf(blob1 != \'ok\') AS error_count FROM events.analyticsEngine."cf_aog_metrics" WHERE timestamp >= toDateTime($1 / 1000) AND timestamp <= toDateTime($2 / 1000) LIMIT 1',
  trend: 'SELECT toStartOfDay(timestamp) AS bucket, sum(double1) AS neurons, sum(double5) AS requests FROM events.analyticsEngine."cf_aog_metrics" WHERE timestamp >= toDateTime($1 / 1000) AND timestamp <= toDateTime($2 / 1000) GROUP BY bucket ORDER BY bucket ASC LIMIT 200',
  models: 'SELECT index1 AS model, sum(double5) AS requests, sum(double1) AS neurons, sum(double2) AS input_tokens, sum(double3) AS output_tokens, avg(double4) AS avg_latency_ms FROM events.analyticsEngine."cf_aog_metrics" WHERE timestamp >= toDateTime($1 / 1000) AND timestamp <= toDateTime($2 / 1000) GROUP BY model ORDER BY neurons DESC LIMIT 20',
  errors: 'SELECT blob1 AS status_class, blob4 AS error_tag, sum(double5) AS requests FROM events.analyticsEngine."cf_aog_metrics" WHERE timestamp >= toDateTime($1 / 1000) AND timestamp <= toDateTime($2 / 1000) AND blob1 != \'ok\' GROUP BY status_class, error_tag ORDER BY requests DESC LIMIT 20',
});
