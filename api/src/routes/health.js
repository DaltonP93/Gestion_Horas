/**
 * health.js — Endpoints de observabilidad.
 *   GET /api/health           — liveness simple (público)
 *   GET /api/health/detailed  — estado de dependencias (admin)
 *     · MySQL (asistencia)
 *     · Redis
 *     · att2000 (SQL Server origen)
 *     · Bridge ZKTeco (puerto 8081)
 *     · Memoria del proceso, uptime, versiones
 */
const router = require('express').Router();
const os = require('os');
const { sequelize } = require('../config/database');
const { getRedis } = require('../config/redis');
const { authenticate, authorize } = require('../middleware/auth');

const pkg = require('../../package.json');
const START = Date.now();

async function checkMysql() {
  const t0 = Date.now();
  try {
    await sequelize.query('SELECT 1 AS ok');
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: err.message };
  }
}

async function checkRedis() {
  const t0 = Date.now();
  try {
    const r = typeof getRedis === 'function' ? getRedis() : null;
    if (!r) return { ok: false, error: 'Redis no inicializado' };
    await r.ping();
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: err.message };
  }
}

async function checkAtt2000() {
  const t0 = Date.now();
  try {
    const { queryAtt2000 } = require('../config/att2000');
    await queryAtt2000('SELECT TOP 1 1 AS ok FROM CHECKINOUT');
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: err.message };
  }
}

async function checkBridge() {
  const t0 = Date.now();
  const url = process.env.BRIDGE_URL || 'http://localhost:8081';
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(to);
    return { ok: res.ok, latency_ms: Date.now() - t0, status: res.status };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: err.message };
  }
}

// Liveness público
router.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detailed: solo admin/gth/super_admin
router.get('/detailed', authenticate, authorize('admin', 'gth'), async (req, res) => {
  const [mysql, redis, att2000, bridge] = await Promise.all([
    checkMysql(), checkRedis(), checkAtt2000(), checkBridge(),
  ]);
  const mem = process.memoryUsage();
  const allOk = mysql.ok && redis.ok;
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime_sec: Math.round((Date.now() - START) / 1000),
    version: pkg.version || '0.0.0',
    node: process.version,
    host: os.hostname(),
    checks: { mysql, redis, att2000, bridge },
    // Integración LEGADA att2000: disponible, pull automático on/off, última corrida.
    att2000_legacy: require('../services/att2000Legacy').getStatus(),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    loadavg: os.loadavg(),
  });
});

module.exports = router;
