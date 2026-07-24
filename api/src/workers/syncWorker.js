/**
 * syncWorker.js — Worker PM2 de sincronización de relojes ZKTeco.
 *
 * Proceso SEPARADO de la API (sishoras-sync-worker):
 *   1) Auto-polling programado (respeta kill switch + master + ventana).
 *   2) Drena la cola de trabajos manuales (sync_jobs) SIN bloquear la API.
 * Ambos caminos usan el MISMO lock por reloj → nunca hay lecturas superpuestas.
 *
 * Kill switch (ZKTECO_AUTO_POLL):
 *   false → bloquea el AUTO-polling de forma absoluta (aunque la base diga
 *           activado). Los trabajos MANUALES (iniciados por una persona) SÍ se
 *           procesan: son acciones explícitas, no polling automático.
 *   true  → la base decide (master global + ventana + config por reloj).
 * El heartbeat y el estado se escriben SIEMPRE, incluso con kill switch en false.
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const { backupDeviceDirect } = require('../services/zktecoReader');
const { pyHHMM, pyDate, inWindow, computeNextRun } = require('../services/syncSchedule');
const syncJobs = require('../services/syncJobs');

const TICK_MS = 10_000;             // más frecuente para responder a la cola manual
const OWNER = `worker:${process.pid}`;
const running = new Set();          // lock en memoria por reloj (auto)
let redisPub = null;

const killSwitchOn = () => String(process.env.ZKTECO_AUTO_POLL).toLowerCase() === 'true';

// ─── settings (notification_settings key→value) ─────────────────
async function getSetting(key, def) {
  try {
    const [[r]] = await sequelize.query(
      'SELECT setting_value AS v FROM notification_settings WHERE setting_key = ?',
      { replacements: [key] });
    return r ? r.v : def;
  } catch { return def; }
}
async function setSetting(key, val) {
  try {
    await sequelize.query(
      `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      { replacements: [key, val] });
  } catch { /* best-effort */ }
}

// ─── Redis (para re-emitir por WebSocket desde la API) ──────────
async function initPub() {
  try {
    const { createClient } = require('redis');
    redisPub = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    redisPub.on('error', e => logger.warn('sync-worker redis: ' + e.message));
    await redisPub.connect();
  } catch (e) { redisPub = null; logger.warn('sync-worker sin Redis (sin WebSocket): ' + e.message); }
}
async function publish(payload) {
  try { if (redisPub) await redisPub.publish('sync:completed', JSON.stringify(payload)); } catch { /* opcional */ }
}

// Rango por defecto: ayer→hoy (cubre medianoche).
function defaultRange() {
  return { from: pyDate(new Date(Date.now() - 86_400_000)), to: pyDate() };
}

// ─── Auto-polling: ejecución programada por reloj ───────────────
async function runDevice(d) {
  const { from, to } = defaultRange();
  const t0 = Date.now();
  try {
    const r = await backupDeviceDirect(d, {
      from, to, recalc: true,
      attempts: d.auto_sync_attempts || 3,
      cooldownMs: (d.auto_sync_cooldown_sec || 4) * 1000,
      readTimeoutMs: (d.auto_sync_timeout_sec || 600) * 1000,
      lock: { origin: 'automatic', owner: OWNER, ttlMs: (d.auto_sync_timeout_sec || 600) * 1000 + 300_000 },
    });
    logger.info(`⏱ auto ${d.name}: enRango=${r.in_range} imp=${r.imported} sinEmp=${r.notFound}${r.partial ? ' PARCIAL' : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await publish({ kind: 'auto', device_id: d.id, device: d.name, status: r.partial ? 'partial' : 'ok', imported: r.imported, in_range: r.in_range, unmapped: r.notFound });
  } catch (e) {
    if (e.code === 'DEVICE_BUSY') { logger.info(`⏱ auto ${d.name}: reloj ocupado, se omite este ciclo`); }
    else { logger.warn(`⏱ auto ${d.name} FALLÓ: ${e.message}`); await publish({ kind: 'auto', device_id: d.id, device: d.name, status: 'error', error: String(e.message).slice(0, 200) }); }
  } finally {
    const next = computeNextRun(d.auto_sync_interval_min, d.auto_sync_offset_min);
    await sequelize.query('UPDATE devices SET last_auto_sync_at = NOW(), next_auto_sync_at = ? WHERE id = ?',
      { replacements: [next, d.id] }).catch(() => {});
  }
}

async function autoTick() {
  if (!killSwitchOn()) return;                                            // kill switch absoluto (auto)
  if ((await getSetting('zkteco_auto_sync_enabled', '0')) !== '1') return; // master de la base
  const win = await getSetting('zkteco_auto_sync_window', '04:00-23:59');
  if (!inWindow(win, pyHHMM())) return;                                    // ventana horaria

  const [devices] = await sequelize.query(`
    SELECT * FROM devices
    WHERE auto_sync_enabled = 1 AND COALESCE(auto_sync_paused, 0) = 0
      AND ip_address IS NOT NULL AND TRIM(ip_address) <> ''
    ORDER BY id`);
  const now = new Date();
  for (const d of devices) {
    if (running.has(d.id)) continue;
    const due = !d.next_auto_sync_at || new Date(d.next_auto_sync_at) <= now;
    if (!due) continue;
    running.add(d.id);
    runDevice(d).finally(() => running.delete(d.id));   // en paralelo: un reloj lento no bloquea
  }
}

// ─── Cola manual: procesar trabajos (ignora kill switch) ────────
async function processJob(job) {
  const t0 = Date.now();
  try {
    if (await syncJobs.isCancelRequested(job.id)) {
      await syncJobs.finish(job.id, { status: 'cancelled' });
      await publish({ kind: 'job', job_id: job.id, device_id: job.device_id, status: 'cancelled' });
      return;
    }
    const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id = ?', { replacements: [job.device_id] });
    if (!device) { await syncJobs.finish(job.id, { status: 'error', error: 'Reloj inexistente' }); return; }
    if (job.mode) device.connection_mode = job.mode;

    const from = job.date_from ? pyDate(new Date(job.date_from)) : defaultRange().from;
    const to   = job.date_to   ? pyDate(new Date(job.date_to))   : defaultRange().to;
    const attempts = job.attempts_requested || 3;

    await syncJobs.setProgress(job.id, 'Leyendo reloj…');
    await publish({ kind: 'job', job_id: job.id, device_id: job.device_id, status: 'running' });

    const r = await backupDeviceDirect(device, {
      from, to, recalc: !!job.recalc, attempts,
      cooldownMs: 4000, readTimeoutMs: 600_000,
      lock: { origin: job.origin || 'manual', owner: OWNER, jobId: String(job.id), ttlMs: 900_000 },
    });
    const status = r.partial ? 'partial' : 'success';
    await syncJobs.finish(job.id, {
      status,
      attemptsExecuted: r.read_attempts?.attempts ?? attempts,
      result: { imported: r.imported, in_range: r.in_range, skipped: r.skipped, notFound: r.notFound, partial: !!r.partial, total_read: r.total_read },
    });
    logger.info(`📥 job#${job.id} ${device.name}: ${status} imp=${r.imported} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await publish({ kind: 'job', job_id: job.id, device_id: job.device_id, status, imported: r.imported, in_range: r.in_range, unmapped: r.notFound });
  } catch (e) {
    if (e.code === 'DEVICE_BUSY') {
      await syncJobs.requeue(job.id, 'Reloj ocupado por otra sincronización, reintentando…');
      return;
    }
    await syncJobs.finish(job.id, { status: 'error', error: e.message });
    await publish({ kind: 'job', job_id: job.id, device_id: job.device_id, status: 'error', error: String(e.message).slice(0, 200) });
  }
}

async function drainJobs() {
  // Reclama hasta 5 trabajos por tick; cada reloj corre independiente y en paralelo.
  for (let i = 0; i < 5; i++) {
    let job;
    try { job = await syncJobs.claimNext(); } catch (e) { logger.warn('claimNext: ' + e.message); break; }
    if (!job) break;
    if (job.cancelled) continue;
    processJob(job).catch(e => logger.warn(`job#${job.id}: ${e.message}`));
  }
}

// ─── Tick principal ─────────────────────────────────────────────
async function tick() {
  // Heartbeat + estado SIEMPRE (aunque el kill switch bloquee el auto-polling).
  try {
    await setSetting('sync_worker_heartbeat', new Date().toISOString());
    await setSetting('sync_worker_killswitch', killSwitchOn() ? '1' : '0');
  } catch { /* best-effort */ }

  try { await drainJobs(); } catch (e) { logger.error('drainJobs: ' + e.message); }
  try { await autoTick(); } catch (e) { logger.error('autoTick: ' + e.message); }
}

(async () => {
  logger.info(`⏱ sishoras-sync-worker iniciado · kill switch ZKTECO_AUTO_POLL=${killSwitchOn() ? 'true (auto habilitado)' : 'false (auto BLOQUEADO)'} · cola manual SIEMPRE activa`);
  await initPub();
  await tick();
  setInterval(tick, TICK_MS);
})();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
