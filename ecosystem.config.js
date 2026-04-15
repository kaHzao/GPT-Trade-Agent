// PM2 config — jalankan dengan: pm2 start ecosystem.config.js
// Install PM2: npm install -g pm2
// Stop:        pm2 stop gpt-trade-agent
// Logs:        pm2 logs gpt-trade-agent

module.exports = {
  apps: [{
    name:            'gpt-trade-agent',
    script:          'npm',
    args:            'run trade',
    cron_restart:    '*/15 * * * *',  // setiap 15 menit
    watch:           false,
    autorestart:     false,           // jangan restart otomatis (bukan daemon)
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file:        './bot.log',
    error_file:      './bot-error.log',
    merge_logs:      true,
  }],
};
