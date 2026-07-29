/**
 * sync.js
 * Endpoints para leer y sincronizar datos desde att2000 (SQL Server)
 * hacia la nueva base de datos MySQL.
 *
 * Todos requieren rol admin.
 *
 * Flujo recomendado:
 *   1. GET  /api/sync/test        → verificar conexión a att2000
 *   2. POST /api/sync/full        → sincronización completa (primera vez)
 *   3. POST /api/sync/attendance  → solo re-importar marcajes de un período
 *   4. GET  /api/sync/checkinout  → ver datos crudos de CHECKINOUT
 *   5. GET  /api/sync/users       → ver USERINFO crudo
 */

const router = require('express').Router();
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { testAtt2000Connection, writeCheckinOut, queryAtt2000 } = require('../config/att2000');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { recordRun, recordCheck, getConnectionStatus } = require('../services/att2000Legacy');

// Auditoría de cada ejecución manual de la integración legada att2000.
// NUNCA registra el request body, el usuario SQL ni la contraseña: sólo la
// acción, el rango de fechas y contadores del resultado.
function auditLegacy(req, action, details = {}) {
  try { audit.log({ req, user: req.user, action: `att2000.${action}`, entity: 'att2000', details }); }
  catch { /* auditoría best-effort */ }
}
const {
  fetchCheckInOut, fetchUserInfo, fetchDepartments,
  fetchShifts, fetchMachines,
  syncDepartments, syncEmployees, syncAttendance,
  syncMachines, syncHolidays, fullSync,
} = require('../config/zkAdapter');

// Todo el módulo de sincronización con att2000 está restringido a super_admin.
// La gestión de BD fuente NO debe ser visible al rol GTH/admin.
router.use(authenticate, requireSuperAdmin);

// ─── GET /api/sync/test — Probar conexión con config del .env ────
router.get('/test', async (req, res) => {
  const result = await testAtt2000Connection();
  res.status(result.ok ? 200 : 503).json(result);
});

// ─── GET /api/sync/status — Estado de la integración legada (sin secretos) ──
// Devuelve SÓLO: disponible, host ENMASCARADO, base (nombre lógico), última
// comprobación, último resultado y estado del pull automático. Nunca credenciales.
router.get('/status', (req, res) => {
  res.json(getConnectionStatus());
});

// ─── POST /api/sync/test-conn — Probar conexión (SIEMPRE con el .env) ──
// La conexión usa EXCLUSIVAMENTE las variables protegidas del servidor
// (ATT_HOST/ATT_PORT/ATT_DATABASE/ATT_USER/ATT_PASSWORD). El navegador NUNCA
// envía credenciales ni destino: cualquier host/user/password/conn en el body
// se IGNORA por completo. No se registra el body en logs ni auditoría.
router.post('/test-conn', async (req, res) => {
  try {
    const [rCheckin, rUsers, rMachines, rRecent] = await Promise.all([
      queryAtt2000('SELECT COUNT(*) AS total FROM CHECKINOUT'),
      queryAtt2000('SELECT COUNT(*) AS total FROM USERINFO').catch(() => [{ total: 0 }]),
      queryAtt2000('SELECT MACHINE_ALIAS, IP_ADDRESS FROM MACHINES').catch(() => []),
      queryAtt2000(`
        SELECT TOP 8 c.USERID, ui.Name AS nombre, c.CHECKTIME, c.CHECKTYPE
        FROM CHECKINOUT c
        LEFT JOIN USERINFO ui ON ui.USERID = c.USERID
        ORDER BY c.CHECKTIME DESC
      `).catch(() => []),
    ]);

    recordCheck({ ok: true });
    res.json({
      ok: true,
      totalRecords:   rCheckin[0]?.total ?? 0,
      totalEmployees: rUsers[0]?.total ?? 0,
      machines:       rMachines,
      recentRecords:  rRecent,
    });
  } catch (err) {
    recordCheck({ ok: false, error: err.message });
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/sync/full — Sincronización completa ───────────────
// Body: { dateFrom, dateTo } — SÓLO parámetros funcionales no sensibles.
// La conexión usa siempre el .env del servidor; no se aceptan credenciales.
router.post('/full', async (req, res) => {
  const { dateFrom, dateTo } = req.body;

  try {
    const result = await fullSync({ dateFrom, dateTo });
    auditLegacy(req, 'full_sync', { dateFrom: dateFrom || null, dateTo: dateTo || null });
    recordRun({ source: 'manual', ok: true,
      imported: result?.attendance?.imported ?? result?.imported,
      duplicate: result?.attendance?.duplicate ?? result?.attendance?.skipped ?? result?.duplicate,
      unmapped: result?.attendance?.unmapped ?? result?.attendance?.notFound ?? result?.unmapped });
    res.json({ ok: true, result });
  } catch (err) {
    auditLegacy(req, 'full_sync', { dateFrom: dateFrom || null, dateTo: dateTo || null, ok: false, error: err.message });
    recordRun({ source: 'manual', ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/sync/departments ──────────────────────────────────
router.post('/departments', async (req, res) => {
  try {
    const r = await syncDepartments();
    auditLegacy(req, 'sync_departments', { count: r?.count ?? r?.imported });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/sync/employees ────────────────────────────────────
router.post('/employees', async (req, res) => {
  try {
    const r = await syncEmployees();
    auditLegacy(req, 'sync_employees', { count: r?.count ?? r?.imported });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/sync/attendance — Importar marcajes ───────────────
// Body: { dateFrom: "2026-04-01", dateTo: "2026-04-11", limit: 10000 }
// SÓLO parámetros funcionales no sensibles; la conexión usa siempre el .env.
router.post('/attendance', async (req, res) => {
  const { dateFrom, dateTo, limit = 10000 } = req.body;
  try {
    const result = await syncAttendance({ dateFrom, dateTo, limit });
    auditLegacy(req, 'sync_attendance', { dateFrom: dateFrom || null, dateTo: dateTo || null });
    recordRun({ source: 'manual', ok: true,
      imported: result?.imported, duplicate: result?.duplicate ?? result?.skipped, unmapped: result?.unmapped ?? result?.notFound });
    res.json({ ok: true, ...result });
  } catch (err) {
    auditLegacy(req, 'sync_attendance', { dateFrom: dateFrom || null, dateTo: dateTo || null, ok: false, error: err.message });
    recordRun({ source: 'manual', ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/sync/machines ──────────────────────────────────────
router.post('/machines', async (req, res) => {
  try {
    res.json({ ok: true, ...(await syncMachines()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/sync/checkinout — Ver CHECKINOUT crudo ─────────────
router.get('/checkinout', async (req, res) => {
  const { from, to, limit = 50 } = req.query;
  try {
    const rows = await fetchCheckInOut({ dateFrom: from, dateTo: to, limit: +limit });
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sync/users — Ver USERINFO crudo ────────────────────
router.get('/users', async (req, res) => {
  try {
    const rows = await fetchUserInfo();
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sync/shifts — Ver SHIFT (horarios) ─────────────────
router.get('/shifts', async (req, res) => {
  try {
    const rows = await fetchShifts();
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sync/machines-list ─────────────────────────────────
router.get('/machines-list', async (req, res) => {
  try {
    const rows = await fetchMachines();
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sync/push-to-att2000 ──────────────────────────────
// Envía marcaciones del MySQL local → att2000.CHECKINOUT
// Body: { dateFrom?, dateTo?, limit? }
// Útil para sincronizar marcaciones manuales ingresadas en SisHoras
// o para re-enviar registros que att2000 no capturó.
router.post('/push-to-att2000', async (req, res) => {
  const { dateFrom, dateTo, limit = 5000 } = req.body;

  let where = '1=1';
  const replacements = [];
  if (dateFrom) { where += ' AND al.timestamp >= ?'; replacements.push(dateFrom); }
  if (dateTo)   { where += ' AND al.timestamp <= ?'; replacements.push(dateTo + ' 23:59:59'); }

  try {
    // Leer del MySQL local — solo registros con código de empleado válido
    const [rows] = await sequelize.query(`
      SELECT
        al.id,
        al.timestamp,
        al.type,
        al.source,
        e.code AS employee_code,
        d.id   AS device_sensor_id
      FROM attendance_logs al
      JOIN employees e ON e.id = al.employee_id
      LEFT JOIN devices d ON d.id = al.device_id
      WHERE ${where}
      ORDER BY al.timestamp DESC
      LIMIT ?
    `, { replacements: [...replacements, limit] });

    if (!rows.length) {
      return res.json({ ok: true, message: 'No hay registros para enviar', total: 0, inserted: 0, skipped: 0 });
    }

    // Enviar a att2000
    const result = await writeCheckinOut(rows);

    auditLegacy(req, 'push_to_att2000', { dateFrom: dateFrom || null, dateTo: dateTo || null, total: rows.length, inserted: result.inserted, skipped: result.skipped, errors: result.errors });

    res.json({
      ok: true,
      total: rows.length,
      inserted: result.inserted,
      skipped:  result.skipped,
      errors:   result.errors,
      errList:  result.errList?.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/sync/push-to-att2000/preview ───────────────────────
// Vista previa: cuántos registros se enviarían a att2000
router.get('/push-to-att2000/preview', async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  let where = '1=1';
  const replacements = [];
  if (dateFrom) { where += ' AND al.timestamp >= ?'; replacements.push(dateFrom); }
  if (dateTo)   { where += ' AND al.timestamp <= ?'; replacements.push(dateTo + ' 23:59:59'); }

  try {
    const [[count]] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM attendance_logs al
       JOIN employees e ON e.id = al.employee_id
       WHERE ${where}`,
      { replacements }
    );
    res.json({ ok: true, total: count.total, dateFrom, dateTo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/sync/reconcile — ejecutar reconciliación manual (default: ayer)
router.post('/reconcile', async (req, res) => {
  try {
    const { runReconciliation } = require('../services/reconciliation');
    const { date } = req.body || {};
    const result = await runReconciliation(date);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sync/reconcile/history — últimos 30 reportes
router.get('/reconcile/history', async (req, res) => {
  try {
    const [rows] = await sequelize.query(`
      SELECT * FROM reconciliation_report
      ORDER BY report_date DESC LIMIT 30
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/sync/diagnostics — panorama del flujo de marcaciones ──
// Compara att2000 (origen) vs attendance_logs (destino), estado de relojes,
// USERIDs sin mapeo y auto-polling. Robusto: si att2000 no responde, igual
// devuelve el lado MySQL.
router.get('/diagnostics', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 15));
  const out = { days, att2000: { ok: false }, local: {}, per_day: [], devices: [], unmapped_userids: [], auto_poll: {} };

  // Fecha de corte (para las consultas por día).
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // ── Lado MySQL (asistencia.attendance_logs) ──
  try {
    const [[loc]] = await sequelize.query(
      `SELECT COUNT(*) AS total, DATE_FORMAT(MAX(timestamp), '%Y-%m-%d %H:%i') AS last_mark FROM attendance_logs`
    );
    out.local = { total: loc.total, last_mark: loc.last_mark };
    const [locDaily] = await sequelize.query(
      `SELECT DATE_FORMAT(timestamp,'%Y-%m-%d') AS d, COUNT(*) AS n,
              SUM(source='device') AS device, SUM(source='mobile') AS mobile,
              SUM(source='manual') AS manual, SUM(source='zkteco_direct') AS zkteco_direct,
              SUM(source='att2000') AS att2000
       FROM attendance_logs WHERE timestamp >= ? GROUP BY DATE_FORMAT(timestamp,'%Y-%m-%d')`,
      { replacements: [since] }
    );
    out._locDaily = Object.fromEntries(locDaily.map(r => [r.d, r]));
  } catch (e) { out.local.error = e.message; out._locDaily = {}; }

  // ── Relojes (devices) ──
  try {
    const [devs] = await sequelize.query(`
      SELECT d.id, d.name, d.ip_address, d.sensor_id, d.status, d.port,
             DATE_FORMAT(d.last_sync, '%Y-%m-%d %H:%i') AS last_sync,
             (SELECT DATE_FORMAT(MAX(al.timestamp),'%Y-%m-%d %H:%i') FROM attendance_logs al WHERE al.device_id = d.id) AS last_mark
      FROM devices d ORDER BY d.id`);
    out.devices = devs.map(d => ({
      ...d,
      valid: !!(d.ip_address && String(d.ip_address).trim()),
    }));
  } catch (e) { out.devices_error = e.message; }

  // ── Auto-polling ──
  out.auto_poll = {
    // ZKTECO_AUTO_POLL vive en el bridge; la API sólo lo refleja si está en su env.
    zkteco_auto_poll: process.env.ZKTECO_AUTO_POLL === '1' || process.env.ZKTECO_AUTO_POLL === 'true',
    att2000_pull_cron: process.env.ATT2000_PULL_ENABLED === '1' || process.env.ATT2000_PULL_ENABLED === 'true',
    note: 'ZKTECO_AUTO_POLL se configura en el bridge; att2000_pull es el cron de respaldo att2000→MySQL.',
  };

  // ── Lado att2000 (CHECKINOUT) ──
  let attDaily = {};
  try {
    const last = await queryAtt2000("SELECT CONVERT(varchar(16), MAX(CHECKTIME), 120) AS last_mark, COUNT(*) AS total FROM CHECKINOUT");
    out.att2000 = { ok: true, total: last[0].total, last_mark: last[0].last_mark };
    const daily = await queryAtt2000(
      `SELECT CONVERT(varchar(10), CHECKTIME, 120) AS d, COUNT(*) AS n
       FROM CHECKINOUT WHERE CHECKTIME >= @since
       GROUP BY CONVERT(varchar(10), CHECKTIME, 120)`,
      { since: `${since} 00:00:00` }
    );
    attDaily = Object.fromEntries(daily.map(r => [r.d, r.n]));

    // USERIDs de att2000 sin mapeo a employees.code (muestra hasta 50).
    const uids = await queryAtt2000('SELECT DISTINCT USERID FROM CHECKINOUT');
    const [emps] = await sequelize.query('SELECT code FROM employees');
    const codes = new Set(emps.map(e => String(e.code)));
    out.unmapped_userids = uids
      .map(u => String(u.USERID))
      .filter(id => !codes.has(id))
      .slice(0, 50);
    out.unmapped_count = uids.filter(u => !codes.has(String(u.USERID))).length;
  } catch (e) {
    out.att2000 = { ok: false, error: e.message };
  }

  // ── Comparativa por día: origen (att2000) vs destino (attendance_logs) ──
  const allDays = new Set([...Object.keys(attDaily), ...Object.keys(out._locDaily || {})]);
  out.per_day = [...allDays].sort().reverse().map(d => {
    const l = (out._locDaily || {})[d] || {};
    return {
      date: d,
      att2000: attDaily[d] ?? 0,
      local: l.n ?? 0,
      by_source: { att2000: +l.att2000 || 0, device: +l.device || 0, mobile: +l.mobile || 0, manual: +l.manual || 0, zkteco_direct: +l.zkteco_direct || 0 },
      diff: (attDaily[d] ?? 0) - (l.n ?? 0),
    };
  });
  delete out._locDaily;

  res.json(out);
});

module.exports = router;
