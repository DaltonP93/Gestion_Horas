/**
 * workdayConfigDefaultsService.js — Backend de los DEFAULTS jerárquicos de
 * jornada (niveles general / empresa / departamento) con vigencia histórica.
 *
 * Complementa a workdayConfigurationService (nivel empleado). Reutiliza sus
 * validadores y el MISMO flag de escritura (WORKDAY_CONFIG_WRITE_ENABLED,
 * fail-closed) — no se duplica la compuerta ni los validadores.
 *
 * Ofrece: CRUD versionado (create/update/close) con lock por alcance, chequeo de
 * NO superposición de vigencias, PREVIEW/dry-run masivo (cero escrituras),
 * aplicación masiva (gateada), detección de conflictos/solapes y auditoría
 * completa (workday_config_default_audit). No recalcula daily_summary, no toca
 * att2000, no inventa datos.
 */

const { sequelize } = require('../config/database');
const { withDeadlockRetry } = require('../utils/mysqlRetry');
const { insertId } = require('../utils/insertId');
const wc = require('./workdayConfigurationService');
const workdayConfig = require('./workdayConfig');

const OPEN = '9999-12-31';
const SCOPES = Object.freeze(['general', 'company', 'department']);

function httpError(status, code, message) {
  const e = new Error(message || code);
  e.status = status; e.code = code;
  return e;
}

const isWriteEnabled = wc.isWriteEnabled;
function assertWriteEnabled() { return wc.assertWriteEnabled(); }

// ─────────────────────────────────────────────────────────────────────
// Helpers PUROS (sin BD) — testables directamente.
// ─────────────────────────────────────────────────────────────────────

/** Clave de alcance determinista, idéntica a la columna generada de la 085. */
function scopeKey(scope, companyId, departmentId) {
  return `${scope}:${companyId == null ? 0 : companyId}:${departmentId == null ? 0 : departmentId}`;
}

/**
 * Normaliza y valida la identidad de alcance. SEMÁNTICA ÚNICA (Corrección C),
 * idéntica a la que resuelve el motor (scope_key = scope:company:department):
 *   general    → sin company_id ni department_id  → general:0:0
 *   company    → company_id obligatorio, department_id NULL → company:<c>:0
 *   department → department_id obligatorio, company_id NULL → department:0:<d>
 *
 * `department` RECHAZA company_id: el resolvedor del motor busca
 * `department:0:<id>`, así que aceptar un company_id crearía un default con un
 * scope_key `department:<c>:<id>` que jamás se consultaría (invisible). Lanza
 * 400 SCOPE_MISMATCH ante cualquier combinación incoherente.
 */
function normalizeScopeTarget(input = {}) {
  const scope = String(input.scope || '').trim();
  if (!SCOPES.includes(scope)) throw httpError(400, 'INVALID_SCOPE', `scope inválido: ${scope}`);
  const companyId = input.company_id == null || input.company_id === '' ? null : Number(input.company_id);
  const departmentId = input.department_id == null || input.department_id === '' ? null : Number(input.department_id);
  if (companyId != null && !Number.isInteger(companyId)) throw httpError(400, 'INVALID_COMPANY', 'company_id inválido');
  if (departmentId != null && !Number.isInteger(departmentId)) throw httpError(400, 'INVALID_DEPARTMENT', 'department_id inválido');
  if (scope === 'general' && (companyId != null || departmentId != null)) throw httpError(400, 'SCOPE_MISMATCH', 'general no admite company_id/department_id');
  if (scope === 'company') {
    if (companyId == null) throw httpError(400, 'SCOPE_MISMATCH', 'company requiere company_id');
    if (departmentId != null) throw httpError(400, 'SCOPE_MISMATCH', 'company no admite department_id');
  }
  if (scope === 'department') {
    if (departmentId == null) throw httpError(400, 'SCOPE_MISMATCH', 'department requiere department_id');
    if (companyId != null) throw httpError(400, 'SCOPE_MISMATCH', 'department no admite company_id (el scope de departamento es department:0:<id>)');
  }
  return { scope, company_id: companyId, department_id: departmentId };
}

/** Día civil anterior a 'YYYY-MM-DD' (determinista, sin timezone). */
function prevDayISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Superposición inclusiva de vigencias; valid_to null = abierta. */
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const aEnd = aTo || OPEN;
  const bEnd = bTo || OPEN;
  return aFrom <= bEnd && bFrom <= aEnd;
}

/**
 * Valida el cuerpo de un default y devuelve columnas normalizadas listas para
 * persistir. Reutiliza los validadores de workdayConfigurationService.
 * Exige vigencia válida; el payload de jornada puede ser parcial (se marcará
 * como incompleto en la resolución), salvo que `requireComplete` sea true.
 */
function normalizeDefaultBody(input = {}, { requireComplete = false } = {}) {
  const target = normalizeScopeTarget(input);
  const validFrom = input.valid_from == null ? '' : String(input.valid_from).slice(0, 10);
  if (!wc.validDateISO(validFrom)) throw httpError(400, 'INVALID_VALID_FROM', 'valid_from (YYYY-MM-DD) requerido');
  let validTo = null;
  if (input.valid_to != null && input.valid_to !== '') {
    validTo = String(input.valid_to).slice(0, 10);
    if (!wc.validDateISO(validTo)) throw httpError(400, 'INVALID_VALID_TO', 'valid_to inválido');
    if (validTo < validFrom) throw httpError(400, 'INVALID_VALIDITY', 'valid_to < valid_from');
  }
  // Validadores COMPARTIDOS con employee_schedule_history (Corrección E): mismos
  // rangos y mismos errores. No se duplican versiones más débiles.
  const workDays = wc.normalizeWorkDays(input.work_days);            // null o array 1..7; lanza si inválido
  const regime = wc.normalizeRegime(input.work_regime);              // lanza INVALID_WORK_REGIME
  const breakMode = input.break_mode == null || input.break_mode === '' ? 'punched' : String(input.break_mode);
  if (!wc.BREAK_MODES.has(breakMode)) throw httpError(400, 'INVALID_BREAK_MODE', `break_mode inválido: ${breakMode}`);

  const checkIn = wc.normalizeTime(input.check_in, 'check_in');      // HH:mm[:ss] o null; lanza si inválido
  const checkOut = wc.normalizeTime(input.check_out, 'check_out');
  const nightStart = wc.normalizeTime(input.night_start, 'night_start');
  const nightEnd = wc.normalizeTime(input.night_end, 'night_end');
  if ((nightStart == null) !== (nightEnd == null)) {
    throw httpError(400, 'INVALID_NIGHT_RANGE', 'night_start y night_end deben configurarse juntos');
  }

  const row = {
    ...target,
    label: input.label == null ? null : String(input.label).slice(0, 120),
    valid_from: validFrom,
    valid_to: validTo,
    check_in: checkIn,
    check_out: checkOut,
    tolerance_in: wc.normalizeInt(input.tolerance_in, 'tolerance_in', { min: 0, max: 1440 }),
    tolerance_out: wc.normalizeInt(input.tolerance_out, 'tolerance_out', { min: 0, max: 1440 }),
    break_mode: breakMode,
    break_minutes: wc.normalizeInt(input.break_minutes ?? 0, 'break_minutes', { min: 0, max: 1440, nullable: false }),
    break_after_minutes: wc.normalizeInt(input.break_after_minutes ?? 0, 'break_after_minutes', { min: 0, max: 1440, nullable: false }),
    weekly_target_minutes: wc.normalizeInt(input.weekly_target_minutes, 'weekly_target_minutes', { min: 0, max: 10080 }),
    daily_target_minutes: wc.normalizeInt(input.daily_target_minutes, 'daily_target_minutes', { min: 0, max: 1440 }),
    work_regime: regime,
    overtime_policy: wc.normalizePolicy(input.overtime_policy, 'overtime_policy'),
    overtime_policy_version: wc.normalizeInt(input.overtime_policy_version, 'overtime_policy_version', { min: 1, max: 100000 }),
    overtime_policy_config: wc.normalizeJson(input.overtime_policy_config, 'overtime_policy_config'),
    rounding_policy: wc.normalizePolicy(input.rounding_policy, 'rounding_policy'),
    rounding_policy_version: wc.normalizeInt(input.rounding_policy_version, 'rounding_policy_version', { min: 1, max: 100000 }),
    rounding_policy_config: wc.normalizeJson(input.rounding_policy_config, 'rounding_policy_config'),
    night_start: nightStart,
    night_end: nightEnd,
    work_days: workDays == null ? null : workDays.join(','),
    change_reason: input.change_reason || input.reason || null,
  };
  row.scope_key = scopeKey(row.scope, row.company_id, row.department_id);
  row.config_complete = !!(row.check_in && row.check_out && workDays && workDays.length > 0);
  if (requireComplete && !row.config_complete) throw httpError(400, 'INCOMPLETE_CONFIG', 'check_in/check_out/work_days requeridos');
  return row;
}

/**
 * Detección de conflictos INTRA-lote (puro): agrupa por scope_key y marca pares
 * con vigencias solapadas. Devuelve array de conflictos { a, b, scope_key }.
 */
function detectBatchConflicts(rows) {
  const byScope = new Map();
  rows.forEach((r, index) => {
    const k = r.scope_key || scopeKey(r.scope, r.company_id, r.department_id);
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push({ ...r, index });
  });
  const conflicts = [];
  for (const [k, arr] of byScope.entries()) {
    arr.sort((a, b) => (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : a.index - b.index));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (rangesOverlap(arr[i].valid_from, arr[i].valid_to, arr[j].valid_from, arr[j].valid_to)) {
          conflicts.push({ scope_key: k, a_index: arr[i].index, b_index: arr[j].index });
        }
      }
    }
  }
  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────
// BD
// ─────────────────────────────────────────────────────────────────────

const INSERT_COLS = [
  'scope', 'company_id', 'department_id', 'label', 'valid_from', 'valid_to',
  'check_in', 'check_out', 'tolerance_in', 'tolerance_out', 'break_mode',
  'break_minutes', 'break_after_minutes', 'weekly_target_minutes', 'daily_target_minutes',
  'work_regime',
  'overtime_policy', 'overtime_policy_version', 'overtime_policy_config',
  'rounding_policy', 'rounding_policy_version', 'rounding_policy_config',
  'night_start', 'night_end', 'work_days', 'change_reason',
];

/** Columnas UPDATE (paridad con INSERT_COLS salvo alcance/vigencia inmutables). */
const UPDATE_COLS = [
  'label', 'valid_from', 'valid_to', 'check_in', 'check_out', 'tolerance_in', 'tolerance_out',
  'break_mode', 'break_minutes', 'break_after_minutes', 'weekly_target_minutes', 'daily_target_minutes',
  'work_regime',
  'overtime_policy', 'overtime_policy_version', 'overtime_policy_config',
  'rounding_policy', 'rounding_policy_version', 'rounding_policy_config',
  'night_start', 'night_end', 'work_days', 'change_reason',
];

const JSON_COLS = new Set(['overtime_policy_config', 'rounding_policy_config']);

/** Serializa objetos JSON de policy a string para el driver crudo; resto tal cual. */
function colValue(r, c) {
  const v = r[c] === undefined ? null : r[c];
  if (JSON_COLS.has(c) && v != null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function rowToInsertValues(r) { return INSERT_COLS.map(c => colValue(r, c)); }

/** Filas afectadas por un UPDATE crudo (mysql2/sequelize). */
function affectedRowsOf(res) {
  return (res && (res.affectedRows ?? res.rowCount)) || 0;
}

/** ¿La versión está ABIERTA (vigencia sin cerrar y activa)? */
function isOpenVersion(row) {
  return !!row && (row.valid_to == null) && (row.active == null || Number(row.active) === 1);
}

/**
 * Toma el LOCK TRANSACCIONAL de un alcance (Corrección K): asegura la fila del
 * scope en `workday_config_scope_locks` y la bloquea con `SELECT ... FOR UPDATE`.
 * El row-lock de InnoDB se retiene AUTOMÁTICAMENTE hasta el COMMIT/ROLLBACK de la
 * transacción — a diferencia de GET_LOCK/RELEASE_LOCK, que se liberaba dentro del
 * callback ANTES del commit y abría una ventana de no-serialización entre writers.
 */
async function lockScopeRow(t, scopeKeyStr) {
  await sequelize.query(
    'INSERT INTO workday_config_scope_locks (scope_key) VALUES (?) ON DUPLICATE KEY UPDATE scope_key = VALUES(scope_key)',
    { replacements: [scopeKeyStr], transaction: t },
  );
  await sequelize.query(
    'SELECT scope_key FROM workday_config_scope_locks WHERE scope_key = ? FOR UPDATE',
    { replacements: [scopeKeyStr], transaction: t },
  );
}

/**
 * Ejecuta `fn(t)` con el alcance `scopeKeyStr` bloqueado hasta DESPUÉS del commit.
 * Create/update/supersede/close del MISMO alcance compiten por la MISMA fila de
 * lock; el lock sólo se suelta cuando Sequelize hace commit (o rollback) al
 * resolver el callback. No hay RELEASE manual.
 */
async function withScopeLock(scopeKeyStr, fn) {
  const { result } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    await lockScopeRow(t, scopeKeyStr);
    return fn(t);
  }));
  return result;
}

/** scope_key real de una fila (SELECT liviano). El alcance es INMUTABLE. */
async function readScopeKeyById(id) {
  const [rows] = await sequelize.query('SELECT scope_key FROM workday_config_defaults WHERE id = ?', { replacements: [id] });
  return rows && rows[0] ? rows[0].scope_key : null;
}

async function assertNoOverlapDb(t, { scope_key, valid_from, valid_to, excludeId = null }) {
  // Solape inclusivo: (existente.from <= nueva.end) AND (nueva.from <= existente.end).
  let sql = `SELECT id FROM workday_config_defaults
               WHERE scope_key = ? AND active = 1
                 AND valid_from <= IFNULL(?, '${OPEN}') AND ? <= IFNULL(valid_to, '${OPEN}')`;
  const params = [scope_key, valid_to, valid_from];
  if (excludeId != null) { sql += ' AND id <> ?'; params.push(excludeId); }
  sql += ' LIMIT 1';
  const [hit] = await sequelize.query(sql, { replacements: params, transaction: t });
  if (hit && hit.length) throw httpError(409, 'WORKDAY_CONFIG_DEFAULT_OVERLAP', 'vigencia solapada en el mismo alcance');
}

async function auditDefault(t, { default_id, scope, company_id, department_id, action, actor_id, before, after, change_reason }) {
  await sequelize.query(
    `INSERT INTO workday_config_default_audit
       (default_id, scope, company_id, department_id, action, actor_id, before_json, after_json, change_reason)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    { replacements: [default_id ?? null, scope ?? null, company_id ?? null, department_id ?? null, action,
        actor_id ?? null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, change_reason ?? null],
      transaction: t }
  );
}

async function readDefault(t, id) {
  const [rows] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ? FOR UPDATE', { replacements: [id], transaction: t });
  return rows && rows[0] ? rows[0] : null;
}

/** Lista defaults filtrando por alcance (opcional). Read-only (no gateado). */
async function listDefaults({ scope = null, company_id = null, department_id = null, includeInactive = false } = {}) {
  const where = [];
  const repl = [];
  if (scope) { where.push('scope = ?'); repl.push(scope); }
  if (company_id != null) { where.push('company_id = ?'); repl.push(Number(company_id)); }
  if (department_id != null) { where.push('department_id = ?'); repl.push(Number(department_id)); }
  if (!includeInactive) where.push('active = 1');
  const sql = `SELECT * FROM workday_config_defaults ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY scope, company_id, department_id, valid_from DESC, id DESC`;
  const [rows] = await sequelize.query(sql, { replacements: repl });
  return rows || [];
}

async function createDefault(body, actorId) {
  assertWriteEnabled();
  const row = normalizeDefaultBody(body);
  return withScopeLock(row.scope_key, async (t) => {
    await assertNoOverlapDb(t, row);
    const [res] = await sequelize.query(
      `INSERT INTO workday_config_defaults (${INSERT_COLS.join(', ')}, created_by, updated_by)
       VALUES (${INSERT_COLS.map(() => '?').join(', ')}, ?, ?)`,
      { replacements: [...rowToInsertValues(row), actorId ?? null, actorId ?? null], transaction: t }
    );
    const id = insertId(res);
    const [created] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [id], transaction: t });
    const after = created && created[0] ? created[0] : { id };
    await auditDefault(t, { default_id: id, scope: row.scope, company_id: row.company_id, department_id: row.department_id, action: 'create', actor_id: actorId, before: null, after, change_reason: row.change_reason });
    return after;
  });
}

// Campos de configuración EFECTIVA: inmutables in-place (Corrección I). Cambiarlos
// requiere `supersedeDefault` (versión nueva), nunca un UPDATE sobre la fila.
const EFFECTIVE_FIELDS = Object.freeze([
  'valid_from', 'valid_to', 'check_in', 'check_out', 'tolerance_in', 'tolerance_out',
  'break_mode', 'break_minutes', 'break_after_minutes', 'weekly_target_minutes',
  'daily_target_minutes', 'work_regime', 'night_start', 'night_end', 'work_days',
  'overtime_policy', 'overtime_policy_version', 'overtime_policy_config',
  'rounding_policy', 'rounding_policy_version', 'rounding_policy_config',
  'scope', 'company_id', 'department_id',
]);
// Metadata NO efectiva: lo único que un UPDATE in-place puede tocar.
const METADATA_FIELDS = Object.freeze(['label', 'change_reason']);

/**
 * UPDATE in-place LIMITADO a metadata (label/change_reason). Cualquier intento de
 * cambiar configuración efectiva o vigencia se rechaza con 409
 * IMMUTABLE_EFFECTIVE_CONFIG: el pasado no se reescribe (Corrección I) — para eso
 * está `supersedeDefault`. Bajo el MISMO scope lock y con auditoría.
 */
async function updateDefault(id, body, actorId) {
  assertWriteEnabled();
  const input = body || {};
  const forbidden = EFFECTIVE_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(input, f) && input[f] !== undefined);
  if (forbidden.length) {
    throw httpError(409, 'IMMUTABLE_EFFECTIVE_CONFIG',
      `No se puede modificar in-place configuración efectiva/vigencia (${forbidden.join(', ')}); usá supersede`);
  }
  const sk = await readScopeKeyById(id);
  if (!sk) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
  return withScopeLock(sk, async (t) => {
    const before = await readDefault(t, id);
    if (!before) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
    const label = Object.prototype.hasOwnProperty.call(input, 'label')
      ? (input.label == null ? null : String(input.label).slice(0, 120)) : before.label;
    const changeReason = input.change_reason ?? input.reason ?? before.change_reason ?? null;
    await sequelize.query(
      'UPDATE workday_config_defaults SET label=?, change_reason=?, updated_by=? WHERE id=?',
      { replacements: [label, changeReason, actorId ?? null, id], transaction: t },
    );
    const [after] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [id], transaction: t });
    await auditDefault(t, { default_id: id, scope: before.scope, company_id: before.company_id, department_id: before.department_id, action: 'update_metadata', actor_id: actorId, before, after: after[0], change_reason: changeReason });
    return { before, after: after[0] };
  });
}

/**
 * SUPERSEDE (append-only, Corrección I): cambia la configuración desde una fecha
 * `effective_from` creando una VERSIÓN NUEVA y cerrando la anterior en
 * `effective_from - 1`, sin reescribir el payload histórico. Atómico: mismo scope
 * lock, una transacción, rollback total ante error.
 *   v1: valid_from=A .. valid_to=effective_from-1  (payload viejo intacto)
 *   v2: valid_from=effective_from .. NULL          (payload nuevo)
 */
async function supersedeDefault(id, body, actorId) {
  assertWriteEnabled();
  const input = body || {};
  const effectiveFrom = input.effective_from == null ? '' : String(input.effective_from).slice(0, 10);
  if (!wc.validDateISO(effectiveFrom)) throw httpError(400, 'INVALID_EFFECTIVE_FROM', 'effective_from (YYYY-MM-DD) requerido');

  const sk = await readScopeKeyById(id);
  if (!sk) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
  return withScopeLock(sk, async (t) => {
    const before = await readDefault(t, id);
    if (!before) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
    // Sólo se supersede una versión ABIERTA (Corrección L): superseder una versión
    // ya cerrada reescribiría el pasado / crearía una sucesora colgada.
    if (!isOpenVersion(before)) {
      throw httpError(409, 'SUPERSEDE_REQUIRES_OPEN_VERSION',
        'sólo puede superseerse una versión vigente (valid_to IS NULL y activa)');
    }
    const beforeFrom = String(before.valid_from).slice(0, 10);
    // No se permite corrección histórica in-band: effective_from debe ser POSTERIOR
    // al inicio de la versión que se supersede (un flujo de corrección del pasado
    // queda explícitamente fuera de alcance).
    if (effectiveFrom <= beforeFrom) {
      throw httpError(409, 'SUPERSEDE_NOT_FORWARD',
        'effective_from debe ser posterior al valid_from de la versión vigente');
    }

    // La versión nueva hereda el alcance (inmutable) y toma el payload del body,
    // con lo no especificado heredado de la versión anterior. Vigencia: abierta.
    const merged = {
      ...before, ...input,
      scope: before.scope, company_id: before.company_id, department_id: before.department_id,
      valid_from: effectiveFrom, valid_to: null,
    };
    const row = normalizeDefaultBody(merged);

    // Ninguna OTRA versión activa debe cubrir [effective_from, ∞) (excluye la que
    // vamos a cerrar).
    await assertNoOverlapDb(t, { scope_key: row.scope_key, valid_from: effectiveFrom, valid_to: null, excludeId: id });

    // Cierra la versión anterior en effective_from - 1 (el pasado queda intacto).
    const closedTo = prevDayISO(effectiveFrom);
    const [closeRes] = await sequelize.query(
      'UPDATE workday_config_defaults SET valid_to=?, updated_by=? WHERE id=? AND valid_to IS NULL',
      { replacements: [closedTo, actorId ?? null, id], transaction: t },
    );
    // Fail-closed + rollback si el cierre no afectó EXACTAMENTE 1 fila (p. ej. otra
    // transacción la cerró entre el read y el UPDATE): jamás se crea la sucesora
    // afirmando un cierre que no ocurrió.
    if (affectedRowsOf(closeRes) !== 1) {
      throw httpError(409, 'SUPERSEDE_REQUIRES_OPEN_VERSION', 'la versión dejó de estar abierta durante la operación');
    }
    // Relee la versión anterior ya cerrada (para auditoría before/after fiel).
    const [closedRows] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [id], transaction: t });
    await auditDefault(t, { default_id: id, scope: before.scope, company_id: before.company_id, department_id: before.department_id, action: 'supersede_close', actor_id: actorId, before, after: closedRows[0], change_reason: row.change_reason });

    // Inserta la versión nueva.
    const [res] = await sequelize.query(
      `INSERT INTO workday_config_defaults (${INSERT_COLS.join(', ')}, created_by, updated_by)
       VALUES (${INSERT_COLS.map(() => '?').join(', ')}, ?, ?)`,
      { replacements: [...rowToInsertValues(row), actorId ?? null, actorId ?? null], transaction: t },
    );
    const newId = insertId(res);
    const [createdRows] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [newId], transaction: t });
    const created = createdRows && createdRows[0] ? createdRows[0] : { id: newId };
    await auditDefault(t, { default_id: newId, scope: row.scope, company_id: row.company_id, department_id: row.department_id, action: 'supersede_create', actor_id: actorId, before: null, after: created, change_reason: row.change_reason });

    return { closed_id: id, closed_valid_to: closedTo, created };
  });
}

/**
 * Cierre DELIBERADO de una versión: fija `valid_to` (sin borrar la fila ni tocar
 * su payload). Semántica: se usa para TERMINAR la vigencia de un alcance
 * (p. ej. un departamento que deja de existir) sin abrir una versión sucesora.
 * Para CAMBIAR la configuración desde una fecha, usar `supersedeDefault` (que
 * cierra y crea la sucesora en una sola operación). Bajo el MISMO scope lock y
 * con auditoría; el pasado queda intacto.
 */
async function closeDefault(id, validTo, actorId, reason) {
  assertWriteEnabled();
  const to = validTo == null ? '' : String(validTo).slice(0, 10);
  if (!wc.validDateISO(to)) throw httpError(400, 'INVALID_VALID_TO', 'valid_to (YYYY-MM-DD) requerido');
  // Mismo lock de alcance que create/update (Corrección D), no `close:<id>`.
  const sk = await readScopeKeyById(id);
  if (!sk) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
  return withScopeLock(sk, async (t) => {
    const before = await readDefault(t, id);
    if (!before) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
    // Sólo se cierra una versión ABIERTA (Corrección L): una versión histórica ya
    // cerrada NO se re-cierra silenciosamente (eso mutaría el pasado).
    if (!isOpenVersion(before)) {
      throw httpError(409, 'DEFAULT_ALREADY_CLOSED', 'la versión ya está cerrada; no se re-cierra una versión histórica');
    }
    const from = String(before.valid_from).slice(0, 10);
    if (to < from) throw httpError(400, 'INVALID_VALIDITY', 'valid_to < valid_from');
    const [res] = await sequelize.query('UPDATE workday_config_defaults SET valid_to=?, updated_by=? WHERE id=? AND valid_to IS NULL', { replacements: [to, actorId ?? null, id], transaction: t });
    if (affectedRowsOf(res) !== 1) throw httpError(409, 'DEFAULT_ALREADY_CLOSED', 'la versión dejó de estar abierta durante la operación');
    const [after] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [id], transaction: t });
    await auditDefault(t, { default_id: id, scope: before.scope, company_id: before.company_id, department_id: before.department_id, action: 'close', actor_id: actorId, before, after: after[0], change_reason: reason || null });
    return { before, after: after[0] };
  });
}

/**
 * PREVIEW/dry-run masivo. NO escribe NADA. Valida cada ítem, detecta solapes
 * intra-lote y contra la BD (una consulta por alcance involucrado, sin N+1) y
 * devuelve el veredicto por fila. Base de la importación masiva.
 */
async function bulkPreview(items) {
  const results = [];
  const normalized = [];
  (items || []).forEach((raw, index) => {
    try {
      const row = normalizeDefaultBody(raw);
      normalized.push({ ...row, index });
      results.push({ index, status: row.config_complete ? 'ok' : 'incomplete', scope_key: row.scope_key, valid_from: row.valid_from, valid_to: row.valid_to, messages: row.config_complete ? [] : ['config incompleta: se resolverá por precedencia inferior'] });
    } catch (e) {
      results.push({ index, status: 'invalid', messages: [e.code || 'INVALID'], detail: e.message });
    }
  });

  // Solapes intra-lote (puro).
  for (const c of detectBatchConflicts(normalized)) {
    for (const idx of [c.a_index, c.b_index]) {
      const r = results.find(x => x.index === idx);
      if (r && r.status !== 'invalid') { r.status = 'overlap'; r.messages.push(`solape intra-lote en ${c.scope_key}`); }
    }
  }

  // Solapes contra BD: una sola consulta por scope_key distinto (sin N+1).
  const scopeKeys = [...new Set(normalized.map(r => r.scope_key))];
  if (scopeKeys.length) {
    const [existing] = await sequelize.query(
      `SELECT id, scope_key, DATE_FORMAT(valid_from,'%Y-%m-%d') AS valid_from,
              DATE_FORMAT(valid_to,'%Y-%m-%d') AS valid_to
         FROM workday_config_defaults
        WHERE active = 1 AND scope_key IN (${scopeKeys.map(() => '?').join(',')})`,
      { replacements: scopeKeys }
    );
    const byScope = new Map();
    for (const e of existing || []) {
      if (!byScope.has(e.scope_key)) byScope.set(e.scope_key, []);
      byScope.get(e.scope_key).push(e);
    }
    for (const r of normalized) {
      const rowResult = results.find(x => x.index === r.index);
      if (!rowResult || rowResult.status === 'invalid') continue;
      const clash = (byScope.get(r.scope_key) || []).some(e => rangesOverlap(r.valid_from, r.valid_to, e.valid_from, e.valid_to));
      if (clash) { rowResult.status = 'overlap'; rowResult.messages.push('solape con vigencia existente en BD'); }
    }
  }

  const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  return { dry_run: true, total: results.length, summary, results };
}

/**
 * Aplicación masiva ATÓMICA (Corrección D): todo el lote se persiste en UNA
 * transacción o nada. Pasos:
 *   1. assertWriteEnabled ANTES de cualquier escritura (fail-closed).
 *   2. Normalizar el lote COMPLETO exigiendo config completa: cualquier ítem
 *      inválido/incompleto aborta sin escribir (política por defecto: no se
 *      aplican defaults incompletos en lote).
 *   3. Bloquear solapes intra-lote.
 *   4. Adquirir los locks de los scope_keys en orden DETERMINISTA (sin deadlocks).
 *   5. Revalidar solapes contra la BD e INSERTAR + auditar cada fila.
 *   6. COMMIT de todo; ante cualquier error, ROLLBACK de todo (0 filas).
 */
async function bulkApply(items, actorId) {
  assertWriteEnabled();
  const list = Array.isArray(items) ? items : [];
  // (2) Normalización estricta de TODO el lote antes de tocar la BD.
  const rows = list.map((raw, index) => {
    try {
      return { ...normalizeDefaultBody(raw, { requireComplete: true }), index };
    } catch (e) {
      throw httpError(e.status || 400, 'BULK_ITEM_INVALID', `ítem #${index}: ${e.code || 'INVALID'} — ${e.message}`);
    }
  });
  // (3) Solapes intra-lote.
  const intra = detectBatchConflicts(rows);
  if (intra.length) throw httpError(409, 'BULK_HAS_CONFLICTS', `solape intra-lote en ${intra.length} par(es)`);
  if (!rows.length) return { applied: 0, created: [] };

  // (4) Locks TRANSACCIONALES en orden determinista (scope_keys ordenados): las
  // filas de `workday_config_scope_locks` se bloquean FOR UPDATE y quedan tomadas
  // hasta el commit (Corrección K). El orden fijo evita deadlocks entre lotes.
  const scopeKeysSorted = [...new Set(rows.map(r => r.scope_key))].sort();

  const { result } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    for (const sk of scopeKeysSorted) await lockScopeRow(t, sk);
    // (5) Cada fila: revalida solape (incluye inserciones previas de esta misma
    // transacción) e inserta + audita. Todo dentro de la única transacción.
    const created = [];
    for (const row of rows) {
      await assertNoOverlapDb(t, row);
      const [res] = await sequelize.query(
        `INSERT INTO workday_config_defaults (${INSERT_COLS.join(', ')}, created_by, updated_by)
         VALUES (${INSERT_COLS.map(() => '?').join(', ')}, ?, ?)`,
        { replacements: [...rowToInsertValues(row), actorId ?? null, actorId ?? null], transaction: t }
      );
      const id = insertId(res);
      const [sel] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [id], transaction: t });
      const after = sel && sel[0] ? sel[0] : { id };
      await auditDefault(t, { default_id: id, scope: row.scope, company_id: row.company_id, department_id: row.department_id, action: 'create', actor_id: actorId, before: null, after, change_reason: row.change_reason });
      created.push(after);
    }
    return created;
    // COMMIT (al resolver el callback) libera automáticamente los row-locks.
  }));
  return { applied: result.length, created: result };
}

// ─────────────────────────────────────────────────────────────────────
// Resolución EFECTIVA por empleado+fecha.
//
// NO reimplementa la precedencia: delega en el ÚNICO resolvedor del motor
// (`workdayConfig.resolveForDate`), el mismo que consumen workdaySummaryService
// y el scheduler. Así el endpoint administrativo muestra EXACTAMENTE lo que el
// motor usaría para ese empleado/fecha (Corrección A/G). Read-only.
// ─────────────────────────────────────────────────────────────────────

/**
 * Configuración efectiva de un empleado en una fecha. Envoltura del resolvedor
 * del motor: `{ layer, calculation_mode, config, contract_id, scope,
 * precedence_considered, precedence }`.
 */
async function getEffectiveForDate(employeeId, dateISO) {
  const date = dateISO == null ? '' : String(dateISO).slice(0, 10);
  if (!wc.validDateISO(date)) throw httpError(400, 'INVALID_DATE', 'date (YYYY-MM-DD) requerido');
  const resolver = await workdayConfig.loadWorkdayConfig([employeeId], { from: date, to: date });
  const resolved = resolver.resolveForDate(employeeId, date);
  return {
    employee_id: Number(employeeId),
    date,
    layer: resolved.layer,
    calculation_mode: resolved.calculation_mode,
    config: resolved.config,
    contract_id: resolved.contract_id,
    scope: resolved.scope,
    precedence_considered: resolved.precedence_considered,
    precedence: workdayConfig.PRECEDENCE,
  };
}

module.exports = {
  SCOPES,
  PRECEDENCE: workdayConfig.PRECEDENCE,
  isWriteEnabled,
  assertWriteEnabled,
  scopeKey,
  normalizeScopeTarget,
  normalizeDefaultBody,
  rangesOverlap,
  detectBatchConflicts,
  listDefaults,
  createDefault,
  updateDefault,
  supersedeDefault,
  closeDefault,
  bulkPreview,
  bulkApply,
  getEffectiveForDate,
};
