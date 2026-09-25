import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "./logger.js";

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Node IncomingMessage -> Fetch API Request（含流式 body，保留原始字节） */
export function createWebRequest(nodeReq) {
  const origin = `http://${nodeReq.headers.host ?? "localhost"}`;
  const url = new URL(nodeReq.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeReq.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.append(name, value);
    }
  }

  const init = { method: nodeReq.method, headers };
  if (!BODYLESS_METHODS.has(nodeReq.method ?? "GET")) {
    init.body = Readable.toWeb(nodeReq);
    init.duplex = "half";
  }
  return new Request(url, init);
}

const isEventStream = (contentType) => /text\/event-stream/i.test(contentType ?? "");

/** Fetch API Response -> Node ServerResponse（支持流式透传与客户端断开时取消上游） */
export async function sendWebResponse(nodeRes, webResponse, { method = "GET" } = {}) {
  const headerPairs = [];
  const setCookies = typeof webResponse.headers.getSetCookie === "function"
    ? webResponse.headers.getSetCookie()
    : [];
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() === "set-cookie") {
      continue;
    }
    headerPairs.push(name, value);
  }
  for (const cookie of setCookies) {
    headerPairs.push("set-cookie", cookie);
  }

  // 反向代理（nginx）默认会缓冲响应，SSE 必须显式关闭缓冲
  const contentType = webResponse.headers.get("content-type");
  if (isEventStream(contentType)) {
    headerPairs.push("X-Accel-Buffering", "no");
  }

  nodeRes.writeHead(webResponse.status, webResponse.statusText || undefined, headerPairs);
  nodeRes.socket?.setNoDelay(true);

  if (method === "HEAD" || !webResponse.body) {
    nodeRes.end();
    return;
  }

  const body = Readable.fromWeb(webResponse.body);
  let clientGone = false;
  const onClose = () => {
    if (!nodeRes.writableFinished) {
      clientGone = true;
      log.debug("client disconnected, cancelling upstream response");
      body.destroy(new Error("client disconnected"));
    }
  };
  nodeRes.on("close", onClose);
  try {
    await pipeline(body, nodeRes);
  } catch (err) {
    if (!clientGone) {
      throw err;
    }
  } finally {
    nodeRes.off("close", onClose);
  }
}
