/**
 * 监控工作台静态页面。
 *
 * 单页、内联 CSS/JS、无外部 CDN、无构建步骤。
 * 鉴权：页面与 API 都要求 Bearer GATEWAY_KEY（由 worker.js 统一校验）。
 * 时间口径：UTC（与 Cloudflare 00:00 UTC 重置一致），页面显著标注。
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF_AOG · 用量工作台</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
         background:#0f1115; color:#e6e8eb; }
  @media (prefers-color-scheme: light) { body { background:#f6f7f9; color:#1c2027; } }
  .wrap { max-width:1100px; margin:0 auto; padding:20px 16px 48px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:18px; }
  h1 { font-size:19px; margin:0; font-weight:650; letter-spacing:.2px; }
  .sub { opacity:.65; font-size:12px; margin-top:3px; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  button, input, select { font:inherit; }
  .seg { display:inline-flex; border:1px solid #ffffff26; border-radius:9px; overflow:hidden; }
  .seg button { border:0; background:transparent; color:inherit; padding:7px 13px; cursor:pointer; opacity:.7; }
  .seg button.on { background:#3b82f6; color:#fff; opacity:1; }
  .seg button:hover:not(.on) { opacity:1; background:#ffffff12; }
  input[type=date] { background:transparent; color:inherit; border:1px solid #ffffff26; border-radius:8px; padding:6px 9px; }
  .btn { background:transparent; color:inherit; border:1px solid #ffffff26; border-radius:8px; padding:7px 13px; cursor:pointer; }
  .btn:hover { background:#ffffff12; }
  .card { border:1px solid #ffffff18; border-radius:14px; padding:16px 18px; margin-bottom:14px; background:#ffffff06; }
  @media (prefers-color-scheme: light) { .card { background:#fff; border-color:#e3e6ea; } .seg, .btn, input[type=date] { border-color:#d5d9e0; } }
  .kpi { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
  .kpi .item .l { opacity:.6; font-size:12px; }
  .kpi .item .v { font-size:25px; font-weight:650; margin-top:4px; font-variant-numeric:tabular-nums; }
  .kpi .item .h { opacity:.55; font-size:11px; margin-top:2px; }
  .progress { height:9px; border-radius:99px; background:#ffffff14; overflow:hidden; margin-top:14px; }
  .progress > i { display:block; height:100%; background:linear-gradient(90deg,#3b82f6,#22d3ee); width:0; transition:width .4s; }
  .grid2 { display:grid; grid-template-columns:1.35fr 1fr; gap:14px; }
  @media (max-width:780px){ .grid2 { grid-template-columns:1fr; } }
  h2 { font-size:13px; margin:0 0 12px; font-weight:600; opacity:.8; }
  .chart { display:flex; align-items:flex-end; gap:3px; height:130px; }
  .chart .col { flex:1; min-width:4px; background:linear-gradient(180deg,#3b82f6,#2563eb88); border-radius:3px 3px 0 0; position:relative; }
  .chart .col:hover::after { content:attr(data-t); position:absolute; bottom:100%; left:50%; transform:translateX(-50%);
     background:#000c; color:#fff; padding:3px 7px; border-radius:5px; font-size:11px; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:8px 6px; border-bottom:1px solid #ffffff12; font-size:12.5px; }
  th { opacity:.6; font-weight:500; }
  td.n,th.n { text-align:right; }
  .empty { opacity:.5; padding:22px 0; text-align:center; font-size:13px; }
  .err { color:#f87171; }
  .pill { display:inline-block; padding:1px 7px; border-radius:99px; background:#ffffff14; font-size:11px; }
  .note { opacity:.55; font-size:11.5px; margin-top:10px; line-height:1.7; }
  .warn { border:1px solid #f59e0b55; background:#f59e0b12; border-radius:10px; padding:11px 14px; font-size:12.5px; margin-bottom:14px; }
  .spin { opacity:.6; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>CF_AOG · 用量工作台</h1>
      <div class="sub">Workers AI 用量统计 · <b>所有时间为 UTC</b>（与 Cloudflare 00:00 UTC 重置一致）· 数据保留 3 个月</div>
    </div>
    <div class="bar">
      <div class="seg" id="seg">
        <button data-k="today" class="on">今天</button>
        <button data-k="7d">近 7 天</button>
        <button data-k="30d">近 30 天</button>
        <button data-k="year">本年</button>
        <button data-k="custom">自定义</button>
      </div>
      <span id="custom" style="display:none">
        <input type="date" id="from"> <span style="opacity:.5">→</span> <input type="date" id="to">
        <button class="btn" id="apply">应用</button>
      </span>
      <button class="btn" id="refresh">刷新</button>
    </div>
  </header>

  <div id="warn"></div>

  <div class="card">
    <div class="kpi">
      <div class="item"><div class="l">Neurons 消耗</div><div class="v" id="k-neurons">—</div><div class="h" id="h-neurons">所选范围</div></div>
      <div class="item"><div class="l">请求数</div><div class="v" id="k-requests">—</div><div class="h" id="h-ok">成功率 —</div></div>
      <div class="item"><div class="l">Input / Output tokens</div><div class="v" id="k-tokens">—</div><div class="h">累计</div></div>
      <div class="item"><div class="l">平均延迟</div><div class="v" id="k-latency">—</div><div class="h">端到端</div></div>
    </div>
    <div class="progress"><i id="prog"></i></div>
    <div class="note" id="progress-note">今日额度进度按 10,000 Neurons/天 计算，仅「今天」范围有意义。</div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>用量趋势 <span class="pill" id="trend-label">按天</span></h2>
      <div class="chart" id="chart"></div>
      <div class="note" id="trend-note">—</div>
    </div>
    <div class="card">
      <h2>模型分布</h2>
      <table><thead><tr><th>模型</th><th class="n">请求</th><th class="n">Neurons</th><th class="n">占比</th></tr></thead>
      <tbody id="models"></tbody></table>
    </div>
  </div>

  <div class="card">
    <h2>错误分布</h2>
    <table><thead><tr><th>状态</th><th>错误码</th><th class="n">次数</th></tr></thead>
    <tbody id="errors"></tbody></table>
    <div class="note" id="meta"></div>
  </div>
</div>

<script>
(function(){
  var key = sessionStorage.getItem('aog_key') || '';
  var state = { kind: 'today', from: '', to: '', last: 0 };
  var MIN_INTERVAL = 30000;

  function fmt(n){ n = Number(n)||0; return n >= 10000 ? (n/1000).toFixed(1)+'k' : String(Math.round(n*100)/100); }
  function fmtInt(n){ return (Number(n)||0).toLocaleString('en-US'); }
  function txt(v){ return String(v == null ? '' : v).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function askKey(){
    var k = window.prompt('请输入 GATEWAY_KEY（仅存于本次浏览器会话）：', key);
    if (k === null) return false;
    key = k.trim(); sessionStorage.setItem('aog_key', key); return true;
  }

  function qs(){
    var p = 'range=' + encodeURIComponent(state.kind);
    if (state.kind === 'custom' && state.from && state.to) {
      p += '&from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to);
    }
    return p;
  }

  function setKind(k){
    state.kind = k;
    var bs = document.querySelectorAll('#seg button');
    for (var i=0;i<bs.length;i++) bs[i].className = (bs[i].getAttribute('data-k') === k ? 'on' : '');
    document.getElementById('custom').style.display = (k === 'custom' ? '' : 'none');
    if (k === 'custom') {
      var t = new Date(), f = new Date(t.getTime() - 6*86400000);
      document.getElementById('from').value = f.toISOString().slice(0,10);
      document.getElementById('to').value = t.toISOString().slice(0,10);
      state.from = document.getElementById('from').value;
      state.to = document.getElementById('to').value;
    }
  }

  async function load(force){
    if (!key && !askKey()) return;
    var now = Date.now();
    if (!force && now - state.last < MIN_INTERVAL) return;
    state.last = now;
    var meta = document.getElementById('meta');
    meta.textContent = '加载中…';
    try {
      var res = await fetch('/dashboard/api/summary?' + qs(), {
        headers: { 'Authorization': 'Bearer ' + key }
      });
      if (res.status === 401) { key = ''; sessionStorage.removeItem('aog_key'); meta.innerHTML = '<span class="err">GATEWAY_KEY 不正确，请刷新重试。</span>'; return; }
      var d = await res.json();
      render(d);
    } catch (e) {
      meta.innerHTML = '<span class="err">加载失败：' + txt(e.message || e) + '</span>';
    }
  }

  function render(d){
    var warn = document.getElementById('warn');
    if (!d.available) {
      warn.className = 'warn';
      warn.textContent = '监控未启用：' + (d.reason || '未配置 ANALYTICS_SQL binding') + '。网关推理功能不受影响。';
    } else { warn.className = ''; warn.textContent = ''; }
    if (d.degraded && d.degraded.length) {
      warn.className = 'warn';
      warn.textContent = '部分统计不可用：' + d.degraded.join(' / ');
    }

    var o = d.overview || {};
    document.getElementById('k-neurons').textContent = fmt(o.neurons);
    document.getElementById('h-neurons').textContent = d.range ? d.range.label : '所选范围';
    document.getElementById('k-requests').textContent = fmtInt(o.requests);
    var ok = Number(o.ok_count)||0, req = Number(o.requests)||0;
    document.getElementById('h-ok').textContent = '成功率 ' + (req ? (ok/req*100).toFixed(1) : '—') + '% · 错误 ' + fmtInt(o.error_count);
    document.getElementById('k-tokens').textContent = fmt(o.input_tokens) + ' / ' + fmt(o.output_tokens);
    document.getElementById('k-latency').textContent = (Number(o.avg_latency_ms)||0).toFixed(0) + ' ms';

    var pct = Math.min(100, (Number(o.neurons)||0) / (d.dailyAllowance||10000) * 100);
    document.getElementById('prog').style.width = pct.toFixed(1) + '%';
    document.getElementById('progress-note').textContent = d.range && d.range.kind === 'today'
      ? '今日额度：' + fmt(o.neurons) + ' / ' + fmtInt(d.dailyAllowance) + ' Neurons（' + pct.toFixed(1) + '%），UTC 00:00 重置'
      : '今日额度进度按 10,000 Neurons/天 计算，仅「今天」范围有意义。';

    // 趋势
    var trend = d.trend || [], max = 0, i;
    for (i=0;i<trend.length;i++) max = Math.max(max, Number(trend[i].neurons)||0);
    var chart = document.getElementById('chart');
    chart.innerHTML = '';
    if (!trend.length) { chart.innerHTML = '<div class="empty">该范围暂无数据</div>'; }
    else {
      for (i=0;i<trend.length;i++) {
        var row = trend[i], v = Number(row.neurons)||0;
        var col = document.createElement('div');
        col.className = 'col';
        col.style.height = (max ? Math.max(3, v/max*100) : 3) + '%';
        col.setAttribute('data-t', String(row.bucket).slice(0,10) + ' · ' + fmt(v) + ' Neurons · ' + fmtInt(row.requests) + ' 次');
        chart.appendChild(col);
      }
    }
    document.getElementById('trend-label').textContent = trend.length > 31 ? '按天（最多 200 点）' : '按天';
    document.getElementById('trend-note').textContent = trend.length
      ? '共 ' + trend.length + ' 个数据点 · 峰值 ' + fmt(max) + ' Neurons/天'
      : '';

    // 模型
    var models = d.models || [], total = 0;
    for (i=0;i<models.length;i++) total += Number(models[i].neurons)||0;
    var mb = document.getElementById('models');
    mb.innerHTML = models.length ? '' : '<tr><td colspan="4" class="empty">该范围暂无数据</td></tr>';
    for (i=0;i<models.length;i++) {
      var m = models[i];
      mb.insertAdjacentHTML('beforeend', '<tr><td>' + txt(m.model) + '</td><td class="n">' + fmtInt(m.requests) +
        '</td><td class="n">' + fmt(m.neurons) + '</td><td class="n">' +
        (total ? (Number(m.neurons)/total*100).toFixed(1) : '0') + '%</td></tr>');
    }

    // 错误
    var errors = d.errors || [], eb = document.getElementById('errors');
    eb.innerHTML = errors.length ? '' : '<tr><td colspan="3" class="empty">该范围无错误 🎉</td></tr>';
    for (i=0;i<errors.length;i++) {
      var e = errors[i];
      eb.insertAdjacentHTML('beforeend', '<tr><td>' + txt(e.status_class) + '</td><td>' + txt(e.error_tag || '—') +
        '</td><td class="n">' + fmtInt(e.requests) + '</td></tr>');
    }
    document.getElementById('meta').textContent = '范围：' + (d.range ? d.range.label : '—') +
      (d.range ? ' (' + d.range.from.slice(0,10) + ' ~ ' + d.range.to.slice(0,10) + ' UTC)' : '') +
      ' · 生成于 ' + (d.generatedAt ? d.generatedAt.slice(0,19).replace('T',' ') + ' UTC' : '—') +
      ' · 结果缓存 60 秒，最小刷新间隔 30 秒';
  }

  var seg = document.getElementById('seg');
  seg.addEventListener('click', function(ev){
    var b = ev.target.closest('button'); if (!b) return;
    setKind(b.getAttribute('data-k')); load(true);
  });
  document.getElementById('apply').addEventListener('click', function(){
    state.from = document.getElementById('from').value;
    state.to = document.getElementById('to').value;
    load(true);
  });
  document.getElementById('refresh').addEventListener('click', function(){ load(true); });

  setKind('today');
  load(true);
})();
</script>
</body>
</html>`;
