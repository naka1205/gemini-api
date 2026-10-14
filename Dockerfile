# gemini-api 容器镜像（零第三方依赖，仅需 Node 运行时）
# 与仓库 PM2 部署等价：进程入口 src/index.js，配置全部来自环境变量。
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:${PORT:-8787}/health || exit 1
USER node
CMD ["node", "src/index.js"]
