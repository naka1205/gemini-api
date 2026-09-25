import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitKeys } from "./api_keys.js";
import { maskKey } from "./logger.js";

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/**
 * 极简 .env 读取（零依赖，PM2 / systemd / 直接 node 启动都能用）。
 * 已存在的进程环境变量优先级更高，不会被覆盖。
 */
export function loadEnvFile(filePath = process.env.ENV_FILE || ".env") {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), filePath), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw err;
  }

  const loaded = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = line.match(ENV_LINE_RE);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    let value = rawValue;
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) {
      value = quoted[2];
    } else {
      const commentAt = value.indexOf(" #");
      if (commentAt !== -1) {
        value = value.slice(0, commentAt).trim();
      }
    }
    // 已设置且非空的环境变量优先（空字符串视为未设置，方便 .env 补位）
    if (String(process.env[key] ?? "").trim() !== "") {
      continue;
    }
    process.env[key] = value;
    loaded[key] = value;
  }
  return loaded;
}

export function toInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const isTrue = (raw) => /^(1|true|yes|on)$/i.test(String(raw ?? "").trim());
const isFalse = (raw) => /^(0|false|no|off)$/i.test(String(raw ?? "").trim());

/** 取第一个非空值，空字符串 / undefined 都视为未配置 */
const pick = (...values) => {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text !== "") {
      return text;
    }
  }
  return "";
};

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createConfig(env = process.env) {
  const strategy = (pick(env.KEY_STRATEGY) || "random").toLowerCase();
  return {
    version: readVersion(),
    host: pick(env.HOST) || "0.0.0.0",
    port: toInt(env.PORT, 8787),
    apiKeys: splitKeys(
      pick(env.GEMINI_API_KEYS, env.GEMINI_API_KEY, env.GOOGLE_API_KEYS, env.API_KEYS),
    ),
    proxyToken: pick(env.PROXY_TOKEN, env.ACCESS_TOKEN),
    keyStrategy: strategy === "round-robin" || strategy === "roundrobin" || strategy === "rr"
      ? "round-robin"
      : "random",
    upstreamBaseUrl: (pick(env.GEMINI_API_BASE_URL) || "https://generativelanguage.googleapis.com")
      .replace(/\/+$/, ""),
    upstreamApiVersion: pick(env.GEMINI_API_VERSION) || "v1beta",
    verifyModel: pick(env.VERIFY_MODEL) || "gemini-2.5-flash",
    embeddingsModel: pick(env.EMBEDDINGS_MODEL) || "gemini-embedding-2",
    upstreamTimeoutMs: toInt(env.UPSTREAM_TIMEOUT_MS, 600_000),
    debug: isTrue(env.DEBUG),
    logRequests: !isFalse(env.LOG_REQUESTS),
    trustProxy: !isFalse(env.TRUST_PROXY),
  };
}

/** 供启动横幅 / /health 使用的安全摘要（Key 只输出掩码） */
export function describeConfig(config) {
  return {
    version: config.version,
    listen: `${config.host}:${config.port}`,
    upstream: `${config.upstreamBaseUrl}/${config.upstreamApiVersion}`,
    apiKeyCount: config.apiKeys.length,
    apiKeys: config.apiKeys.map(maskKey),
    keyStrategy: config.keyStrategy,
    tokenRequired: Boolean(config.proxyToken),
    debug: config.debug,
  };
}
