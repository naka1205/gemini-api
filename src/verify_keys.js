import { log, maskKey } from "./logger.js";
import { recordVerification } from "./metrics.js";
import { fetchUpstream, isTimeoutError } from "./upstream.js";

const encoder = new TextEncoder();

async function verifyKey(key, config, emit) {
  const url = `${config.upstreamBaseUrl}/${config.upstreamApiVersion}/models/${config.verifyModel}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  };
  const masked = maskKey(key);
  try {
    const response = await fetchUpstream(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(body),
    }, config);
    if (response.ok) {
      await response.text(); // 消费响应体，释放连接
      emit({ key: masked, status: "GOOD" });
      recordVerification(key, "GOOD");
    } else {
      const errorData = await response.json().catch(() => ({ error: { message: "Unknown error" } }));
      const message = errorData.error?.message ?? `HTTP ${response.status}`;
      emit({ key: masked, status: "BAD", error: message });
      recordVerification(key, "BAD", message);
    }
  } catch (err) {
    const message = isTimeoutError(err) ? `timeout after ${config.upstreamTimeoutMs}ms` : (err?.message ?? String(err));
    emit({ key: masked, status: "ERROR", error: message });
    recordVerification(key, "ERROR", message);
  }
}

/** 校验一组 Key，逐个以 SSE 事件返回结果（与 gemini-balance-lite 行为一致） */
export function verifyKeys(keys, config) {
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (payload) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // 先发一个 SSE 注释，避免反向代理在第一个结果返回前就判定超时
      emit({ info: `verifying ${keys.length} key(s) with model ${config.verifyModel}` });
      try {
        await Promise.all(keys.map((key) => verifyKey(key, config, emit)));
      } catch (err) {
        log.error(`verify failed: ${err?.message ?? err}`);
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    },
  });
}
