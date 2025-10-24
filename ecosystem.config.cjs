module.exports = {
  apps: [{
    name: "lumina-bot",
    script: "src/bot.js",
    node_args: "--env-file=.env",
    watch: false,
    max_memory_restart: "300M",
    env: { NODE_ENV: "production" }
  }]
};
