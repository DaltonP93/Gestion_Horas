/**
 * syncJobs.js — Cola persistente de trabajos de lectura manual de relojes.
 *
 * La API encola (enqueue) y responde 202 sin mantener la petición HTTP abierta.
 * El worker (sishoras-sync-worker) drena la cola, procesando cada reloj de forma
 * INDEPENDIENTE (un fallo no detiene a los demás) y usando el lock por reloj.
 *
 * Estados: queued → running → success | partial | error | cancelled.
 */
const crypto = require('crypto');
const { sequelize } = require('../config/database');

const ACTIVE = ['queued', 'running'];

function parseResult(row) {
  if (!row) return row;
  if (row.result && typeof row.result === 'string') {
    try { row.result = JSON.parse(row.result); } catch { /* dejar string */ }
  }
  return row;
}

// Crea un trabajo por cada reloj. Devuelve { batch_id, jobs:[{id, device_id}] }.
async function enqueue({ deviceIds, from = null, to = null, mode = null, recalc = true, attempts = null, origin = 'manual', userId = null }) {
  const ids = (Array.isArray(deviceIds) ? deviceIds : [deviceIds]).map(n => parseInt(n, 10)).filter(Boolean);
  if (!ids.length) throw new Error('deviceIds requerido');
  const batchId = crypto.randomBytes(8).toString('hex');
  const jobs = [];
  for (const id of ids) {
    const [r] = await sequelize.query(
      `INSERT INTO sync_jobs (batch_id, device_id, origin, requested_by, mode, date_from, date_to, recalc, attempts_requested, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      { replacements: [batchId, id, origin, userId, mode, from, to, recalc ? 1 : 0, attempts] }
    );
    jobs.push({ id: r.insertId ?? r, device_id: id });
  }
  return { batch_id: batchId, jobs };
}

async function get(id) {
  const [[row]] = await sequelize.query(
    `SELECT j.*, d.name AS device_name FROM sync_jobs j LEFT JOIN devices d ON d.id = j.device_id WHERE j.id = ?`,
    { replacements: [parseInt(id, 10)] }
  );
  return parseResult(row) || null;
}

async function list({ limit = 30, status = null, batchId = null } = {}) {
  let where = 'WHERE 1=1';
  const repl = [];
  if (status) { where += ' AND j.status = ?'; repl.push(status); }
  if (batchId) { where += ' AND j.batch_id = ?'; repl.push(batchId); }
  const [rows] = await sequelize.query(
    `SELECT j.id, j.batch_id, j.device_id, d.name AS device_name, j.origin, j.mode,
            j.date_from, j.date_to, j.status, j.cancel_requested, j.progress, j.error,
            j.attempts_requested, j.attempts_executed,
            j.created_at, j.started_at, j.finished_at, j.duration_ms
       FROM sync_jobs j LEFT JOIN devices d ON d.id = j.device_id
       ${where} ORDER BY j.id DESC LIMIT ?`,
    { replacements: [...repl, Math.min(parseInt(limit, 10) || 30, 200)] }
  );
  return rows;
}

// Marca la solicitud de cancelación. El worker corta entre operaciones seguras.
async function requestCancel(id) {
  const [r] = await sequelize.query(
    `UPDATE sync_jobs SET cancel_requested = 1
       WHERE id = ? AND status IN ('queued','running')`,
    { replacements: [parseInt(id, 10)] }
  );
  return (r?.affectedRows ?? 0) > 0;
}

// ─── Lado worker ────────────────────────────────────────────────
// Reclama el siguiente trabajo en cola (marcándolo running de forma atómica).
// Evita reclamar un reloj que ya tiene otro trabajo corriendo.
async function claimNext() {
  const [[cand]] = await sequelize.query(
    `SELECT id, device_id, cancel_requested FROM sync_jobs
      WHERE status = 'queued'
        AND device_id NOT IN (SELECT device_id FROM sync_jobs WHERE status = 'running')
      ORDER BY id ASC LIMIT 1`
  );
  if (!cand) return null;

  if (cand.cancel_requested) {
    await sequelize.query(
      `UPDATE sync_jobs SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status = 'queued'`,
      { replacements: [cand.id] }
    );
    return { cancelled: cand.id };
  }

  const [r] = await sequelize.query(
    `UPDATE sync_jobs SET status = 'running', started_at = NOW(), progress = 'Iniciando lectura…'
      WHERE id = ? AND status = 'queued'`,
    { replacements: [cand.id] }
  );
  if ((r?.affectedRows ?? 0) !== 1) return null;   // otro proceso lo tomó
  return get(cand.id);
}

async function setProgress(id, progress) {
  await sequelize.query('UPDATE sync_jobs SET progress = ? WHERE id = ?',
    { replacements: [String(progress).slice(0, 255), parseInt(id, 10)] }).catch(() => {});
}

// Reencola un trabajo (p.ej. reloj ocupado): vuelve a queued para reintentar.
async function requeue(id, note) {
  await sequelize.query(
    `UPDATE sync_jobs SET status = 'queued', started_at = NULL, progress = ? WHERE id = ?`,
    { replacements: [String(note || '').slice(0, 255) || null, parseInt(id, 10)] }
  ).catch(() => {});
}

async function finish(id, { status, result = null, error = null, attemptsExecuted = null }) {
  await sequelize.query(
    `UPDATE sync_jobs
        SET status = ?, result = ?, error = ?, attempts_executed = ?,
            finished_at = NOW(),
            duration_ms = TIMESTAMPDIFF(MICROSECOND, COALESCE(started_at, created_at), NOW()) / 1000
      WHERE id = ?`,
    { replacements: [
        status,
        result ? JSON.stringify(result).slice(0, 60000) : null,
        error ? String(error).slice(0, 500) : null,
        attemptsExecuted,
        parseInt(id, 10),
      ] }
  );
}

// ¿Se pidió cancelar este trabajo mientras corría?
async function isCancelRequested(id) {
  const [[row]] = await sequelize.query('SELECT cancel_requested FROM sync_jobs WHERE id = ?', { replacements: [parseInt(id, 10)] });
  return !!row?.cancel_requested;
}

module.exports = { enqueue, get, list, requestCancel, claimNext, setProgress, requeue, finish, isCancelRequested, ACTIVE };
