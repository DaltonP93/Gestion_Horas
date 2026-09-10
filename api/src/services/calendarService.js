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

/** Normaliza work_days a string '1..7' ordenado, o null. Acepta array o string. */
function normalizeWorkDays(value) {
  if (value == null || value === '') return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const days = raw.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (!days.length) return null;
  return [...new Set(days)].sort((a, b) => a - b).join(',');
}

/** Parsea work_days string → number[] (1..7) o null. */
function parseWorkDays(value) {
  const s = normalizeWorkDays(value);
  return s ? s.split(',').map(Number) : null;
}

const CALENDAR_COLS = `id, code, name, company_id, branch_id, timezone, week_start,
            work_days, active, valid_from, valid_to`;

/**
 * Lista calendarios aplicando ALCANCE: un rol con alcance ve los GLOBALES (que
 * aplican a todos) y los de su empresa/sucursal; nunca los de otra empresa.
 */
async function listCalendars(scope) {
  const orgScope = require('./orgScope');
  const frag = orgScope.calendarScopeFilter(scope);
  const where = frag.clause ? `WHERE ${frag.clause.replace(/^AND\s+/, '')}` : '';
  return optionalQuery(
    `SELECT ${CALENDAR_COLS}, created_at, updated_at
       FROM labor_calendars ${where} ORDER BY code, valid_from DESC`,
    frag.params,
  );
}

async function getCalendar(id) {
  const rows = await optionalQuery(
    `SELECT ${CALENDAR_COLS} FROM labor_calendars WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Valida existencia, ALCANCE y coherencia sucursal → empresa de las referencias
 * de un calendario. Fuera de alcance → 403; sucursal ajena a la empresa → 400.
 */
async function validateCalendarRefs(scope, data) {
  const orgScope = require('./orgScope');
  const companyId = data.company_id ?? null;
  const branchId = data.branch_id ?? null;
  // Un calendario GLOBAL (sin empresa ni sucursal) aplica a TODA la organización
  // (pickCalendarForDate lo matchea para cualquier alcance). Un writer con
  // alcance restringido no puede crearlo: sería escribir fuera de su alcance.
  // Simétrico a la guarda de POST /:id/exceptions sobre calendarios globales.
  if (scope && !scope.unrestricted && companyId == null && branchId == null) {
    throw httpError(403, 'OUT_OF_SCOPE', 'No podés crear un calendario global');
  }
  if (branchId != null) {
    const [b] = await sequelize.query('SELECT id, company_id FROM branches WHERE id = ? LIMIT 1', { replacements: [branchId] });
    if (!b.length) throw httpError(400, 'BRANCH_NOT_FOUND', 'La sucursal referenciada no existe');
    orgScope.assertBranchInScope(scope, branchId);
    if (companyId != null && b[0].company_id != null && Number(b[0].company_id) !== Number(companyId)) {
      throw httpError(400, 'INCOHERENT_SCOPE', 'La sucursal no pertenece a la empresa indicada');
    }
  }
  if (companyId != null) {
    const [c] = await sequelize.query('SELECT id FROM companies WHERE id = ? LIMIT 1', { replacements: [companyId] });
    if (!c.length) throw httpError(400, 'COMPANY_NOT_FOUND', 'La empresa referenciada no existe');
    orgScope.assertCompanyInScope(scope, companyId);
  }
}

async function createCalendar(data, userId) {
  const { parseCivilDate } = require('../utils/civilDate');
  // Fechas civiles REALES (no sólo formato): rechaza p.ej. 2026-02-30.
  if (!parseCivilDate(data.valid_from)) {
    throw httpError(400, 'INVALID_DATE', 'valid_from no es una fecha civil válida');
  }
  if (data.valid_to != null && data.valid_to !== '' && !parseCivilDate(data.valid_to)) {
    throw httpError(400, 'INVALID_DATE', 'valid_to no es una fecha civil válida');
  }
  // Versionado válido: la vigencia debe ser coherente.
  if (data.valid_to != null && data.valid_to !== '' && String(data.valid_to) < String(data.valid_from)) {
    throw httpError(400, 'INVALID_VALIDITY', 'valid_to no puede ser anterior a valid_from');
  }
  const [result] = await sequelize.query(
    `INSERT INTO labor_calendars
       (code, name, company_id, branch_id, timezone, week_start, work_days, active, valid_from, valid_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [
      data.code, data.name, data.company_id ?? null, data.branch_id ?? null,
      data.timezone || 'America/Asuncion', data.week_start ?? 0,
      normalizeWorkDays(data.work_days), data.active ? 1 : 0,
      data.valid_from, data.valid_to ?? null, userId ?? null,
    ] },
  );
  // sequelize.query(INSERT) devuelve [insertId, affectedRows] contra MySQL real,
  // pero {insertId} con mocks: soportamos ambos (patrón de F2/syncJobs.js).
  return result?.insertId ?? result;
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
 * Calendario efectivo del rango POR ID. Usa los `work_days` PERSISTIDOS del
 * calendario salvo que se pase un override explícito.
 */
async function resolveEffective(calendarId, from, to, { workDays, scope } = {}) {
  const cal = await getCalendar(calendarId);
  if (!cal) return null; // calendario inexistente → el caller responde 404
  // ALCANCE: un calendario fuera del alcance del actor se trata como inexistente
  // (404), sin filtrar existencia. Los globales sí son visibles.
  if (scope) {
    const orgScope = require('./orgScope');
    if (!orgScope.canSeeCalendar(scope, cal)) return null;
  }
  const effectiveWorkDays = workDays !== undefined ? workDays : parseWorkDays(cal.work_days);
  const [holidaySet, exceptionMap] = await Promise.all([
    holidaysInRange(from, to),
    exceptionsInRange(calendarId, from, to),
  ]);
  const days = laborCalendar.composeRange(from, to, { workDays: effectiveWorkDays, holidaySet, exceptionMap });
  return {
    from, to,
    timezone: cal.timezone || laborCalendar.COMPANY_TZ,
    work_days: effectiveWorkDays,
    working_days: laborCalendar.countWorking(days),
    total_days: days.length,
    days,
  };
}

/**
 * Elige la versión de calendario aplicable para un ALCANCE y una FECHA, con
 * precedencia DETERMINISTA:
 *   1. especificidad de alcance: sucursal > empresa > global;
 *   2. entre las que cubren la fecha con igual especificidad, la de `valid_from`
 *      más reciente (la versión más nueva).
 * Un calendario cubre la fecha si `valid_from <= date` y (`valid_to` es NULL o
 * `>= date`). Sólo activos.
 */
async function pickCalendarForDate({ company_id = null, branch_id = null } = {}, date) {
  const rows = await optionalQuery(
    `SELECT ${CALENDAR_COLS} FROM labor_calendars
      WHERE active = 1
        AND valid_from <= ?
        AND (valid_to IS NULL OR valid_to >= ?)
        AND (
              (branch_id = ? AND ? IS NOT NULL)
           OR (branch_id IS NULL AND company_id = ? AND ? IS NOT NULL)
           OR (branch_id IS NULL AND company_id IS NULL)
        )
      ORDER BY
        (branch_id IS NOT NULL) DESC,   -- sucursal primero
        (company_id IS NOT NULL) DESC,  -- luego empresa
        valid_from DESC                 -- versión más reciente
      LIMIT 1`,
    [date, date, branch_id, branch_id, company_id, company_id],
  );
  return rows[0] || null;
}

/**
 * Resuelve el calendario efectivo por ALCANCE + rango de fechas. Elige la
 * versión aplicable por CADA fecha (una versión puede cambiar dentro del rango),
 * componiendo work_days de esa versión + sus excepciones + feriados.
 */
/** company_id de una sucursal (o null si no existe / no tiene empresa). */
async function companyIdOfBranch(branchId) {
  if (branchId == null) return null;
  const [rows] = await sequelize.query(
    'SELECT company_id FROM branches WHERE id = ? LIMIT 1',
    { replacements: [branchId] },
  );
  return rows[0] ? (rows[0].company_id ?? null) : null;
}

/**
 * Precarga, en UNA sola consulta, todas las versiones de calendario del alcance
 * que solapan [from, to], con la MISMA precedencia que pickCalendarForDate
 * (sucursal > empresa > global; a igual especificidad, valid_from más reciente).
 * Cada fila lleva sus límites de vigencia normalizados a fecha civil ISO para
 * poder resolver la versión aplicable por fecha en memoria (evita el N+1 de una
 * consulta por día).
 */
async function loadScopeCalendars({ company_id = null, branch_id = null } = {}, from, to) {
  const { parseCivilDate, civilDateISO } = require('../utils/civilDate');
  const rows = await optionalQuery(
    `SELECT ${CALENDAR_COLS} FROM labor_calendars
      WHERE active = 1
        AND valid_from <= ?
        AND (valid_to IS NULL OR valid_to >= ?)
        AND (
              (branch_id = ? AND ? IS NOT NULL)
           OR (branch_id IS NULL AND company_id = ? AND ? IS NOT NULL)
           OR (branch_id IS NULL AND company_id IS NULL)
        )
      ORDER BY
        (branch_id IS NOT NULL) DESC,
        (company_id IS NOT NULL) DESC,
        valid_from DESC`,
    [to, from, branch_id, branch_id, company_id, company_id],
  );
  // Se preserva el orden del SQL (la precedencia); sólo se anexan los límites
  // en ISO para el filtro por fecha.
  return rows.map((r) => ({
    ...r,
    _vf: civilDateISO(parseCivilDate(r.valid_from)),
    _vt: r.valid_to == null ? null : civilDateISO(parseCivilDate(r.valid_to)),
  }));
}

/**
 * Elige, de la lista YA ORDENADA por precedencia, la primera versión que cubre
 * la fecha (valid_from <= date <= valid_to|∞). Equivale exactamente a
 * pickCalendarForDate (mismo WHERE de vigencia + mismo ORDER BY + LIMIT 1),
 * resuelto en memoria. Función pura para poder testearla.
 */
function pickFromCandidates(sorted, dateISO) {
  for (const c of sorted) {
    if (c._vf != null && c._vf <= dateISO && (c._vt == null || c._vt >= dateISO)) return c;
  }
  return null;
}

async function resolveEffectiveByScope(scope, from, to) {
  const holidaySet = await holidaysInRange(from, to);
  const start = from;
  const out = [];
  const excCache = new Map();     // calendarId → Map(date→kind)
  const { parseCivilDate, civilDateISO, addDaysUTC } = require('../utils/civilDate');
  let cur = parseCivilDate(from);
  const end = parseCivilDate(to);
  if (!cur || !end) throw httpError(400, 'INVALID_RANGE', 'Rango de fechas inválido');
  if (end.getTime() < cur.getTime()) throw httpError(400, 'INVALID_RANGE', '`to` es anterior a `from`');
  const totalDays = Math.round((end.getTime() - cur.getTime()) / 86400000) + 1;
  if (totalDays > laborCalendar.MAX_RANGE_DAYS) throw httpError(400, 'RANGE_TOO_WIDE', 'Rango demasiado amplio');

  // Precedencia sucursal > empresa > global: si el caller pide sólo por
  // sucursal, se deriva su empresa para que el nivel intermedio pueda aplicar
  // como fallback (antes se saltaba a global). No amplía el alcance: la empresa
  // de una sucursal en alcance está implícitamente en alcance.
  const effScope = { company_id: scope.company_id ?? null, branch_id: scope.branch_id ?? null };
  if (effScope.branch_id != null && effScope.company_id == null) {
    effScope.company_id = await companyIdOfBranch(effScope.branch_id);
  }

  // UNA sola consulta de calendarios candidatos para todo el rango (vs N+1).
  const candidates = await loadScopeCalendars(effScope, from, to);

  for (let i = 0; i < totalDays; i++) {
    const iso = civilDateISO(cur);
    const cal = pickFromCandidates(candidates, iso);
    let exceptionMap = new Map();
    let workDays = null;
    if (cal) {
      workDays = parseWorkDays(cal.work_days);
      if (!excCache.has(cal.id)) excCache.set(cal.id, await exceptionsInRange(cal.id, start, to));
      exceptionMap = excCache.get(cal.id);
    }
    const classified = laborCalendar.classifyDay(iso, { workDays, holidaySet, exceptionMap });
    out.push({ ...classified, calendar_id: cal ? cal.id : null });
    cur = addDaysUTC(cur, 1);
  }
  return {
    from, to, scope,
    working_days: out.filter((d) => d.working).length,
    total_days: out.length,
    days: out,
  };
}

// ─── Integración READ-ONLY con snapshots de jornada ─────────────────────────

/**
 * Conjunto COMPLETO de columnas que `workdayConfig.loadScheduleHistory` lee de
 * `employee_schedule_history` en el CAMINO NORMAL (`withPhaseCMetadata = true`).
 * `workdaySchemaState` exige TODAS: si falta cualquiera, la lectura de jornada
 * fallaría (o caería al reintento silencioso), así que el estado es 'incomplete'
 * y NUNCA se llama al SQL lector. Incluye:
 *   - base 072/073 (check_in/out, tolerancias, breaks, targets, work_regime,
 *     políticas, night_*, work_days, schedule_id, vigencia);
 *   - metadatos FASE C / 075 (schedule_name_snapshot, snapshot_*, change_reason,
 *     overtime/rounding_policy_version/config) — su ausencia hoy dispara el
 *     error+reintento interno; acá se declara explícitamente como 'incomplete'
 *     en vez de detectarse de forma silenciosa.
 */
const WORKDAY_REQUIRED_COLUMNS = [
  // Base 072 + 073 (siempre leídas):
  'schedule_id', 'valid_from', 'valid_to',
  'check_in', 'check_out', 'tolerance_in', 'tolerance_out',
  'break_mode', 'break_minutes', 'break_after_minutes',
  'weekly_target_minutes', 'daily_target_minutes',
  'work_regime', 'overtime_policy', 'rounding_policy',
  'night_start', 'night_end', 'work_days',
  // Metadatos FASE C / 075 (leídas en el camino normal):
  'schedule_name_snapshot', 'snapshot_version', 'snapshot_source', 'change_reason',
  'overtime_policy_version', 'overtime_policy_config',
  'rounding_policy_version', 'rounding_policy_config',
];

/**
 * Estado del esquema de jornada histórica (072/073/075):
 *   - 'missing'    : la tabla `employee_schedule_history` no existe (072 sin aplicar).
 *   - 'incomplete' : la tabla existe pero falta ALGUNA columna del camino normal
 *                    (base 072/073 **o** metadatos 075). Respuesta controlada:
 *                    NUNCA se llega al SQL lector ni al error+reintento silencioso.
 *   - 'complete'   : tabla + TODAS las columnas presentes.
 */
async function workdaySchemaState() {
  const [tbl] = await sequelize.query(
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_schedule_history' LIMIT 1`,
  );
  if (!tbl.length) return 'missing';
  const [cols] = await sequelize.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_schedule_history'`,
  );
  const present = new Set(cols.map((c) => String(c.name).toLowerCase()));
  const missing = WORKDAY_REQUIRED_COLUMNS.filter((c) => !present.has(c));
  return missing.length ? 'incomplete' : 'complete';
}

/**
 * Jornada vigente de un empleado en una fecha, SÓLO LECTURA, distinguiendo
 * explícitamente los tres estados del esquema. Nunca devuelve un error SQL crudo
 * ni un fallback silencioso ante esquema parcial. Valida `date` como fecha civil
 * REAL antes de tocar el esquema (2026-02-30 → 400, sin SQL lector).
 */
async function readWorkdayForDate(employeeId, date) {
  const { parseCivilDate } = require('../utils/civilDate');
  if (!parseCivilDate(date)) {
    throw httpError(400, 'INVALID_DATE', 'date no es una fecha civil válida');
  }
  const schema = await workdaySchemaState();
  if (schema === 'missing') {
    return { schema_state: 'missing', workday: { source: 'historical_fallback', config: null } };
  }
  if (schema === 'incomplete') {
    return {
      schema_state: 'incomplete',
      workday: null,
      message: 'Esquema de jornada parcialmente migrado (falta alguna columna de 072/073/075). No se resuelve jornada configurada hasta completar la migración.',
    };
  }
  const cfg = await workdayConfig.loadWorkdayConfig([employeeId], { from: date, to: date });
  const forDate = cfg.forDate(employeeId, date);
  return { schema_state: 'complete', workday: forDate || { source: 'historical_fallback', config: null } };
}

module.exports = {
  isWriteEnabled,
  assertWriteEnabled,
  isDupError,
  listCalendars,
  getCalendar,
  validateCalendarRefs,
  createCalendar,
  listExceptions,
  upsertException,
  holidaysInRange,
  exceptionsInRange,
  resolveEffective,
  resolveEffectiveByScope,
  pickCalendarForDate,
  loadScopeCalendars,
  pickFromCandidates,
  readWorkdayForDate,
  workdaySchemaState,
  normalizeWorkDays,
  parseWorkDays,
};
