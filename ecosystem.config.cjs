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
      // Procesar CVs (PDFs en memoria + OCR Tesseract + render de páginas) supera fácil 512M;
      // si PM2 reinicia a media carga, el navegador ve «Failed to fetch» y la carga se pierde.
      max_memory_restart: process.env.MSG_MAX_MEMORY || '2G',
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3445
      },
      error_file: path.join(logsDir, 'error.log'),
      out_file: path.join(logsDir, 'out.log'),
      merge_logs: true
    }
  ]
};
