# Gemini API Proxy（Node.js / PM2 版）

`gemini-balance-lite` 的 Node.js 重写版：把原来只能在 Vercel / Deno / Cloudflare Workers / Netlify 等边缘函数里跑的 Gemini API 代理与多 Key 负载均衡，改成 **一个可以用 PM2 部署在自己 VPS 上的常驻 Node.js 服务**。

- 原项目：[tech-shrimp/gemini-balance-lite](https://github.com/tech-shrimp/gemini-balance-lite)（作者：技术爬爬虾）
- OpenAI 兼容层：[PublicAffairs/openai-gemini](https://github.com/PublicAffairs/openai-gemini)
- 本仓库：`gemini-api`，**零第三方依赖**（只用 Node 内置模块），克隆下来配好 `.env` 就能跑

## 相比边缘函数版的变化

| 项目 | 边缘函数版 | 本版（VPS / PM2） |
| --- | --- | --- |
| 运行环境 | Vercel / Deno / CF Worker / Netlify | 任意 VPS，Node.js ≥ 20，PM2 常驻 |
| API Key 来源 | 只能由客户端每次请求携带 | 支持服务端统一配置（`GEMINI_API_KEYS`），客户端也可自带 Key |
| 访问控制 | 无 | 可选 `PROXY_TOKEN` 访问令牌，避免 VPS 被白嫖 |
| 负载均衡 | 每次请求随机 | 随机（默认，行为与原版一致）或轮询 `round-robin` |
| 超时控制 | 由平台决定 | `UPSTREAM_TIMEOUT_MS` 可控；`server.requestTimeout = 0`，长请求/流式不会被截断 |
| 运维 | 平台日志 | `pm2 logs`、`/health` 健康检查、优雅重启、自动重启 |
| 监控 | 无 | `/dashboard` 健康监控页：每个 Key 的请求数 / 成功率 / 429 / 校验状态（只显示 Key 前 10 位） |
| 入口数量 | 4 套平台适配文件 | 1 个 `src/index.js` |

接口完全兼容原版：Gemini 原生格式 `/v1beta/...`、OpenAI 格式 `/v1/chat/completions`、`/v1/models`、`/v1/embeddings`、`/verify`。

## 特性

- **多 Key 负载均衡**：`GEMINI_API_KEYS=key1,key2,key3`，随机或轮询分发，单个 Key 也可以随时透传
- **两种协议**：Gemini 原生 REST 格式 + OpenAI 兼容格式（Chat Completions / Models / Embeddings，支持流式）
- **流式透传**：`?alt=sse` 与 `stream: true` 均为真正的边收边发，已自动加上 `X-Accel-Buffering: no`
- **反向代理友好**：过滤逐跳头、修正 `content-encoding`/`content-length`、透传上游状态码与错误体
- **Key 校验**：`POST /verify` 一次性校验多个 Key（SSE 逐个返回结果）
- **健康检查**：`GET /health` 返回 Key 数量、策略、上游、运行时长
- **健康监控页**：`GET /dashboard` 查看每个 Key 的使用状况与最近请求，Key 只显示前 10 个字符

## 快速开始（VPS + PM2）

前置：一台能访问 Google 的 VPS（**注意：Gemini 不支持香港等地区 IP，VPS 不要选这些地区**），Node.js ≥ 20。

```bash
# 1. 安装 Node.js（示例：NodeSource 20.x，已装可跳过）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 PM2
sudo npm install -g pm2

# 3. 拉取代码
git clone https://gitee.com/naka507/gemini-api.git
cd gemini-api

# 4. 配置（本项目零依赖，无需 npm install）
cp .env.example .env
vim .env   # 至少填写 GEMINI_API_KEYS 和 PROXY_TOKEN

# 5. 用 PM2 启动并设置开机自启
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # 按提示复制执行它输出的那条 sudo 命令

# 6. 验证
curl http://127.0.0.1:8787/health
npm run check:api      # 逐个校验 Key + 各接口连通性自检（会消耗少量额度）
```

`.env` 示例：

```dotenv
PORT=8787
HOST=127.0.0.1                                  # 配合 nginx 反代就写 127.0.0.1，直连公网写 0.0.0.0
GEMINI_API_KEYS=AIzaSy...key1,AIzaSy...key2      # 多个 Key 用英文逗号分隔
KEY_STRATEGY=round-robin                        # random（默认）| round-robin
PROXY_TOKEN=换成一段随机字符串                    # 强烈建议设置
```

### 配置 HTTPS 域名（推荐）

`deploy/nginx.conf.example` 是一份可直接改用的 nginx 配置（已关闭 `proxy_buffering`，否则流式输出会被缓冲）：

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/gemini-api
sudo vim /etc/nginx/sites-available/gemini-api     # 修改 server_name 与端口
sudo ln -s /etc/nginx/sites-available/gemini-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.example.com            # 申请免费证书
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，用 nginx 时建议 `127.0.0.1` |
| `GEMINI_API_KEYS` | 空 | 服务端统一提供的 Key，逗号分隔（别名 `GEMINI_API_KEY` / `API_KEYS`） |
| `KEY_STRATEGY` | `random` | `random` 随机 / `round-robin` 轮询 |
| `PROXY_TOKEN` | 空 | 设置后客户端必须携带该令牌（别名 `ACCESS_TOKEN`） |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com` | 上游地址（可用于自建中转或测试） |
| `GEMINI_API_VERSION` | `v1beta` | 上游 API 版本 |
| `VERIFY_MODEL` | `gemini-2.5-flash` | `/verify` 使用的校验模型 |
| `EMBEDDINGS_MODEL` | `gemini-embedding-2` | `/v1/embeddings`（OpenAI 兼容）默认向量模型，客户端传 `text-embedding-3-small` 这类名字时映射到它 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 连接上游 + 等待响应头超时；流式响应开始后不再计时 |
| `LOG_REQUESTS` | `true` | 是否输出每条请求的访问日志 |
| `DEBUG` | `false` | 详细调试日志（含上游响应头、选中的 Key 掩码等） |
| `TRUST_PROXY` | `true` | 是否从 `X-Forwarded-For` 取客户端 IP 写日志 |
| `ENV_FILE` | `.env` | 环境变量文件路径 |

> 进程环境变量优先于 `.env`；空字符串视为未设置（方便 PM2 里留空让 `.env` 生效）。

## 客户端怎么填

客户端通常只有「Base URL / API Key」两个输入框，推荐这样配：

| 场景 | Base URL | API Key |
| --- | --- | --- |
| **推荐**：服务端配好所有 Key + `PROXY_TOKEN` | `https://api.example.com` | 填 `PROXY_TOKEN` 的值 |
| 临时用：服务端不配 Key | `https://api.example.com` | 填你自己的 Gemini Key，多个用逗号分隔 |
| 混合：服务端配了 Key，也想临时指定 | `https://api.example.com` | 填 `PROXY_TOKEN,你的Key1,你的Key2`（令牌会被自动剔除） |

令牌也可以放在 `x-goog-api-key`、`Authorization: Bearer` 或 `?token=` / `?key=` 里，任选其一。

> 注意：服务端**没设** `PROXY_TOKEN` 时，客户端不要随便填 `sk-xxx` 这类占位 Key——它会被当成真实 Gemini Key 发给 Google 并报 `API key not valid`。这种情况请把 Key 留空（使用服务端配置的 Key），或填真实 Key。

## API 说明

### Gemini 原生格式代理

```bash
curl -X POST 'https://api.example.com/v1beta/models/gemini-2.5-flash:generateContent' \
  -H 'Content-Type: application/json' \
  -H 'x-goog-api-key: <PROXY_TOKEN 或 你的 Gemini Key>' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'
```

流式（逐块返回）：

```bash
curl -N -X POST 'https://api.example.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' \
  -H 'Content-Type: application/json' \
  -H 'x-goog-api-key: <PROXY_TOKEN 或 你的 Gemini Key>' \
  -d '{"contents":[{"role":"user","parts":[{"text":"写一首关于秋天的短诗"}]}]}'
```

### OpenAI 兼容格式

```bash
curl -X POST 'https://api.example.com/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <PROXY_TOKEN 或 你的 Gemini Key>' \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"你好"}]}'
```

```bash
curl 'https://api.example.com/v1/models' -H 'Authorization: Bearer <PROXY_TOKEN>'
```

### Key 校验

```bash
curl -N -X POST 'https://api.example.com/verify' \
  -H 'x-goog-api-key: <PROXY_TOKEN>,<GEMINI_API_KEY_1>,<GEMINI_API_KEY_2>'
# data: {"key":"AIzaSy...ab12","status":"GOOD"}
# data: {"key":"AIzaSy...cd34","status":"BAD","error":"API key not valid..."}
```

### 健康检查

```bash
curl 'https://api.example.com/health'
```

## 向量化 / Embedding（写入向量数据库）

Embedding 的作用就是**把数据变成向量，存进向量数据库**（pgvector / Qdrant / Milvus / Chroma / LanceDB…），之后用余弦相似度做语义检索，用来支撑 RAG 知识库、语义搜索、文本去重、聚类、推荐。`gemini-embedding-2` 就是 Google 现在做这件事的模型，而且它不只吃文本——**图片/音频/视频也能直接转成同一个向量空间**。

### 可用模型（用你的 Key 实测）

| 模型 | 输入 | 默认维度 | 单次输入上限 |
| --- | --- | --- | --- |
| `gemini-embedding-2` / `gemini-embedding-2-preview` | 文本 + 图片等多模态 | 3072 | 8192 token |
| `gemini-embedding-001` | 仅文本（上一代） | 3072 | 2048 token |

> 老的 `text-embedding-004` 已下线（直接返回 404），本代理把 OpenAI 模型名（如 `text-embedding-3-small`）映射到 `EMBEDDINGS_MODEL`，默认就是 `gemini-embedding-2`。

### 实测出来的几个关键点

- **维度可截断**：默认 3072 维，传 `outputDimensionality: 768` 就返回 768 维（Matryoshka 截断，省存储、检索质量损失很小）。**入库维度定了就不要改**，改了要整库重新向量化。
- **`taskType` 8 种取值全部可用**：`RETRIEVAL_DOCUMENT`（文档入库用）、`RETRIEVAL_QUERY`（用户查询用）、`SEMANTIC_SIMILARITY`、`CLASSIFICATION`、`CLUSTERING`、`QUESTION_ANSWERING`、`FACT_VERIFICATION`、`CODE_RETRIEVAL_QUERY`。入库和查询**要用对应的 taskType**，检索效果明显更好。
- **多模态可混用**：一次请求里可以同时放文本和图片（`parts: [{text}, {inlineData}]`），实测返回 3072 维。
- **批量单次最多 100 条**，超过会报 `at most 100 requests can be in one batch`；客户端记得分片。
- **一个 collection / 表只能用一种向量模型**（硬性要求，不是偏好）：维度相同也不行——`gemini-embedding-001` 与 `gemini-embedding-2` 同为 768/3072 维，实测同一句话的向量余弦只有 0.007，混用后相似度整体塌到 0 附近，检索会静默失效。同一模型内还要统一维度与 `taskType` 约定；要换模型就新建表并整库重算。
- **检索层与生成层解耦**：向量库只负责「找出原文」，命中片段是纯文本，发给 GPT / Claude / Qwen / DeepSeek 都行；换大模型不需要重新向量化，只有换 embedding 模型才需要整库重算——所以原创文本和元数据一定要和向量一起存。
- **免费层 embedding 配额较紧**：一批 100 条会消耗 100 次请求额度，实测会直接撞到 429。多配几个 Key 会自动分摊，`/dashboard` 能看到是哪个 Key 被限流。
- **相似度实测**（`SEMANTIC_SIMILARITY`，768 维）：`小猫在沙发上睡觉` ↔ `cat sleeping on the sofa` = **0.71**，↔ `今天股市大跌` = **0.40**，跨语言也有区分度。

### 三种调用方式

单条（Gemini 原生格式）：

```bash
curl -X POST 'https://api.example.com/v1beta/models/gemini-embedding-2:embedContent' \
  -H 'Content-Type: application/json' -H 'x-goog-api-key: <PROXY_TOKEN>' \
  -d '{"content":{"parts":[{"text":"小猫在沙发上睡觉"}]},"taskType":"RETRIEVAL_DOCUMENT","outputDimensionality":768}'
# {"embedding":{"values":[... 768 个浮点数 ...]}}
```

批量入库（推荐，一次 ≤100 条）：

```bash
curl -X POST 'https://api.example.com/v1beta/models/gemini-embedding-2:batchEmbedContents' \
  -H 'Content-Type: application/json' -H 'x-goog-api-key: <PROXY_TOKEN>' \
  -d '{"requests":[
        {"model":"models/gemini-embedding-2","content":{"parts":[{"text":"第一段"}]},"taskType":"RETRIEVAL_DOCUMENT","outputDimensionality":768},
        {"model":"models/gemini-embedding-2","content":{"parts":[{"text":"第二段"}]},"taskType":"RETRIEVAL_DOCUMENT","outputDimensionality":768}
      ]}'
```

OpenAI 兼容格式（Cherry Studio / Dify / LangChain / LlamaIndex 等把 Base URL 指向本代理即可，`dimensions` 会映射成 `outputDimensionality`）：

```bash
curl -X POST 'https://api.example.com/v1/embeddings' \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer <PROXY_TOKEN>' \
  -d '{"model":"gemini-embedding-2","input":["你好世界","hello world"],"dimensions":768}'
```

### 一个可以照抄的最小流程（Node.js）

```js
const BASE = "https://api.example.com";
const TOKEN = process.env.PROXY_TOKEN;   // 服务端没设 PROXY_TOKEN 时留空即可
const MODEL = "gemini-embedding-2";
const DIM = 768; // 入库维度，定下来就别改
const headers = { "content-type": "application/json", ...(TOKEN ? { "x-goog-api-key": TOKEN } : {}) };

async function embed(texts, taskType) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += 100) {            // 单次最多 100 条
    const res = await fetch(`${BASE}/v1beta/models/${MODEL}:batchEmbedContents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requests: texts.slice(i, i + 100).map((text) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: DIM,
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
    vectors.push(...data.embeddings.map((item) => item.values));
  }
  return vectors;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
};

// 入库：文档用 RETRIEVAL_DOCUMENT
const chunks = ["小猫喜欢在沙发上睡觉", "今天股市大跌"];
const docVectors = await embed(chunks, "RETRIEVAL_DOCUMENT");

// 查询：用户问题用 RETRIEVAL_QUERY，再按余弦相似度取 top-k
const [queryVector] = await embed(["猫咪在哪里休息？"], "RETRIEVAL_QUERY");
const ranked = chunks
  .map((text, i) => ({ text, score: cosine(queryVector, docVectors[i]) }))
  .sort((a, b) => b.score - a.score);
console.log(ranked); // 第一条「小猫喜欢在沙发上睡觉」分数最高
```

入库时把 `docVectors` 存到向量数据库（pgvector / Qdrant / Milvus…），检索时对查询向量做同一种相似度计算即可。

> 存储提示：pgvector 的 `vector` 类型建索引有维度上限（2000 维），3072 维可以截断到 1536/768，或改用 `halfvec`；Qdrant / Milvus 没有这个限制。余弦相似度请对向量做归一化或用数据库自带的 `cosine_distance`。

## 健康监控页

浏览器打开（服务端设置了 `PROXY_TOKEN` 时必须带令牌，首次打开会把令牌写入 HttpOnly Cookie，之后自动刷新不再暴露在 URL 里）：

```
http://<服务器IP>:8787/dashboard?token=<PROXY_TOKEN>
https://api.example.com/dashboard?token=<PROXY_TOKEN>
```

页面每 5 秒自动刷新（可暂停），显示：

- **总览**：运行时长、总请求数、成功率、Key 数量、负载均衡策略
- **每个 Key 的状态**：请求数 / 成功 / 失败、`429`（配额用尽）、`401|403`（Key 无效）、`5xx`、`/verify` 校验结果、最近状态码、最近使用时间、最近调用的路径（鼠标悬停可看最近一次错误原因）
- **最近 20 条请求**：时间、来源（Gemini 接口 / OpenAI 接口）、方法、路径、状态码、耗时、使用的 Key

**Key 只展示前 10 个字符**，完整 Key 不会出现在页面或接口返回里。同样的数据可以用 JSON 获取（便于接入自己的监控）：

```bash
curl 'https://api.example.com/dashboard.json'                     # 未启用令牌时
curl 'https://api.example.com/dashboard.json?token=<PROXY_TOKEN>'  # 启用令牌时
```

`/monitor` 是同一页面的别名。统计保存在进程内存中，`pm2 restart` 后清零；PM2 多实例（cluster）时每个 worker 只统计自己处理的请求。

## PM2 常用命令

```bash
pm2 logs gemini-api          # 查看日志（含访问日志）
pm2 restart gemini-api       # 重启
pm2 describe gemini-api      # 查看运行详情
pm2 save                     # 保存进程列表（开机自启依赖它）
```

改完 `.env` 或代码后：`pm2 restart gemini-api --update-env`。

多核扩容（`ecosystem.config.cjs` 里 `instances: 2, exec_mode: "cluster"`）：轮询/随机计数在每个 worker 内独立，功能正常，但对 `round-robin` 的绝对均匀性有影响；单实例下最精确。SSE 流式在 cluster 模式下也可正常工作。

## 常见问题

- **返回 `404` 或 `User location is not supported for the API use`**：VPS 所在地不被 Gemini 支持（如香港），换机房或加一层出口代理。
- **流式输出一次性全部出现**：反向代理在缓冲响应。用 `deploy/nginx.conf.example`，里面已设置 `proxy_buffering off`（服务端也会返回 `X-Accel-Buffering: no`）。
- **`401 Unauthorized: 缺少或错误的访问令牌`**：服务端设了 `PROXY_TOKEN`，但客户端没带或带错了令牌。
- **`401 No Gemini API key`**：既没配 `GEMINI_API_KEYS`，客户端也没传 Key。
- **`/verify` 显示 BAD，但 Key 明明是好的**：`/verify` 只区分「上游 2xx / 非 2xx」，遇到 `503 high demand`、`429` 这类瞬时错误也会判为 BAD；监控页的「校验」列悬停可以看到上游返回的真实原因，过一会儿再校验即可。
- **监控页 `401`**：地址里没带 `?token=`，或令牌与 `PROXY_TOKEN` 不一致（Cookie 过期后重新带 `?token=` 打开一次即可）。
- **大文件/长请求被断开**：确认走的是本项目（`requestTimeout = 0` 已放宽）；若用了 nginx，检查 `proxy_read_timeout`。
- **上游 429 / 配额用尽**：多配几个 Key 即可分摊；本版不自动重试，错误会原样返回给客户端。

## 本地开发与自检

```bash
cp .env.example .env      # 填一个真实 Key
npm start                 # 或 npm run dev（--watch 自动重启）
npm run check             # 语法检查
npm run check:api         # 接口自检：逐个 Key 校验 + 各接口打通（真实请求，几十 token）
curl http://127.0.0.1:8787/
```

`check:api` 常用参数：

```bash
npm run check:api -- --keys-only                                   # 只校验 Key，不消耗对话额度
npm run check:api -- --url http://<VPS_IP>:8787 --token <TOKEN>    # 检查已部署的实例
npm run check:api -- --url https://api.example.com --token <TOKEN> # 检查走 nginx 的域名
```

> 在 VPS 上改完 `.env`（例如新增 Key）后需要 `pm2 restart gemini-api` 才会生效，然后可以打开 `/dashboard` 或跑一次 `npm run check:api -- --keys-only` 确认。

## 目录结构

```
src/index.js          HTTP 服务入口（监听、访问日志、优雅退出）
src/handle_request.js 路由：状态页 / /health / /verify / OpenAI / Gemini 原生代理
src/api_keys.js       Key 解析、令牌校验、随机与轮询负载均衡
src/openai.js         OpenAI 兼容层（移植自 PublicAffairs/openai-gemini）
src/verify_keys.js    /verify 的 SSE 校验实现
src/dashboard.js      健康监控页（HTML + /dashboard.json）
src/metrics.js        进程内指标统计（按 Key 计数、最近请求）
src/upstream.js       上游请求、超时、请求/响应头清洗
src/http_adapter.js   Node req/res 与 Fetch API 的双向适配
src/env.js            .env 读取与配置解析
src/errors.js         统一错误响应
src/logger.js         日志与 Key 掩码
ecosystem.config.cjs  PM2 配置
deploy/nginx.conf.example  nginx 反代示例
scripts/check-api.mjs      部署自检脚本（npm run check:api）
```

## 致谢与许可

原作者：[技术爬爬虾](https://space.bilibili.com/316183842)（[gemini-balance-lite](https://github.com/tech-shrimp/gemini-balance-lite)）；OpenAI 兼容层作者：[PublicAffairs](https://github.com/PublicAffairs/openai-gemini)。本项目沿用 MIT License，详见 [LICENSE](LICENSE)。
