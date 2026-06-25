const path = require('path');

const appRoot = __dirname;
const logsDir = path.join(appRoot, 'logs');

module.exports = {
  apps: [
    {
      name: 'msg',
      cwd: appRoot,
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production'
      },
      error_file: path.join(logsDir, 'error.log'),
      out_file: path.join(logsDir, 'out.log'),
      merge_logs: true
    }
  ]
};
