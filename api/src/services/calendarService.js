'use strict';

/**
 * calendarService.js — FASE F3.
 *
 * Acceso a datos de calendarios laborales + resolutor efectivo (read-only) +
 * integración READ-ONLY con los snapshots de jornada existentes
 * (workdayConfig). Aísla el SQL para testear con `sequelize.query` mockeado.
 *
 * Kill switch fail-closed: `CALENDAR_WRITE_ENABLED` (sólo "true" habilita).
 *
 * DEGRADACIÓN: si las tablas del calendario o de feriados no existen todavía
 * (migración ausente/parcial), se devuelve vacío en vez de romper — el
 * resolutor cae al modelo de semana (descanso dominical). Igual criterio que el
 * motor de jornada: se degrada ante "tabla no existe" (42S02), no ante una
 * caída real de la base.
 *
 * COEXISTENCIA: NO escribe en attendance_logs, daily_summary ni att2000, y NO
 * recalcula histórico. La lectura de jornada delega en workdayConfig, que ya
 * degrada solo si faltan 072/073/075.
 */

const { sequelize } = require('../config/database');
const { isMissingTableError } = require('../utils/schemaState');
const laborCalendar = require('./laborCalendar');
const workdayConfig = require('./workdayConfig');

function isWriteEnabled() {
  return process.env.CALENDAR_WRITE_ENABLED === 'true';
}
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
function assertWriteEnabled() {
  if (isWriteEnabled()) return;
  throw httpError(503, 'CALENDAR_WRITES_DISABLED', 'La configuración de calendario está en modo sólo lectura durante el rollout');
}
function isDupError(err) {
  return String(err?.original?.code || err?.parent?.code || '').startsWith('ER_DUP');
}

async function optionalQuery(sql, replacements = []) {
  try {
    const [rows] = await sequelize.query(sql, { replacements });
    return rows;
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

// ─── Calendarios ────────────────────────────────────────────────────────────

async function listCalendars() {
  return optionalQuery(
    `SELECT id, code, name, company_id, branch_id, timezone, week_start, active,
            valid_from, valid_to, created_at, updated_at
       FROM labor_calendars ORDER BY active DESC, code`,
  );
}

async function getCalendar(id) {
  const rows = await optionalQuery(
    `SELECT id, code, name, company_id, branch_id, timezone, week_start, active,
            valid_from, valid_to
       FROM labor_calendars WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function createCalendar(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO labor_calendars
       (code, name, company_id, branch_id, timezone, week_start, active, valid_from, valid_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [
      data.code, data.name, data.company_id ?? null, data.branch_id ?? null,
      data.timezone || 'America/Asuncion', data.week_start ?? 0,
      data.active ? 1 : 0, data.valid_from, data.valid_to ?? null, userId ?? null,
    ] },
  );
  return result.insertId;
}

// ─── Excepciones ────────────────────────────────────────────────────────────

async function listExceptions(calendarId) {
  return optionalQuery(
    `SELECT id, calendar_id, day, kind, label, created_at
       FROM calendar_exceptions WHERE calendar_id = ? ORDER BY day`,
    [calendarId],
  );
}

async function upsertException(calendarId, data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO calendar_exceptions (calendar_id, day, kind, label, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE kind = VALUES(kind), label = VALUES(label)`,
    { replacements: [calendarId, data.day, data.kind, data.label ?? null, userId ?? null] },
  );
  return result;
}

// ─── Resolutor efectivo (read-only) ─────────────────────────────────────────

async function holidaysInRange(from, to) {
  const rows = await optionalQuery(
    `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM holidays
      WHERE active = 1 AND date BETWEEN ? AND ?`,
    [from, to],
  );
  return new Set(rows.map((r) => r.d));
}

async function exceptionsInRange(calendarId, from, to) {
  const rows = await optionalQuery(
    `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, kind FROM calendar_exceptions
      WHERE calendar_id = ? AND day BETWEEN ? AND ?`,
    [calendarId, from, to],
  );
  const m = new Map();
  for (const r of rows) m.set(r.d, r.kind);
  return m;
}

/**
 * Calendario efectivo del rango. `workDays` opcional (1..7, 1=domingo); si no
 * se pasa, el modelo de semana usa descanso dominical.
 */
async function resolveEffective(calendarId, from, to, { workDays = null } = {}) {
  const [holidaySet, exceptionMap] = await Promise.all([
    holidaysInRange(from, to),
    exceptionsInRange(calendarId, from, to),
  ]);
  const days = laborCalendar.composeRange(from, to, { workDays, holidaySet, exceptionMap });
  return {
    from, to,
    working_days: laborCalendar.countWorking(days),
    total_days: days.length,
    days,
  };
}

// ─── Integración READ-ONLY con snapshots de jornada ─────────────────────────

/**
 * Devuelve la configuración de jornada vigente para un empleado en una fecha,
 * SÓLO LECTURA, delegando en workdayConfig (que degrada a historical_fallback
 * si faltan 072/073/075). No escribe nada.
 */
async function readWorkdayForDate(employeeId, date) {
  const cfg = await workdayConfig.loadWorkdayConfig([employeeId], { from: date, to: date });
  const forDate = cfg.forDate(employeeId, date);
  return forDate || { source: 'historical_fallback', config: null };
}

module.exports = {
  isWriteEnabled,
  assertWriteEnabled,
  isDupError,
  listCalendars,
  getCalendar,
  createCalendar,
  listExceptions,
  upsertException,
  holidaysInRange,
  exceptionsInRange,
  resolveEffective,
  readWorkdayForDate,
};
