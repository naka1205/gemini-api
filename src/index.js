import http from "node:http";
import { createConfig, describeConfig, loadEnvFile } from "./env.js";
import { handleRequest } from "./handle_request.js";
import { createWebRequest, sendWebResponse } from "./http_adapter.js";
import { log, setDebugEnabled } from "./logger.js";
import { registerKeys } from "./metrics.js";

loadEnvFile();
const config = createConfig();
setDebugEnabled(config.debug);
registerKeys(config.apiKeys, "server");

const sockets = new Set();

const server = http.createServer(async (nodeReq, nodeRes) => {
  const startedAt = process.hrtime.bigint();
  const method = nodeReq.method ?? "GET";
  const path = nodeReq.url ?? "/";
  const clientIp = clientAddress(nodeReq);

  try {
    const webRequest = createWebRequest(nodeReq);
    const webResponse = await handleRequest(webRequest, config);
    await sendWebResponse(nodeRes, webResponse, { method });
  } catch (err) {
    log.error(`${method} ${path} failed: ${err?.message ?? err}`);
    if (err?.stack) {
      log.debug(err.stack);
    }
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      nodeRes.end(JSON.stringify({ error: { message: "Internal Server Error", type: "server_error", code: 500 } }));
    } else {
      nodeRes.destroy();
    }
  } finally {
    if (config.logRequests) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log.info(
        `${clientIp} ${method} ${path} -> ${nodeRes.statusCode} ${durationMs.toFixed(0)}ms`,
      );
    }
  }
});

// 代理场景下需要放宽各超时，避免长请求 / 流式响应被服务端提前断开
server.requestTimeout = 0;
server.headersTimeout = 66_000;
server.keepAliveTimeout = 65_000;

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

server.on("clientError", (err, socket) => {
  log.debug(`client error: ${err.message}`);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function clientAddress(nodeReq) {
  if (config.trustProxy) {
    const forwarded = nodeReq.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) {
      return first.split(",")[0].trim();
    }
  }
  return nodeReq.socket.remoteAddress ?? "-";
}

function shutdown(signal) {
  log.info(`${signal} received, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => {
    log.warn("forcing shutdown after timeout");
    for (const socket of sockets) {
      socket.destroy();
    }
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection:", reason?.stack ?? reason);
});
process.on("uncaughtException", (err) => {
  log.error("uncaught exception:", err?.stack ?? err);
  shutdown("uncaughtException");
});

server.listen(config.port, config.host, () => {
  const summary = describeConfig(config);
  log.info(`gemini-api v${summary.version} listening on http://${summary.listen}`);
  log.info(`upstream: ${summary.upstream}`);
  log.info(`load balancing: ${summary.keyStrategy}, server-side keys: ${summary.apiKeyCount}${summary.apiKeyCount ? ` [${summary.apiKeys.join(", ")}]` : ""}`);
  log.info(`proxy token: ${summary.tokenRequired ? "enabled" : "disabled (set PROXY_TOKEN to protect this server)"}`);
  log.info(`dashboard: http://${summary.listen}/dashboard${summary.tokenRequired ? "?token=<PROXY_TOKEN>" : ""}`);
  log.debug(`debug logging enabled (pid ${process.pid})`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log.error(`port ${config.port} is already in use`);
  } else if (err.code === "EACCES") {
    log.error(`no permission to bind ${config.host}:${config.port}（1024 以下端口需要 root 或 CAP_NET_BIND_SERVICE）`);
  } else {
    log.error("server error:", err);
  }
  process.exit(1);
});
