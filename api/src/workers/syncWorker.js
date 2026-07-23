/**
 * syncWorker.js — Worker PM2 de sincronización automática de relojes ZKTeco.
 *
 * Proceso SEPARADO de la API (sishoras-sync-worker): las lecturas corren aunque
 * nadie tenga el navegador abierto y no bloquean requests web.
 *
 * Semántica del kill switch (definida en el proyecto):
 *   ZKTECO_AUTO_POLL=false → bloqueo ABSOLUTO, aunque la base diga activado.
 *   ZKTECO_AUTO_POLL=true  → manda la configuración de la base:
 *     - setting zkteco_auto_sync_enabled ('1'/'0')  → master on/off
 *     - setting zkteco_auto_sync_window ('04:00-23:59') → ventana horaria (PY)
 *     - devices.auto_sync_enabled / auto_sync_paused / intervalo / offset …
 *
 * Reglas:
 *  - Lock independiente por reloj (Set en memoria; proceso único): un reloj
 *    nunca tiene dos lecturas simultáneas.
 *  - Los relojes corren EN PARALELO: si Lavadero tarda o falla, Comedor y
 *    Gerencia continúan.
 *  - Cada corrida queda auditada en device_sync_runs (lo hace el service).
 *  - Sólo se recalculan las fechas afectadas (lo hace el service).
 *  - Publica 'sync:completed' por Redis → la API lo re-emite por WebSocket.
 *  - Se recupera tras reiniciar PM2: la programación vive en la base
 *    (next_auto_sync_at) y el heartbeat en settings.
 *  - Horarios escalonados por offset: próximo minuto m con m % intervalo ==
 *    offset % intervalo (p.ej. intervalo 15 offset 5 → :05 :20 :35 :50).
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const { backupDeviceDirect } = require('../services/zktecoReader');

const TICK_MS = 30_000;
const running = new Set();          // lock por reloj (proceso único)
let redisPub = null;

const killSwitchOn = () => String(process.env.ZKTECO_AUTO_POLL).toLowerCase() === 'true';

// ─── settings (notification_settings key→value) ─────────────────
async function getSetting(key, def) {
  try {
    const [[r]] = await sequelize.query(
      'SELECT setting_value AS v FROM notification_settings WHERE setting_key = ?',
      { replacements: [key] }
    );
    return r ? r.v : def;
  } catch { return def; }
}
async function setSetting(key, val) {
  try {
    await sequelize.query(
      `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      { replacements: [key, val] }
    );
  } catch { /* heartbeat best-effort */ }
}

// ─── hora Paraguay ──────────────────────────────────────────────
const pyHHMM = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date());
const pyDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(d);

function inWindow(win, hhmm) {
  const m = String(win || '').match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
  if (!m) return true;                       // ventana inválida = no restringe
  return hhmm >= m[1] && hhmm <= m[2];
}

// Próxima ejecución alineada al offset (hora local del proceso = TZ del server).
function computeNextRun(intervalMin, offsetMin, from = new Date()) {
  const interval = Math.max(5, intervalMin || 15);
  const base = (offsetMin || 0) % interval;
  const d = new Date(from.getTime() + 60_000);      // como mínimo 1 min después
  const mins = d.getHours() * 60 + d.getMinutes();
  let m = Math.ceil((mins - base) / interval) * interval + base;
  if (m <= mins) m += interval;
  const next = new Date(d);
  next.setHours(0, m, 0, 0);                        // JS normaliza minutos > 59
  return next;
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

// ─── Ejecución por reloj ────────────────────────────────────────
async function runDevice(d) {
  const to = pyDate();
  const from = pyDate(new Date(Date.now() - 86_400_000));   // ayer, cubre medianoche
  const t0 = Date.now();
  try {
    const r = await backupDeviceDirect(d, {
      from, to, recalc: true,
      attempts: d.auto_sync_attempts || 3,
      cooldownMs: (d.auto_sync_cooldown_sec || 4) * 1000,
      readTimeoutMs: (d.auto_sync_timeout_sec || 600) * 1000,
    });
    logger.info(`⏱ sync-worker ${d.name}: enRango=${r.in_range} importados=${r.imported} sinEmp=${r.notFound}${r.partial ? ' PARCIAL' : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await publish({ device_id: d.id, device: d.name, status: r.partial ? 'partial' : 'ok', imported: r.imported, in_range: r.in_range, unmapped: r.notFound });
  } catch (e) {
    // device_sync_runs ya auditó el error (lo hace el service).
    logger.warn(`⏱ sync-worker ${d.name} FALLÓ: ${e.message}`);
    await publish({ device_id: d.id, device: d.name, status: 'error', error: String(e.message).slice(0, 200) });
  } finally {
    const next = computeNextRun(d.auto_sync_interval_min, d.auto_sync_offset_min);
    await sequelize.query(
      'UPDATE devices SET last_auto_sync_at = NOW(), next_auto_sync_at = ? WHERE id = ?',
      { replacements: [next, d.id] }
    ).catch(() => {});
  }
}

// ─── Tick principal ─────────────────────────────────────────────
async function tick() {
  try {
    await setSetting('sync_worker_heartbeat', new Date().toISOString());
    if (!killSwitchOn()) return;                                          // kill switch absoluto
    if ((await getSetting('zkteco_auto_sync_enabled', '0')) !== '1') return;   // master de la base
    const win = await getSetting('zkteco_auto_sync_window', '04:00-23:59');
    if (!inWindow(win, pyHHMM())) return;                                 // ventana horaria

    const [devices] = await sequelize.query(`
      SELECT * FROM devices
      WHERE auto_sync_enabled = 1 AND COALESCE(auto_sync_paused, 0) = 0
        AND ip_address IS NOT NULL AND TRIM(ip_address) <> ''
      ORDER BY id`);
    const now = new Date();
    for (const d of devices) {
      if (running.has(d.id)) continue;                                    // lock por reloj
      const due = !d.next_auto_sync_at || new Date(d.next_auto_sync_at) <= now;
      if (!due) continue;
      running.add(d.id);
      // En paralelo: un reloj lento no bloquea a los demás.
      runDevice(d).finally(() => running.delete(d.id));
    }
  } catch (e) {
    logger.error('sync-worker tick: ' + e.message);
  }
}

(async () => {
  logger.info(`⏱ sishoras-sync-worker iniciado · kill switch ZKTECO_AUTO_POLL=${killSwitchOn() ? 'true (habilitado)' : 'false (BLOQUEO ABSOLUTO)'}`);
  await initPub();
  await tick();
  setInterval(tick, TICK_MS);
})();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
