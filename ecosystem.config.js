/**
 * PM2 Ecosystem — SisHoras
 *
 * Las rutas se resuelven desde la release que contiene este archivo. En un
 * cambio de release inmutable no usar reload: PM2 conserva el cwd anterior.
 * Seguir deploy/RUNBOOK-release-inmutable-pm2.md.
 */
const path = require('node:path');

const RELEASE_ROOT = __dirname;
const fromRelease = (...parts) => path.join(RELEASE_ROOT, ...parts);

module.exports = {
  apps: [
    {
      name: 'sishoras-api',
      cwd: fromRelease('api'),
      script: fromRelease('api', 'src', 'index.js'),
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        TZ: 'America/Asuncion',   // Paraguay — corrige timestamps en logs y queries
      },
      error_file: fromRelease('logs', 'api-error.log'),
      out_file:   fromRelease('logs', 'api-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
    },
    {
      // Worker de sincronización automática de relojes ZKTeco (FASE 2).
      // ARRANCA BLOQUEADO: ZKTECO_AUTO_POLL=false es kill switch absoluto —
      // el worker corre pero no lee relojes hasta ponerlo en true Y activar
      // la sincronización desde Configuración → Relojes.
      name: 'sishoras-sync-worker',
      cwd: fromRelease('api'),
      script: fromRelease('api', 'src', 'workers', 'syncWorker.js'),
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
      error_file: fromRelease('logs', 'sync-worker-error.log'),
      out_file:   fromRelease('logs', 'sync-worker-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Lecturas de relojes con buffers grandes (Comedor ~82k registros) pueden
      // superar brevemente 256M durante la lectura multi-intento y disparar el
      // reinicio por memoria de PM2. Se sube a 512M SÓLO para este proceso.
      // NOTA: max_memory_restart es un UMBRAL DE REINICIO de PM2, no memoria
      // reservada: el proceso usa lo que necesita y PM2 lo reinicia si supera
      // este valor. No preasigna 512M.
      // ANTES de aplicarlo en producción, verificar memoria disponible:
      //   free -h   (debe haber holgura suficiente para +256M en este proceso)
      max_memory_restart: '512M',
    },
    {
      name: 'sishoras-web',
      cwd: fromRelease('web'),
      script: fromRelease('web', 'node_modules', '.bin', 'next'),
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        TZ: 'America/Asuncion',
      },
      error_file: fromRelease('logs', 'web-error.log'),
      out_file:   fromRelease('logs', 'web-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
    },
    {
      name: 'sishoras-bridge',
      cwd: fromRelease('bridge'),
      script: fromRelease('bridge', 'src', 'index.js'),
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Asuncion',
        BRIDGE_API_PORT: 8081,   // API del bridge (8080 es el PUSH de los relojes)
        BRIDGE_BIND: '127.0.0.1',
      },
      error_file: fromRelease('logs', 'bridge-error.log'),
      out_file:   fromRelease('logs', 'bridge-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '256M',
    },
    {
      // Analytics (FastAPI). Requiere el entorno virtual local: analytics/.venv
      name: 'sishoras-analytics',
      cwd: fromRelease('analytics'),
      script: fromRelease('analytics', '.venv', 'bin', 'uvicorn'),
      args: 'main:app --host 127.0.0.1 --port 5000',
      interpreter: fromRelease('analytics', '.venv', 'bin', 'python'),
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        TZ: 'America/Asuncion',
      },
      error_file: fromRelease('logs', 'analytics-error.log'),
      out_file:   fromRelease('logs', 'analytics-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
    },
  ],
}
