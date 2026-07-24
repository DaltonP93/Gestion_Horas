/**
 * PM2 Ecosystem — SisHoras
 * Uso en producción:
 *   pm2 start ecosystem.config.js
 *   pm2 reload ecosystem.config.js --update-env
 */
module.exports = {
  apps: [
    {
      name: 'sishoras-api',
      cwd: './api',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        TZ: 'America/Asuncion',   // Paraguay — corrige timestamps en logs y queries
      },
      error_file: '../logs/api-error.log',
      out_file:   '../logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
    },
    {
      // Worker de sincronización automática de relojes ZKTeco (FASE 2).
      // ARRANCA BLOQUEADO: ZKTECO_AUTO_POLL=false es kill switch absoluto —
      // el worker corre pero no lee relojes hasta ponerlo en true Y activar
      // la sincronización desde Configuración → Relojes.
      name: 'sishoras-sync-worker',
      cwd: './api',
      script: 'src/workers/syncWorker.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Asuncion',
        // Kill switch: respeta la variable del entorno si está definida; por
        // defecto 'false' (auto-polling BLOQUEADO). La cola manual funciona igual.
        ZKTECO_AUTO_POLL: process.env.ZKTECO_AUTO_POLL || 'false',
      },
      error_file: '../logs/sync-worker-error.log',
      out_file:   '../logs/sync-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '256M',
    },
    {
      name: 'sishoras-web',
      cwd: './web',
      script: 'node_modules/.bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        TZ: 'America/Asuncion',
      },
      error_file: '../logs/web-error.log',
      out_file:   '../logs/web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
    },
    {
      name: 'sishoras-bridge',
      cwd: './bridge',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Asuncion',
        BRIDGE_API_PORT: 8081,   // API del bridge (8080 es el PUSH de los relojes)
        BRIDGE_BIND: '127.0.0.1',
      },
      error_file: '../logs/bridge-error.log',
      out_file:   '../logs/bridge-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '256M',
    },
    {
      // Analytics (FastAPI). Requiere el entorno virtual local: analytics/.venv
      name: 'sishoras-analytics',
      cwd: './analytics',
      script: '.venv/bin/uvicorn',
      args: 'main:app --host 127.0.0.1 --port 5000',
      interpreter: '.venv/bin/python',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        TZ: 'America/Asuncion',
      },
      error_file: '../logs/analytics-error.log',
      out_file:   '../logs/analytics-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
    },
  ],
}
