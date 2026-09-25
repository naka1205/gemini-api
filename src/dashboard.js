import { TOKEN_COOKIE_NAME } from "./api_keys.js";
import { KEY_PREFIX_LENGTH, snapshot } from "./metrics.js";

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

export const DASHBOARD_PATHS = ["/dashboard", "/dashboard.json", "/monitor"];

export function dashboardJson(config) {
  return new Response(JSON.stringify(snapshot(config), null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * 监控页本身：只展示 Key 前 10 个字符。
 * 首次用 ?token=xxx 打开时会写入 HttpOnly Cookie，之后的自动刷新不再把令牌暴露在 URL / 页面里。
 */
export function dashboardPage(config, { token, secure = false } = {}) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (token) {
    const attributes = [
      `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=2592000",
    ];
    if (secure) {
      attributes.push("Secure");
    }
    headers["Set-Cookie"] = attributes.join("; ");
  }
  return new Response(html(config), { status: 200, headers });
}

const html = (config) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Gemini API 监控</title>
<style>
  :root { color-scheme: light dark; --ok:#12a150; --info:#2f6feb; --warn:#d97706; --err:#dc2626; --line:rgba(128,128,128,.28); }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px 16px 48px; line-height: 1.6; }
  main { max-width: 1080px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 28px 0 8px; opacity: .85; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .running { color: var(--ok); border-color: currentColor; }
  .toolbar { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 13px; opacity: .9; }
  button { font: inherit; font-size: 13px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button:hover { border-color: currentColor; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0 4px; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .card .label { font-size: 12px; opacity: .7; }
  .card .value { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; white-space: nowrap; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; font-size: 12px; opacity: .75; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font-size: 12.5px; }
  .pill { display: inline-block; min-width: 34px; text-align: center; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; font-variant-numeric: tabular-nums; }
  .ok { color: var(--ok); } .info { color: var(--info); } .warn { color: var(--warn); } .err { color: var(--err); }
  .muted { opacity: .6; }
  .empty { padding: 14px; font-size: 13px; opacity: .75; }
  .notice { margin-top: 12px; font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); display: none; }
  .notice.show { display: block; }
  .err-text { color: var(--err); }
  footer { margin-top: 26px; font-size: 12px; opacity: .65; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Gemini API 监控</h1>
    <span class="badge running">运行中</span>
    <span class="muted" style="font-size:12px">v${esc(config.version)} · 上游 ${esc(config.upstreamBaseUrl)}/${esc(config.upstreamApiVersion)}</span>
    <span class="toolbar">
      <span id="updated" class="muted">加载中…</span>
      <button id="refresh">立即刷新</button>
      <button id="auto">自动刷新：开</button>
    </span>
  </header>

  <div id="notice" class="notice err-text"></div>

  <div class="cards">
    <div class="card"><div class="label">运行时长</div><div class="value" id="uptime">-</div></div>
    <div class="card"><div class="label">总请求数</div><div class="value" id="total">-</div></div>
    <div class="card"><div class="label">成功率</div><div class="value" id="rate">-</div></div>
    <div class="card"><div class="label">Key 数量</div><div class="value" id="keycount">-</div></div>
    <div class="card"><div class="label">负载均衡策略</div><div class="value" id="strategy">-</div></div>
  </div>

  <h2>Key 状态（仅显示前 ${KEY_PREFIX_LENGTH} 个字符）</h2>
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Key</th><th>来源</th><th>请求</th><th>成功</th><th>失败</th>
          <th>429</th><th>401/403</th><th>5xx</th><th>校验</th><th>最近状态</th><th>最近使用</th><th>最近路径</th>
        </tr>
      </thead>
      <tbody id="keys"></tbody>
    </table>
  </div>

  <h2>最近 20 条请求</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>时间</th><th>来源</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>Key</th></tr></thead>
      <tbody id="recent"></tbody>
    </table>
  </div>

  <footer>
    Key 仅显示前 ${KEY_PREFIX_LENGTH} 个字符；统计保存在进程内存中，重启后清零（PM2 多实例时每个 worker 各自统计）。
  </footer>
</main>
<script>
var REFRESH_MS = 5000;
var autoRefresh = true;
var timer = null;

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) { node.className = cls; }
  if (text !== undefined && text !== null) { node.textContent = text; }
  return node;
}
function cell(row, text, cls) { row.appendChild(el("td", cls, text)); }
function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) { return "-"; }
  var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d > 0) { return d + " 天 " + h + " 小时"; }
  if (h > 0) { return h + " 小时 " + m + " 分"; }
  if (m > 0) { return m + " 分 " + (seconds % 60) + " 秒"; }
  return seconds + " 秒";
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : "-"; }
function fmtMs(ms) { return (ms === null || ms === undefined) ? "-" : Math.round(ms) + " ms"; }
function statusClass(status) {
  if (status === null || status === undefined) { return "muted"; }
  if (status < 300) { return "ok"; }
  if (status < 400) { return "info"; }
  if (status < 500) { return "warn"; }
  return "err";
}
var SCOPE_LABEL = { server: "服务端配置", openai: "OpenAI 接口", gemini: "Gemini 接口", verify: "校验" };
function scopeLabel(scope) { return SCOPE_LABEL[scope] || scope || "-"; }

function renderKeys(keys) {
  var tbody = document.getElementById("keys");
  tbody.textContent = "";
  if (!keys.length) {
    var emptyRow = el("tr");
    var td = el("td", "empty", "暂无 Key：请在 .env 里配置 GEMINI_API_KEYS，或由客户端携带 Key 发起请求。");
    td.colSpan = 12;
    emptyRow.appendChild(td);
    tbody.appendChild(emptyRow);
    return;
  }
  keys.forEach(function (item) {
    var row = el("tr");
    var keyCell = el("td");
    keyCell.appendChild(el("code", null, item.prefix));
    keyCell.appendChild(el("span", "muted", item.length > item.prefix.length ? "…" : ""));
    keyCell.appendChild(el("span", "muted", " (" + item.length + " 位)"));
    row.appendChild(keyCell);
    cell(row, scopeLabel(item.scope));
    cell(row, String(item.requests), "num");
    cell(row, String(item.success), "num ok");
    cell(row, String(item.failed), "num " + (item.failed ? "err" : "muted"));
    cell(row, String(item.rateLimited), "num " + (item.rateLimited ? "warn" : "muted"));
    cell(row, String(item.unauthorized), "num " + (item.unauthorized ? "warn" : "muted"));
    cell(row, String(item.serverErrors), "num " + (item.serverErrors ? "err" : "muted"));
    var verifyCell = el("td");
    verifyCell.appendChild(el("span", item.verified === "GOOD" ? "pill ok" : item.verified ? "pill err" : "pill muted", item.verified || "-"));
    row.appendChild(verifyCell);
    var statusCell = el("td");
    statusCell.appendChild(el("span", "pill " + statusClass(item.lastStatus), item.lastStatus === null ? "-" : String(item.lastStatus)));
    row.appendChild(statusCell);
    cell(row, fmtTime(item.lastUsedAt));
    cell(row, item.lastPath || "-", "muted");
    if (item.lastError) { row.title = "最近错误：" + item.lastError; }
    tbody.appendChild(row);
  });
}

function renderRecent(recent) {
  var tbody = document.getElementById("recent");
  tbody.textContent = "";
  if (!recent.length) {
    var emptyRow = el("tr");
    var td = el("td", "empty", "还没有请求记录。");
    td.colSpan = 7;
    emptyRow.appendChild(td);
    tbody.appendChild(emptyRow);
    return;
  }
  recent.forEach(function (item) {
    var row = el("tr");
    cell(row, fmtTime(item.at));
    cell(row, scopeLabel(item.scope));
    cell(row, item.method);
    cell(row, item.path, "muted");
    var statusCell = el("td");
    statusCell.appendChild(el("span", "pill " + statusClass(item.status), String(item.status)));
    row.appendChild(statusCell);
    cell(row, fmtMs(item.durationMs), "num");
    cell(row, item.keyPrefix ? item.keyPrefix + "…" : "-", "muted");
    tbody.appendChild(row);
  });
}

function setNotice(message) {
  var notice = document.getElementById("notice");
  notice.textContent = message || "";
  notice.className = "notice" + (message ? " show" : "");
}

function render(data) {
  document.getElementById("uptime").textContent = fmtDuration(data.uptimeSeconds);
  document.getElementById("total").textContent = String(data.totals.requests);
  var keys = data.keys || [];
  var success = keys.reduce(function (sum, item) { return sum + item.success; }, 0);
  var failed = keys.reduce(function (sum, item) { return sum + item.failed; }, 0);
  var counted = success + failed;
  document.getElementById("rate").textContent = counted ? (Math.round((success / counted) * 1000) / 10) + "%" : "-";
  document.getElementById("keycount").textContent = String(keys.length);
  document.getElementById("strategy").textContent = data.keyStrategy;
  renderKeys(keys);
  renderRecent(data.recent || []);
  document.getElementById("updated").textContent = "更新于 " + fmtTime(Date.now());
}

function refresh() {
  return fetch("dashboard.json", { cache: "no-store" })
    .then(function (res) {
      if (res.status === 401) { throw new Error("需要访问令牌：请在地址后加上 ?token=你的PROXY_TOKEN 再打开"); }
      if (!res.ok) { throw new Error("读取失败：HTTP " + res.status); }
      return res.json();
    })
    .then(function (data) { setNotice(""); render(data); })
    .catch(function (err) { setNotice(err.message); });
}

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  if (autoRefresh) { timer = setInterval(refresh, REFRESH_MS); }
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("auto").addEventListener("click", function () {
  autoRefresh = !autoRefresh;
  this.textContent = "自动刷新：" + (autoRefresh ? "开" : "关");
  schedule();
});
refresh();
schedule();
</script>
</body>
</html>
`;

export const dashboardTokenFromQuery = (url) =>
  url.searchParams.has("token") || url.searchParams.has("key") || url.searchParams.has("api-key");

export const isSecureRequest = (request) =>
  /^https$/i.test(request.headers.get("x-forwarded-proto") ?? "");
