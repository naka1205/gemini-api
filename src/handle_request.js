import { assertAuthorized, createKeyPicker, resolveApiKeys } from "./api_keys.js";
import {
  DASHBOARD_PATHS,
  dashboardJson,
  dashboardPage,
  dashboardTokenFromQuery,
  isSecureRequest,
} from "./dashboard.js";
import { HttpError, errorResponse } from "./errors.js";
import { log } from "./logger.js";
import { recordRequest } from "./metrics.js";
import { handleOpenAiRequest } from "./openai.js";
import {
  fetchUpstream,
  forwardRequestHeaders,
  isTimeoutError,
  logUpstreamError,
  readJsonErrorMessage,
  sanitizeResponseHeaders,
} from "./upstream.js";
import { verifyKeys } from "./verify_keys.js";

const OPENAI_SUFFIXES = ["/chat/completions", "/completions", "/embeddings", "/models"];
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

const SERVICE_STARTED_AT = Date.now();

export async function handleRequest(request, config) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    return corsPreflight();
  }

  try {
    if (pathname === "/" || pathname === "/index.html") {
      return statusPage(config);
    }
    if (pathname === "/health" || pathname === "/healthz") {
      return healthResponse(config);
    }
    if (pathname === "/favicon.ico" || pathname === "/robots.txt") {
      // 浏览器/爬虫的小请求，不应占用上游 API 配额
      return new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=86400" } });
    }
    if (DASHBOARD_PATHS.includes(pathname)) {
      return handleDashboard(request, config, url);
    }
    if (pathname === "/verify") {
      return await handleVerify(request, config);
    }
    if (OPENAI_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
      return await handleOpenAiRequest(request, config);
    }
    return await proxyToGemini(request, config, url);
  } catch (err) {
    log.error(`${request.method} ${pathname} -> ${err?.message ?? err}`);
    if (err?.stack) {
      log.debug(err.stack);
    }
    return errorResponse(err);
  }
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** 监控页：仅校验访问令牌（不需要 Gemini Key），令牌通过 ?token= 首次带入后写入 Cookie */
function handleDashboard(request, config, url) {
  assertAuthorized(request, config);
  if (url.pathname === "/dashboard.json") {
    return dashboardJson(config);
  }
  return dashboardPage(config, {
    token: config.proxyToken && dashboardTokenFromQuery(url) ? config.proxyToken : null,
    secure: isSecureRequest(request),
  });
}

/** Gemini 原生 API 代理：随机/轮询挑选一个 Key 后转发到上游 */
async function proxyToGemini(request, config, url) {
  const startedAt = Date.now();
  const keys = resolveApiKeys(request, config);
  const apiKey = createKeyPicker(keys, config.keyStrategy).pick();

  const targetUrl = new URL(`${config.upstreamBaseUrl}${url.pathname}${url.search}`);
  // 凭据只放在一个位置：客户端用 ?key= 传入时继续用 query，否则统一用请求头，
  // 避免同时出现 api-key 与 x-goog-api-key 导致的凭据冲突。
  const keyFromQuery = targetUrl.searchParams.has("key") || targetUrl.searchParams.has("api-key");
  if (keyFromQuery) {
    targetUrl.searchParams.set("key", apiKey);
    targetUrl.searchParams.delete("api-key");
  }
  targetUrl.searchParams.delete("token");

  const hasBody = !BODYLESS_METHODS.has(request.method) && Boolean(request.body);
  log.debug(`${request.method} ${targetUrl.pathname}${targetUrl.search} (${keys.length} key(s) available)`);

  let upstream;
  try {
    upstream = await fetchUpstream(targetUrl, {
      method: request.method,
      headers: forwardRequestHeaders(request.headers, { apiKey: keyFromQuery ? undefined : apiKey }),
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    }, config);
  } catch (err) {
    logUpstreamError("upstream request failed", err);
    recordRequest({
      key: apiKey,
      status: isTimeoutError(err) ? 504 : 502,
      durationMs: Date.now() - startedAt,
      method: request.method,
      path: url.pathname,
      scope: "gemini",
      error: err.message,
    });
    throw isTimeoutError(err)
      ? new HttpError(`Upstream timeout: ${err.message}`, 504)
      : new HttpError(`Upstream request failed: ${err.message}`, 502);
  }

  log.debug(`upstream responded ${upstream.status}`);
  const errorMessage = upstream.status >= 400 ? await readJsonErrorMessage(upstream) : null;
  recordRequest({
    key: apiKey,
    status: upstream.status,
    durationMs: Date.now() - startedAt,
    method: request.method,
    path: url.pathname,
    scope: "gemini",
    error: errorMessage,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: sanitizeResponseHeaders(upstream.headers),
  });
}

async function handleVerify(request, config) {
  const keys = resolveApiKeys(request, config);
  return verifyKeys(keys, config);
}

function healthResponse(config) {
  return json({
    status: "ok",
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
    apiKeyCount: config.apiKeys.length,
    keyStrategy: config.keyStrategy,
    tokenRequired: Boolean(config.proxyToken),
    upstream: `${config.upstreamBaseUrl}/${config.upstreamApiVersion}`,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function statusPage(config) {
  const uptime = Math.round((Date.now() - SERVICE_STARTED_AT) / 1000);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Gemini API Proxy</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 40px 20px; line-height: 1.7; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .ok { color: #12a150; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0 24px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.28); font-size: 14px; vertical-align: top; }
  code { background: rgba(128,128,128,.16); padding: 2px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
  footer { font-size: 13px; opacity: .72; }
</style>
</head>
<body>
<main>
  <h1>Gemini API Proxy <span class="ok">运行中</span></h1>
  <p>多 Key 负载均衡 · OpenAI 兼容 · Node.js / PM2 部署</p>
  <table>
    <tr><th>版本</th><td>${escapeHtml(config.version)}（已运行 ${uptime} 秒）</td></tr>
    <tr><th>上游</th><td><code>${escapeHtml(config.upstreamBaseUrl)}/${escapeHtml(config.upstreamApiVersion)}</code></td></tr>
    <tr><th>服务端 Key</th><td>${config.apiKeys.length} 个，负载均衡策略：${escapeHtml(config.keyStrategy)}</td></tr>
    <tr><th>访问令牌</th><td>${config.proxyToken ? "已启用（请求需携带 PROXY_TOKEN）" : "未启用（建议在 VPS 上启用）"}</td></tr>
  </table>
  <table>
    <tr><th><code>POST /v1beta/models/{model}:generateContent</code></th><td>Gemini 原生格式（<code>?alt=sse</code> 为流式）</td></tr>
    <tr><th><code>POST /chat/completions</code></th><td>OpenAI 兼容（<code>/v1/chat/completions</code> 亦可）</td></tr>
    <tr><th><code>GET /models</code></th><td>OpenAI 兼容模型列表</td></tr>
    <tr><th><code>POST /embeddings</code></th><td>OpenAI 兼容向量接口</td></tr>
    <tr><th><code>POST /verify</code></th><td>校验 Key 是否可用（SSE 返回结果）</td></tr>
    <tr><th><code>GET /health</code></th><td>健康检查</td></tr>
    <tr><th><code>GET /dashboard</code></th><td>健康监控页（每个 Key 的请求状况，只显示 Key 前 10 个字符${config.proxyToken ? "；需带 ?token=访问令牌" : ""}）</td></tr>
  </table>
  <footer>
    移植自 <a href="https://github.com/tech-shrimp/gemini-balance-lite">tech-shrimp/gemini-balance-lite</a>，
    OpenAI 兼容层来自 <a href="https://github.com/PublicAffairs/openai-gemini">PublicAffairs/openai-gemini</a>（MIT）。
  </footer>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
