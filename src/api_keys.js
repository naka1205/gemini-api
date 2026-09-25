import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.js";
import { log, maskKey } from "./logger.js";

export function splitKeys(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  const seen = new Set();
  const keys = [];
  for (const part of raw.split(/[,\s]+/)) {
    const key = part.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function bearerCredential(authorization) {
  const value = authorization.trim();
  if (!value) {
    return "";
  }
  const match = value.match(/^([a-z][a-z0-9+.-]*)\s+(.+)$/i);
  if (match) {
    // 只有 Bearer 之后的凭据才是 Key；Basic 等其它 scheme 不使用
    return /^bearer$/i.test(match[1]) ? match[2].trim() : "";
  }
  // "Bearer" / "Basic" 这种只有 scheme 没有凭据的头，不能把 scheme 当 Key
  return /^[a-z][a-z0-9+.-]*$/i.test(value) ? "" : value;
}

export const TOKEN_COOKIE_NAME = "gp_token";

function cookieCredential(cookieHeader, name) {
  if (!cookieHeader) {
    return "";
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

export function requestCredentials(request) {
  const header = (name) => request.headers.get(name) ?? "";
  const candidates = [
    bearerCredential(header("authorization")),
    header("x-goog-api-key"),
    header("x-api-key"),
    cookieCredential(header("cookie"), TOKEN_COOKIE_NAME),
  ];
  try {
    const { searchParams } = new URL(request.url);
    candidates.push(
      searchParams.get("key") ?? "",
      searchParams.get("token") ?? "",
      searchParams.get("api-key") ?? "",
    );
  } catch {
    // URL 不可解析时忽略 query 参数
  }
  return splitKeys(candidates.filter(Boolean).join(","));
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * 解析本次请求可用的 Gemini API Key 列表。
 * 优先级：请求中携带的 Key > 服务端环境变量（GEMINI_API_KEYS）。
 * 若配置了 PROXY_TOKEN，则请求必须携带该令牌，令牌本身不会被当作 Key 使用。
 */
export function resolveApiKeys(request, config) {
  const { authorized, offered } = inspectCredentials(request, config);

  if (!authorized) {
    throw new HttpError("Unauthorized: 缺少或错误的访问令牌（PROXY_TOKEN）", 401);
  }

  const keys = offered.length > 0 ? offered : config.apiKeys;
  if (keys.length === 0) {
    throw new HttpError(
      "No Gemini API key: 请在请求中携带 API Key，或在服务端配置 GEMINI_API_KEYS",
      401,
    );
  }
  return keys;
}

/** 拆出「携带的令牌是否有效」与「客户端自带的 Key 列表」，令牌本身不会当作上游 Key */
export function inspectCredentials(request, config) {
  const token = config.proxyToken;
  let authorized = !token;
  const offered = [];

  for (const credential of requestCredentials(request)) {
    if (token && constantTimeEquals(credential, token)) {
      authorized = true;
      continue;
    }
    offered.push(credential);
  }
  return { authorized, offered };
}

/** 仅校验访问令牌（监控页等不依赖 Gemini Key 的接口使用） */
export function assertAuthorized(request, config) {
  const { authorized } = inspectCredentials(request, config);
  if (!authorized) {
    throw new HttpError("Unauthorized: 缺少或错误的访问令牌（PROXY_TOKEN）", 401);
  }
}

// 轮询游标必须是进程级共享状态，否则每个请求都会从第 0 个 Key 重新开始
const roundRobinCursors = new Map();
const MAX_ROUND_ROBIN_ENTRIES = 512;

/** 用 Key 列表的指纹做游标标识，避免在内存中长期保留客户端传入的 Key */
function keySetSignature(keys) {
  let hash = 2166136261;
  for (const key of keys) {
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 16777619);
  }
  return `${keys.length}:${hash >>> 0}`;
}

function nextRoundRobinIndex(signature, length) {
  if (roundRobinCursors.size > MAX_ROUND_ROBIN_ENTRIES) {
    roundRobinCursors.clear();
  }
  const index = roundRobinCursors.get(signature) ?? 0;
  roundRobinCursors.set(signature, (index + 1) % length);
  return index % length;
}

/** 多 Key 负载均衡：random（默认，与 gemini-balance-lite 行为一致）或 round-robin（轮询） */
export function createKeyPicker(keys, strategy = "random") {
  const signature = strategy === "round-robin" && keys.length > 1 ? keySetSignature(keys) : "";
  return {
    size: keys.length,
    pick() {
      let key;
      if (keys.length === 1) {
        key = keys[0];
      } else if (strategy === "round-robin") {
        key = keys[nextRoundRobinIndex(signature, keys.length)];
      } else {
        key = keys[Math.floor(Math.random() * keys.length)];
      }
      log.debug(`selected api key: ${maskKey(key)}`);
      return key;
    },
  };
}
