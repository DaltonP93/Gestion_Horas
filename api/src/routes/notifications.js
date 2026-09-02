/**
 * notifications.js
 * Configuración SMTP, settings de alertas y reportes automáticos programados.
 */

const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { sendMail, resetTransporter, buildAlertHtml } = require('../services/emailService');
const { loadSchedules, registerJob, stopJob, generateMarcadasReport } = require('../services/scheduler');
const logger = require('../config/logger');

router.use(authenticate, authorize('admin', 'hr'));

// ─── SMTP CONFIG ───────────────────────────────────────────────────

// GET /api/notifications/smtp — solo administrador (RRHH no ve la config SMTP).
router.get('/smtp', authorize('admin'), async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      "SELECT setting_value FROM notification_settings WHERE setting_key = 'smtp_config' LIMIT 1"
    );
    if (!rows.length) return res.json({ configured: false });
    const cfg = JSON.parse(rows[0].setting_value);
    // Ocultar contraseña
    res.json({ configured: true, host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.auth?.user, from: cfg.from });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/smtp
router.put('/smtp', authorize('admin'), async (req, res) => {
  const { host, port = 587, secure = false, user, password, from } = req.body;
  if (!host || !user || !password) {
    return res.status(400).json({ error: 'host, user y password son requeridos' });
  }
  const config = { host, port: +port, secure: !!secure, auth: { user, pass: password }, from: from || user };

  await sequelize.query(
    `INSERT INTO notification_settings (setting_key, setting_value)
     VALUES ('smtp_config', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    { replacements: [JSON.stringify(config)] }
  );
  resetTransporter();
  res.json({ message: 'Configuración SMTP guardada' });
});

// POST /api/notifications/smtp/test — enviar correo de prueba (solo administrador)
router.post('/smtp/test', authorize('admin'), async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Destinatario requerido' });

  const result = await sendMail({
    to,
    subject: 'Prueba de configuración SMTP — Sistema de Asistencia',
    html: '<h2>✅ SMTP configurado correctamente</h2><p>Este es un correo de prueba del Sistema de Asistencia.</p>',
  });
  res.json(result);
});

// ─── SETTINGS de alertas ──────────────────────────────────────────

// GET /api/notifications/settings
router.get('/settings', async (req, res) => {
  const [rows] = await sequelize.query(
    "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key != 'smtp_config'"
  );
  const settings = {};
  for (const r of rows) {
    try { settings[r.setting_key] = JSON.parse(r.setting_value); }
    catch { settings[r.setting_key] = r.setting_value; }
  }
  res.json(settings);
});

// PUT /api/notifications/settings
router.put('/settings', async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    if (key === 'smtp_config') continue; // no sobreescribir SMTP por esta ruta
    await sequelize.query(
      `INSERT INTO notification_settings (setting_key, setting_value)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      { replacements: [key, typeof value === 'string' ? value : JSON.stringify(value)] }
    );
  }
  res.json({ message: 'Settings guardados' });
});

// ─── REPORTES PROGRAMADOS ─────────────────────────────────────────

// GET /api/notifications/schedules
router.get('/schedules', async (req, res) => {
  const [rows] = await sequelize.query(
    'SELECT * FROM report_schedules ORDER BY created_at DESC'
  );
  res.json(rows);
});

// POST /api/notifications/schedules
router.post('/schedules', async (req, res) => {
  const {
    name, cron_expression, period_type, recipients,
    report_type = 'marcadas', config = '{}',
    timezone = 'America/Asuncion',
  } = req.body;

  if (!name || !cron_expression || !recipients) {
    return res.status(400).json({ error: 'name, cron_expression y recipients son requeridos' });
  }

  const cron = require('node-cron');
  if (!cron.validate(cron_expression)) {
    return res.status(400).json({ error: 'Expresión cron inválida' });
  }

  try {
    const [result] = await sequelize.query(
      `INSERT INTO report_schedules
         (name, cron_expression, period_type, recipients, report_type, config, timezone, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      { replacements: [name, cron_expression, period_type || 'monthly', recipients, report_type,
          typeof config === 'string' ? config : JSON.stringify(config), timezone] }
    );

    // Activar inmediatamente
    const [rows] = await sequelize.query(
      'SELECT * FROM report_schedules WHERE id = ?',
      { replacements: [insertId(result)] }
    );
    registerJob(rows[0]);

    res.status(201).json({ id: insertId(result), message: 'Reporte programado creado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/schedules/:id
router.put('/schedules/:id', async (req, res) => {
  const { name, cron_expression, recipients, active, period_type, config } = req.body;
  await sequelize.query(
    `UPDATE report_schedules SET
       name            = COALESCE(?, name),
       cron_expression = COALESCE(?, cron_expression),
       recipients      = COALESCE(?, recipients),
       period_type     = COALESCE(?, period_type),
       config          = COALESCE(?, config),
       active          = COALESCE(?, active)
     WHERE id = ?`,
    { replacements: [name, cron_expression, recipients, period_type,
        config ? JSON.stringify(config) : null, active, req.params.id] }
  );

  // Recargar job
  const [rows] = await sequelize.query(
    'SELECT * FROM report_schedules WHERE id = ?',
    { replacements: [req.params.id] }
  );
  if (rows[0]) {
    stopJob(+req.params.id);
    if (rows[0].active) registerJob(rows[0]);
  }

  res.json({ message: 'Reporte programado actualizado' });
});

// DELETE /api/notifications/schedules/:id
router.delete('/schedules/:id', authorize('admin'), async (req, res) => {
  stopJob(+req.params.id);
  await sequelize.query('DELETE FROM report_schedules WHERE id = ?', { replacements: [req.params.id] });
  res.json({ message: 'Eliminado' });
});

// POST /api/notifications/schedules/:id/run — ejecutar manualmente
router.post('/schedules/:id/run', async (req, res) => {
  const [rows] = await sequelize.query(
    'SELECT * FROM report_schedules WHERE id = ?',
    { replacements: [req.params.id] }
  );
  if (!rows.length) return res.status(404).json({ error: 'No encontrado' });

  // Ejecutar async
  const { runScheduledReport } = require('../services/scheduler');
  // Nota: runScheduledReport es función interna — llamamos directamente aquí
  try {
    const { generateMarcadasReport, buildMarcadasTableHtml } = require('../services/scheduler');
    const schedule = rows[0];
    const cfg = JSON.parse(schedule.config || '{}');
    const { pyDateStr } = require('../services/scheduler');
    const from = req.body.dateFrom || pyDateStr(new Date());
    const to   = req.body.dateTo   || from;

    const report = await generateMarcadasReport({ dateFrom: from, dateTo: to, ...cfg });
    res.json({ ok: true, employees: report.data.length, period: report.period });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
