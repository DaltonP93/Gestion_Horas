/**
 * deviceLock.js — Lock distribuido por reloj (device_id).
 *
 * Garantiza que ninguna lectura de un mismo reloj se superponga, sin importar
 * el origen: worker automático, "sincronizar ahora", lectura por rango,
 * endpoint individual o scripts del servidor. Todos pasan por este lock.
 *
 * Backend preferente: Redis (SET NX PX + comparación por token en release/renew,
 * vía Lua, para liberar SÓLO el propietario). Fallback: tabla MySQL device_locks
 * si Redis no está disponible. En ambos casos el lock EXPIRA por TTL para
 * recuperarse si el proceso propietario muere.
 *
 * El handle devuelto por acquire() es opaco; se pasa tal cual a renew()/release().
 */
const crypto = require('crypto');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');
const audit = require('./audit');

const DEFAULT_TTL_MS = 15 * 60 * 1000;   // 15 min: cubre lecturas largas (Lavadero)
const RETRY_REDIS_MS = 15 * 1000;        // reintentar conexión a Redis cada 15s

const keyFor = (id) => `zk:lock:dev:${id}`;

let redis = null;
let redisOk = false;
let lastRedisTry = 0;

async function getRedis() {
  if (redisOk && redis) return redis;
  const now = Date.now();
  if (now - lastRedisTry < RETRY_REDIS_MS) return null;   // throttle de reintentos
  lastRedisTry = now;
  try {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    client.on('error', () => { redisOk = false; });
    await client.connect();
    redis = client; redisOk = true;
    return redis;
  } catch {
    redis = null; redisOk = false;
    return null;
  }
}

// ─── Fallback MySQL: asegurar tabla (idempotente, por si falta la migración) ──
let ensuredTable = false;
async function ensureTable() {
  if (ensuredTable) return;
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS device_locks (
        device_id INT PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        owner VARCHAR(64) NULL, job_id VARCHAR(64) NULL, origin VARCHAR(32) NULL,
        acquired_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
        INDEX idx_device_locks_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    ensuredTable = true;
  } catch { /* si no hay permisos DDL, el INSERT fallará y se reportará ocupado */ }
}

/**
 * Intenta tomar el lock del reloj.
 * @returns handle {deviceId, token, backend, ttlMs, owner, jobId, origin} o null si está ocupado.
 */
async function acquire(deviceId, { ttlMs = DEFAULT_TTL_MS, owner = null, jobId = null, origin = 'direct' } = {}) {
  const id = parseInt(deviceId, 10);
  const token = crypto.randomBytes(16).toString('hex');
  const ownerId = owner || `${process.env.HOSTNAME || 'host'}:${process.pid}`;
  const handle = { deviceId: id, token, ttlMs, owner: ownerId, jobId, origin, backend: null };

  const r = await getRedis();
  if (r) {
    try {
      const ok = await r.set(keyFor(id), token, { NX: true, PX: ttlMs });
      if (ok !== 'OK') return null;
      handle.backend = 'redis';
      logAcquire(handle);
      return handle;
    } catch {
      // Cae a MySQL si Redis falló en caliente.
    }
  }

  // Fallback MySQL.
  await ensureTable();
  try {
    // Limpiar lock vencido de ESTE reloj (recuperación si el dueño murió).
    await sequelize.query('DELETE FROM device_locks WHERE device_id = ? AND expires_at < NOW()', { replacements: [id] });
    await sequelize.query(
      `INSERT INTO device_locks (device_id, token, owner, job_id, origin, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      { replacements: [id, token, ownerId, jobId, origin, Math.ceil(ttlMs / 1000)] }
    );
    handle.backend = 'mysql';
    logAcquire(handle);
    return handle;
  } catch (err) {
    if (err?.original?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(err.message)) return null; // ocupado
    logger.warn(`deviceLock MySQL acquire error dev=${id}: ${err.message}`);
    return null; // ante la duda, no permitir doble lectura
  }
}

async function renew(handle) {
  if (!handle) return false;
  const { deviceId: id, token, ttlMs, backend } = handle;
  if (backend === 'redis') {
    const r = await getRedis();
    if (!r) return false;
    try {
      const lua = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";
      const res = await r.eval(lua, { keys: [keyFor(id)], arguments: [token, String(ttlMs)] });
      return res === 1;
    } catch { return false; }
  }
  try {
    const [r] = await sequelize.query(
      'UPDATE device_locks SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE device_id = ? AND token = ?',
      { replacements: [Math.ceil(ttlMs / 1000), id, token] }
    );
    return (r?.affectedRows ?? 0) > 0;
  } catch { return false; }
}

async function release(handle) {
  if (!handle) return;
  const { deviceId: id, token, backend } = handle;
  if (backend === 'redis') {
    const r = await getRedis();
    if (r) {
      try {
        const lua = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
        await r.eval(lua, { keys: [keyFor(id)], arguments: [token] });
      } catch { /* best-effort */ }
    }
    return;
  }
  try {
    await sequelize.query('DELETE FROM device_locks WHERE device_id = ? AND token = ?', { replacements: [id, token] });
  } catch { /* best-effort */ }
}

/** Estado del lock (para UI/diagnóstico). No es autoritativo para exclusión. */
async function status(deviceId) {
  const id = parseInt(deviceId, 10);
  const r = await getRedis();
  if (r) {
    try {
      const ttl = await r.pTTL(keyFor(id));   // -2 sin lock, -1 sin expiración, >0 ms
      return { locked: ttl > 0, ttl_ms: ttl > 0 ? ttl : null, backend: 'redis' };
    } catch { /* cae a MySQL */ }
  }
  try {
    const [[row]] = await sequelize.query(
      'SELECT owner, job_id, origin, expires_at FROM device_locks WHERE device_id = ? AND expires_at > NOW() LIMIT 1',
      { replacements: [id] }
    );
    return { locked: !!row, ...(row ? { owner: row.owner, job_id: row.job_id, origin: row.origin, expires_at: row.expires_at } : {}), backend: 'mysql' };
  } catch { return { locked: false, backend: 'none' }; }
}

function logAcquire(handle) {
  try {
    audit.log({ req: null, user: null, action: 'device_lock.acquire', entity: 'device', entity_id: handle.deviceId,
      details: { owner: handle.owner, job_id: handle.jobId, origin: handle.origin, backend: handle.backend } });
  } catch { /* opcional */ }
}

module.exports = { acquire, renew, release, status, DEFAULT_TTL_MS };
