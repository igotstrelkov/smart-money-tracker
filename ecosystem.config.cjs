module.exports = {
  apps: [
    {
      name: "smart-money-tracker",
      script: "./node_modules/.bin/tsx",
      args: "src/index.ts",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: { NODE_ENV: "production" },
    },
  ],
};
