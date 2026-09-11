// =====================================================================
// Foco de Elite — configuração do PM2
//
// Uso (a partir da raiz do projeto, com o .env já preenchido):
//
//   pm2 start docs/ecosystem.config.js --env production
//   pm2 save
//   pm2 logs focoelite
//   pm2 reload focoelite            # recarrega sem derrubar a aplicação
//
// As variáveis sensíveis (banco, segredos, chaves do OpenRouter e do Asaas, SMTP)
// NÃO ficam aqui: elas vivem no arquivo .env da raiz, que o server/config.js
// carrega. Este arquivo define apenas como o processo é executado.
// =====================================================================
'use strict';

const path = require('node:path');

// docs/ está um nível abaixo da raiz do projeto.
const rootDir = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'focoelite',
      cwd: rootDir,
      script: 'server/index.js',
      // Uma instância só: o rate limit e o cache de configurações vivem em memória.
      // Para escalar horizontalmente é preciso movê-los para o Redis antes.
      instances: 1,
      exec_mode: 'fork',

      // Reinício automático
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 10000, // dá tempo ao encerramento gracioso do server/index.js
      wait_ready: false,

      // Logs (pm2 install pm2-logrotate cuida da rotação)
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: '/var/log/focoelite/out.log',
      error_file: '/var/log/focoelite/error.log',

      env: {
        NODE_ENV: 'development',
        PORT: 4100,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4100,
      },
    },
  ],
};
