'use strict';

/**
 * syncWorkerProcess.js — corre el worker REAL (`src/workers/syncWorker.js`) en
 * un proceso aparte, con la zona horaria pedida y el reloj simulado precargado
 * (fakeZkPreload.js), hasta que terminen los trabajos indicados.
 *
 * Sin Redis (REDIS_URL inválida → caminos de respaldo de la app), auto-polling
 * bloqueado y el writer del motor de jornada apagado (recálculo legacy).
 */
const path = require('path');
const { spawn } = require('child_process');

const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKER = path.join(API_ROOT, 'src', 'workers', 'syncWorker.js');
const PRELOAD = path.join(__dirname, 'fakeZkPreload.js');

async function runSyncWorker({ conn, cfg, jobIds, tz, recordsFile, env = {} }) {
  const child = spawn(process.execPath, ['-r', PRELOAD, WORKER], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      TZ: tz,
      DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_USER: cfg.user, DB_PASSWORD: cfg.password, DB_NAME: cfg.database,
      REDIS_URL: 'disabled://',
      ZKTECO_AUTO_POLL: 'false',
      WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED: 'false',
      FAKE_ZK_RECORDS: recordsFile,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    for (let i = 0; i < 600; i += 1) {
      const [pending] = await conn.query(
        "SELECT COUNT(*) AS n FROM sync_jobs WHERE id IN (?) AND status IN ('queued','running')", [jobIds],
      );
      if (Number(pending[0].n) === 0) return;
      if (child.exitCode != null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`el worker no terminó los trabajos ${jobIds}:\n${output.slice(-2000)}`);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
}

module.exports = { runSyncWorker };
