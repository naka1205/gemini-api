// 进程内运行指标（不落盘、不重启保留；PM2 多实例时各 worker 独立统计）
const MAX_TRACKED_KEYS = 200;
const MAX_RECENT_REQUESTS = 20;

export const KEY_PREFIX_LENGTH = 10;

const state = {
  startedAt: Date.now(),
  totalRequests: 0,
  byStatus: new Map(),
  keys: new Map(),
  recent: [],
};

/** 只保留 Key 的前 10 个字符用于展示，其余一律不出现在接口返回中 */
export const keyPrefix = (key) => String(key ?? "").slice(0, KEY_PREFIX_LENGTH);

function ensureKey(key, scope) {
  let stats = state.keys.get(key);
  if (!stats) {
    evictIfNeeded();
    stats = {
      createdAt: Date.now(),
      requests: 0,
      success: 0,
      failed: 0,
      rateLimited: 0,
      unauthorized: 0,
      serverErrors: 0,
      lastStatus: null,
      lastUsedAt: null,
      lastPath: null,
      lastError: null,
      verified: null,
      verifiedAt: null,
      scope: null,
    };
    state.keys.set(key, stats);
  }
  if (scope) {
    stats.scope = scope;
  }
  return stats;
}

function evictIfNeeded() {
  if (state.keys.size < MAX_TRACKED_KEYS) {
    return;
  }
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, stats] of state.keys) {
    const at = stats.lastUsedAt ?? stats.createdAt;
    if (at < oldestAt) {
      oldestAt = at;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) {
    state.keys.delete(oldestKey);
  }
}

/** 预登记服务端配置的 Key，未使用时也能在监控页看到 */
export function registerKeys(keys, scope = "server") {
  for (const key of keys ?? []) {
    ensureKey(key, scope);
  }
}

export function recordRequest({ key, status, durationMs, method, path, scope, error }) {
  state.totalRequests += 1;
  state.byStatus.set(status, (state.byStatus.get(status) ?? 0) + 1);

  if (key) {
    const stats = ensureKey(key, scope);
    stats.requests += 1;
    stats.lastStatus = status;
    stats.lastUsedAt = Date.now();
    stats.lastPath = path ?? null;
    if (status < 400) {
      stats.success += 1;
    } else {
      stats.failed += 1;
      if (status === 429) {
        stats.rateLimited += 1;
      } else if (status === 401 || status === 403) {
        stats.unauthorized += 1;
      } else if (status >= 500) {
        stats.serverErrors += 1;
      }
    }
    if (error) {
      stats.lastError = String(error).slice(0, 200);
    }
  }

  state.recent.push({
    at: Date.now(),
    method: method ?? "GET",
    path: path ?? "/",
    status,
    durationMs: durationMs ?? null,
    keyPrefix: key ? keyPrefix(key) : null,
    scope: scope ?? null,
  });
  if (state.recent.length > MAX_RECENT_REQUESTS) {
    state.recent.shift();
  }
}

export function recordVerification(key, status, error) {
  const stats = ensureKey(key, "verify");
  stats.verified = status;
  stats.verifiedAt = Date.now();
  stats.scope = "verify";
  if (status === "GOOD") {
    stats.lastError = null;
  } else if (error) {
    stats.lastError = String(error).slice(0, 200);
  }
}

const serializeKey = ([key, stats]) => ({
  prefix: keyPrefix(key),
  length: key.length,
  scope: stats.scope,
  requests: stats.requests,
  success: stats.success,
  failed: stats.failed,
  rateLimited: stats.rateLimited,
  unauthorized: stats.unauthorized,
  serverErrors: stats.serverErrors,
  lastStatus: stats.lastStatus,
  lastUsedAt: stats.lastUsedAt,
  lastPath: stats.lastPath,
  lastError: stats.lastError,
  verified: stats.verified,
  verifiedAt: stats.verifiedAt,
});

export function snapshot(config) {
  const keys = [...state.keys.entries()]
    .map(serializeKey)
    .sort((a, b) => b.requests - a.requests || a.prefix.localeCompare(b.prefix));

  return {
    status: "ok",
    version: config.version,
    startedAt: state.startedAt,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    upstream: `${config.upstreamBaseUrl}/${config.upstreamApiVersion}`,
    keyStrategy: config.keyStrategy,
    tokenRequired: Boolean(config.proxyToken),
    totals: {
      requests: state.totalRequests,
      byStatus: Object.fromEntries([...state.byStatus.entries()].sort((a, b) => a[0] - b[0])),
    },
    keys,
    recent: [...state.recent].reverse(),
  };
}
