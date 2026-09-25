import { log } from "./logger.js";

// 不转发给上游的请求头：逐跳头、长度/编码（由 fetch 重新计算）、以及本代理的凭据
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
  "authorization",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "cookie",
  "origin",
  "referer",
  "x-goog-api-key",
  "x-api-key",
  "x-proxy-token",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cdn-loop",
]);

// Node fetch(undici) 会自动解压响应体，因此不能把 content-encoding / 原始长度透传出去
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "alt-svc",
]);

export function forwardRequestHeaders(headers, { apiKey } = {}) {
  const forwarded = new Headers();
  for (const [name, value] of headers) {
    if (DROP_REQUEST_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    forwarded.append(name, value);
  }
  if (apiKey) {
    forwarded.set("x-goog-api-key", apiKey);
  }
  return forwarded;
}

export function sanitizeResponseHeaders(headers, { cors = true } = {}) {
  const sanitized = new Headers();
  for (const [name, value] of headers) {
    if (DROP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    sanitized.append(name, value);
  }
  if (cors) {
    sanitized.set("Access-Control-Allow-Origin", "*");
  }
  sanitized.set("Referrer-Policy", "no-referrer");
  return sanitized;
}

/** 带超时的上游请求：超时只覆盖「建立连接 + 等待响应头」，流式响应开始后不再计时 */
export async function fetchUpstream(url, init, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`upstream timeout after ${config.upstreamTimeoutMs}ms`));
  }, config.upstreamTimeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function isTimeoutError(err) {
  return err?.name === "AbortError"
    || err?.name === "TimeoutError"
    || /timeout|timed out/i.test(err?.message ?? "");
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * 读取上游错误响应里的错误信息（用于监控页展示「这个 Key 为什么失败」）。
 * 通过 clone() 读取副本，最多读 64KB 后立即取消，原始响应体仍完整地流式透传给客户端，
 * 因此即使上游返回超大响应也不会把内容缓冲进内存。拿不到信息时返回 null。
 */
export async function readJsonErrorMessage(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/json/i.test(contentType) || !response.body) {
    return null;
  }
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_ERROR_BODY_BYTES) {
    return null;
  }

  let reader;
  try {
    reader = response.clone().body.getReader();
  } catch (err) {
    log.debug(`cannot inspect upstream error: ${err?.message ?? err}`);
    return null;
  }

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    log.debug(`failed to read upstream error body: ${err?.message ?? err}`);
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }

  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim().slice(0, 200);
    }
  } catch {
    // 截断或非 JSON，退化为原文
  }
  const fallback = text.trim();
  return fallback ? fallback.slice(0, 200) : null;
}

export function logUpstreamError(scope, err) {
  log.error(`${scope}: ${err?.message ?? err}`);
  if (err?.cause?.message) {
    log.debug(`cause: ${err.cause.message}`);
  }
}
