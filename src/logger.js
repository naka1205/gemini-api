let debugEnabled = false;

export function setDebugEnabled(enabled) {
  debugEnabled = Boolean(enabled);
}

export function isDebugEnabled() {
  return debugEnabled;
}

const stamp = () => new Date().toISOString();

const write = (stream, level, args) => {
  stream(`[${stamp()}] [${level}]`, ...args);
};

export const log = {
  info: (...args) => write(console.log, "info", args),
  warn: (...args) => write(console.warn, "warn", args),
  error: (...args) => write(console.error, "error", args),
  debug: (...args) => {
    if (debugEnabled) write(console.log, "debug", args);
  },
};

export function maskKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    return "<empty>";
  }
  if (key.length <= 10) {
    return `${key.slice(0, 2)}***${key.slice(-2)}`;
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
