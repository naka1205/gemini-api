#!/usr/bin/env node
// 部署自检脚本：检查 .env 里的 Key 是否可用、各接口是否正常。
//
//   node scripts/check-api.mjs                     # 启动本地服务自检（读取项目根目录 .env）
//   node scripts/check-api.mjs --keys-only         # 只逐个校验 Key，不消耗对话额度
//   node scripts/check-api.mjs --url https://api.example.com --token <PROXY_TOKEN>   # 检查已部署的服务
//
// Key 只会以「前 10 个字符」的形式打印，不会输出完整 Key。
import { spawn } from "node:child_process";
import { createConfig, loadEnvFile } from "../src/env.js";

const HELP = `用法: node scripts/check-api.mjs [选项]
  --url <地址>        检查已部署的服务（默认启动本地服务自检）
  --token <令牌>      访问令牌，默认取 .env 里的 PROXY_TOKEN
  --model <模型>      测试用模型，默认取 .env 里的 VERIFY_MODEL（gemini-2.5-flash）
  --port <端口>       本地模式监听端口，默认 8799
  --keys-only         只校验 Key，跳过对话类接口
  --help              显示帮助`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--keys-only") args.keysOnly = true;
    else if (item.startsWith("--")) args[item.slice(2)] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

loadEnvFile();
const config = createConfig();
const token = args.token ?? config.proxyToken;
const model = args.model ?? config.verifyModel;
const localMode = !args.url;
const port = Number.parseInt(args.port ?? "8799", 10);
const base = (args.url ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const ok = (text) => paint(32, text);
const bad = (text) => paint(31, text);
const dim = (text) => paint(90, text);

const headers = (extra = {}) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
const jsonHeaders = (extra = {}) => headers({ "content-type": "application/json", ...extra });

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
    console.log(`  ${ok("[通过]")} ${name}${detail ? dim(`  ${detail}`) : ""} ${dim(`${((Date.now() - started) / 1000).toFixed(1)}s`)}`);
  } catch (err) {
    const message = err?.message ?? String(err);
    results.push({ ok: false, name, detail: message });
    console.log(`  ${bad("[失败]")} ${name}  ${bad(message)}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let child = null;
let childLog = "";
async function startLocalServer() {
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LOG_REQUESTS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { childLog += d; });
  child.stderr.on("data", (d) => { childLog += d; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // 尚未启动
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`本地服务启动失败：\n${childLog}`);
}

console.log(`\n检查目标：${base}${localMode ? "（本地模式，使用 .env 配置）" : ""}`);
console.log(`模型：${model} | 访问令牌：${token ? "已提供" : "无"}`);
if (localMode) {
  console.log(`服务端 Key：${config.apiKeys.length} 个 ${config.apiKeys.map((k) => k.slice(0, 10) + "…").join(", ") || dim("(未配置)")}`);
  assert(config.apiKeys.length > 0, "请在 .env 中配置 GEMINI_API_KEYS");
}

try {
  if (localMode) {
    await startLocalServer();
  }

  await check("GET /health", async () => {
    const response = await fetch(`${base}/health`);
    assert(response.ok, `HTTP ${response.status}`);
    const body = await response.json();
    return `版本 ${body.version}，服务端 Key ${body.apiKeyCount} 个，策略 ${body.keyStrategy}`;
  });

  await check("POST /verify（逐个 Key 校验）", async () => {
    const response = await fetch(`${base}/verify`, { method: "POST", headers: headers() });
    assert(response.status === 200, `HTTP ${response.status}`);
    const rows = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((row) => row.key);
    assert(rows.length > 0, "没有返回任何校验结果");
    for (const row of rows) {
      const verdict = row.status === "GOOD" ? ok("可用  ") : bad(`不可用(${row.status})`);
      console.log(`         ${verdict} ${row.key}${row.error ? dim(`  ← ${String(row.error).slice(0, 90)}`) : ""}`);
    }
    const good = rows.filter((row) => row.status === "GOOD").length;
    return `${good}/${rows.length} 个 Key 可用`;
  });

  if (!args.keysOnly) {
    await check("Gemini 原生 POST /v1beta/models/{model}:generateContent", async () => {
      const response = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "只回复两个字：可用" }] }] }),
      });
      const body = await response.json();
      assert(response.status === 200, `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text).join("").trim() ?? "";
      assert(text.length > 0, "返回内容为空");
      return `回复「${text.slice(0, 12)}」`;
    });

    await check("Gemini 原生流式 ?alt=sse", async () => {
      const response = await fetch(`${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "数到三" }] }] }),
      });
      assert(response.status === 200, `HTTP ${response.status}`);
      assert(/text\/event-stream/.test(response.headers.get("content-type") ?? ""), "响应不是 SSE");
      const text = await response.text();
      assert(text.includes("candidates"), "SSE 内容异常");
      const events = text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).length;
      return `${events} 个 SSE 事件`;
    });

    await check("OpenAI POST /v1/chat/completions", async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ model, messages: [{ role: "user", content: "只回复两个字：正常" }] }),
      });
      const body = await response.json();
      assert(response.status === 200, `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
      assert(body.object === "chat.completion", `响应结构异常：${body.object}`);
      return `回复「${String(body.choices?.[0]?.message?.content ?? "").slice(0, 12)}」tokens=${body.usage?.total_tokens}`;
    });

    await check("OpenAI 流式 stream:true", async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "数到三" }] }),
      });
      assert(response.status === 200, `HTTP ${response.status}`);
      const text = await response.text();
      assert(text.includes("chat.completion.chunk"), "缺少 OpenAI 流式结构");
      assert(text.includes("[DONE]"), "缺少 [DONE] 结束标记");
      return `${(text.match(/chat\.completion\.chunk/g) ?? []).length} 个 chunk`;
    });

    await check("OpenAI GET /v1/models", async () => {
      const response = await fetch(`${base}/v1/models`, { headers: headers() });
      assert(response.ok, `HTTP ${response.status}`);
      const body = await response.json();
      assert(body.data?.length > 0, "模型列表为空");
      return `${body.data.length} 个模型`;
    });
  }

  await check("GET /dashboard.json（每个 Key 的统计）", async () => {
    const response = await fetch(`${base}/dashboard.json`, { headers: headers() });
    assert(response.ok, `HTTP ${response.status}`);
    const data = await response.json();
    for (const key of data.keys) {
      console.log(`         ${key.prefix}…(${key.length}位) 请求=${key.requests} 成功=${key.success} 失败=${key.failed} 429=${key.rateLimited} 校验=${key.verified ?? "-"}`);
    }
    assert(data.keys.every((key) => key.prefix.length <= 10), "接口返回了超过 10 位的 Key 前缀");
    return `共 ${data.totals.requests} 次请求，${data.keys.length} 个 Key 有记录`;
  });
} catch (err) {
  console.log(`\n${bad("无法完成检查：")}${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 项通过${failed.length ? bad("（存在失败项）") : ""}`);
process.exitCode = failed.length ? 1 : (process.exitCode ?? 0);
