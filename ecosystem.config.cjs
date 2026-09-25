// PM2 配置：pm2 start ecosystem.config.cjs
// 环境变量请写在项目根目录的 .env 文件里（由 src/env.js 在启动时读取），
// 也可以直接写在这里的 env 字段中（.env 会被 PM2 的 env 覆盖优先级低，进程环境变量始终优先）。
module.exports = {
  apps: [
    {
      name: "gemini-api",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      kill_timeout: 10000,
      listen_timeout: 10000,
      wait_ready: false,
      merge_logs: true,
      time: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      env: {
        NODE_ENV: "production",
        PORT: 8787,
        HOST: "0.0.0.0",
      },
    },
  ],
};
