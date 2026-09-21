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
const eff = require('./workdayEffectiveConfig');

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
 * Normaliza y valida la identidad de alcance. general → sin empresa/depto;
 * company → company_id obligatorio, sin department_id; department → department_id
 * obligatorio (company_id opcional, informativo). Lanza 400 si es incoherente.
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
  if (scope === 'department' && departmentId == null) throw httpError(400, 'SCOPE_MISMATCH', 'department requiere department_id');
  return { scope, company_id: companyId, department_id: departmentId };
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
  const workDays = input.work_days == null ? null : wc.normalizeWorkDays(input.work_days);
  const regime = input.work_regime == null || input.work_regime === '' ? null : String(input.work_regime);
  if (regime != null && !wc.WORK_REGIMES.has(regime)) throw httpError(400, 'INVALID_REGIME', `work_regime inválido: ${regime}`);
  const breakMode = input.break_mode == null || input.break_mode === '' ? 'punched' : String(input.break_mode);
  if (!wc.BREAK_MODES.has(breakMode)) throw httpError(400, 'INVALID_BREAK_MODE', `break_mode inválido: ${breakMode}`);

  const num = (v) => (v == null || v === '' ? null : Number(v));
  const time = (v) => (v == null || v === '' ? null : String(v));

  const row = {
    ...target,
    label: input.label == null ? null : String(input.label).slice(0, 120),
    valid_from: validFrom,
    valid_to: validTo,
    check_in: time(input.check_in),
    check_out: time(input.check_out),
    tolerance_in: num(input.tolerance_in),
    tolerance_out: num(input.tolerance_out),
    break_mode: breakMode,
    break_minutes: num(input.break_minutes) || 0,
    break_after_minutes: num(input.break_after_minutes) || 0,
    weekly_target_minutes: num(input.weekly_target_minutes),
    daily_target_minutes: num(input.daily_target_minutes),
    work_regime: regime,
    overtime_policy: input.overtime_policy || null,
    rounding_policy: input.rounding_policy || null,
    night_start: time(input.night_start),
    night_end: time(input.night_end),
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
  'work_regime', 'overtime_policy', 'rounding_policy', 'night_start', 'night_end',
  'work_days', 'change_reason',
];

function rowToInsertValues(r) { return INSERT_COLS.map(c => r[c] === undefined ? null : r[c]); }

async function withScopeLock(key, fn) {
  const { result } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    const lockName = `sishoras:wcd:${key}`.slice(0, 64);
    const [rows] = await sequelize.query('SELECT GET_LOCK(?, 10) AS ok', { replacements: [lockName], transaction: t });
    const ok = Array.isArray(rows) && rows[0] ? rows[0].ok : null;
    if (Number(ok) !== 1) throw httpError(409, 'WORKDAY_CONFIG_LOCK_TIMEOUT', 'no se pudo obtener el lock');
    try { return await fn(t); }
    finally { await sequelize.query('SELECT RELEASE_LOCK(?)', { replacements: [lockName], transaction: t }); }
  }));
  return result;
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

async function updateDefault(id, body, actorId) {
  assertWriteEnabled();
  return withScopeLock(scopeKey(body.scope || 'general', body.company_id, body.department_id), async (t) => {
    const before = await readDefault(t, id);
    if (!before) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
    // El alcance de un default NO se muda; se corrige su vigencia/payload.
    const merged = { ...before, ...body, scope: before.scope, company_id: before.company_id, department_id: before.department_id };
    const row = normalizeDefaultBody(merged);
    await assertNoOverlapDb(t, { ...row, excludeId: id });
    await sequelize.query(
      `UPDATE workday_config_defaults SET
         label=?, valid_from=?, valid_to=?, check_in=?, check_out=?, tolerance_in=?, tolerance_out=?,
         break_mode=?, break_minutes=?, break_after_minutes=?, weekly_target_minutes=?, daily_target_minutes=?,
         work_regime=?, overtime_policy=?, rounding_policy=?, night_start=?, night_end=?, work_days=?,
         change_reason=?, config_version = config_version + 1, updated_by=?
       WHERE id=?`,
      { replacements: [row.label, row.valid_from, row.valid_to, row.check_in, row.check_out, row.tolerance_in, row.tolerance_out,
          row.break_mode, row.break_minutes, row.break_after_minutes, row.weekly_target_minutes, row.daily_target_minutes,
          row.work_regime, row.overtime_policy, row.rounding_policy, row.night_start, row.night_end, row.work_days,
          row.change_reason, actorId ?? null, id], transaction: t }
    );
    const [after] = await sequelize.query('SELECT * FROM workday_config_defaults WHERE id = ?', { replacements: [id], transaction: t });
    await auditDefault(t, { default_id: id, scope: before.scope, company_id: before.company_id, department_id: before.department_id, action: 'update', actor_id: actorId, before, after: after[0], change_reason: row.change_reason });
    return { before, after: after[0] };
  });
}

/** Cierra la vigencia (valid_to) sin borrar; el pasado queda intacto. */
async function closeDefault(id, validTo, actorId, reason) {
  assertWriteEnabled();
  const to = validTo == null ? '' : String(validTo).slice(0, 10);
  if (!wc.validDateISO(to)) throw httpError(400, 'INVALID_VALID_TO', 'valid_to (YYYY-MM-DD) requerido');
  return withScopeLock(`close:${id}`, async (t) => {
    const before = await readDefault(t, id);
    if (!before) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
    const from = String(before.valid_from).slice(0, 10);
    if (to < from) throw httpError(400, 'INVALID_VALIDITY', 'valid_to < valid_from');
    await sequelize.query('UPDATE workday_config_defaults SET valid_to=?, updated_by=? WHERE id=?', { replacements: [to, actorId ?? null, id], transaction: t });
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

/** Aplicación masiva (gateada). Sólo aplica si el preview no tiene conflictos. */
async function bulkApply(items, actorId) {
  assertWriteEnabled();
  const preview = await bulkPreview(items);
  const blocking = preview.results.filter(r => r.status === 'invalid' || r.status === 'overlap');
  if (blocking.length) throw httpError(409, 'BULK_HAS_CONFLICTS', `preview con ${blocking.length} conflicto(s); resolver antes de aplicar`);
  const created = [];
  for (const raw of items || []) {
    created.push(await createDefault(raw, actorId));
  }
  return { applied: created.length, created };
}

// ─────────────────────────────────────────────────────────────────────
// Resolución EFECTIVA por empleado+fecha (precedencia completa de 6 capas).
// Read-only: no escribe, no recalcula daily_summary.
// ─────────────────────────────────────────────────────────────────────

/**
 * Departamento/empresa del empleado VIGENTES en la fecha (as-of-date) desde
 * employee_assignments (078, con vigencia). Sin asignación dada, cae al
 * department_id ACTUAL de employees, marcado `current_fallback` (para no
 * introducir la deriva retroactiva que el resto del stack evita).
 */
async function resolveEmployeeScope(employeeId, dateISO) {
  const [asg] = await sequelize.query(
    `SELECT department_id, cost_center_id,
            DATE_FORMAT(valid_from,'%Y-%m-%d') AS valid_from,
            DATE_FORMAT(valid_to,'%Y-%m-%d')   AS valid_to
       FROM employee_assignments WHERE employee_id = ? ORDER BY valid_from`,
    { replacements: [employeeId] }
  ).catch(() => [[]]);
  const vig = eff.pickVigente(asg, dateISO);
  let departmentId = vig ? vig.department_id : null;
  let scopeSource = vig ? 'employee_assignments' : null;
  if (departmentId == null) {
    const [er] = await sequelize.query('SELECT department_id FROM employees WHERE id = ?', { replacements: [employeeId] });
    departmentId = er && er[0] ? er[0].department_id : null;
    if (departmentId != null) scopeSource = 'current_fallback';
  }
  let companyId = null;
  const ccId = vig ? vig.cost_center_id : null;
  if (ccId != null) {
    const [cc] = await sequelize.query('SELECT company_id FROM cost_centers WHERE id = ?', { replacements: [ccId] }).catch(() => [[]]);
    companyId = cc && cc[0] ? cc[0].company_id : null;
  }
  return { departmentId, companyId, scopeSource };
}

/** Versión de default vigente en la fecha para un scope_key (o null). */
async function pickDefaultVigente(sk, dateISO) {
  const [rows] = await sequelize.query(
    `SELECT *, DATE_FORMAT(valid_from,'%Y-%m-%d') AS valid_from, DATE_FORMAT(valid_to,'%Y-%m-%d') AS valid_to
       FROM workday_config_defaults WHERE scope_key = ? AND active = 1`,
    { replacements: [sk] }
  ).catch(() => [[]]);
  return eff.pickVigente(rows, dateISO);
}

/**
 * Configuración efectiva de un empleado en una fecha, aplicando la precedencia
 * completa. Devuelve `{ layer, calculation_mode, config, contract_id, scope,
 * precedence }`. Read-only.
 */
async function getEffectiveForDate(employeeId, dateISO) {
  const date = dateISO == null ? '' : String(dateISO).slice(0, 10);
  if (!wc.validDateISO(date)) throw httpError(400, 'INVALID_DATE', 'date (YYYY-MM-DD) requerido');

  // Capas 1–2: turnera publicada + employee_schedule_history (reutiliza forDate).
  let employeeLayer = null;
  try {
    const resolver = await workdayConfig.loadWorkdayConfig([employeeId], { from: date, to: date });
    const fd = resolver.forDate(employeeId, date);
    if (fd) {
      const layer = fd.source === 'schedule_history'
        ? eff.LAYER.EMPLOYEE_HISTORICAL_OVERRIDE
        : eff.LAYER.PUBLISHED_SHIFT_ASSIGNMENT;
      employeeLayer = { config: fd, layer };
    }
  } catch { employeeLayer = null; }

  // Alcance del empleado as-of-date + defaults jerárquicos.
  const scope = await resolveEmployeeScope(employeeId, date);
  const departmentDefault = scope.departmentId != null
    ? await pickDefaultVigente(scopeKey('department', null, scope.departmentId), date) : null;
  const companyDefault = scope.companyId != null
    ? await pickDefaultVigente(scopeKey('company', scope.companyId, null), date) : null;
  const generalDefault = await pickDefaultVigente(scopeKey('general', null, null), date);

  // Capa 5: traza de contrato vigente (identidad).
  const [ct] = await sequelize.query(
    `SELECT id FROM employee_contracts
       WHERE employee_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       ORDER BY start_date DESC LIMIT 1`,
    { replacements: [employeeId, date, date] }
  ).catch(() => [[]]);
  const contractTrace = ct && ct[0] ? { contract_id: ct[0].id } : null;

  const resolved = eff.resolveEffective({ employeeLayer, departmentDefault, companyDefault, generalDefault, contractTrace });
  return {
    employee_id: employeeId,
    date,
    ...resolved,
    scope: { department_id: scope.departmentId, company_id: scope.companyId, scope_source: scope.scopeSource },
    precedence: eff.PRECEDENCE,
  };
}

module.exports = {
  SCOPES,
  PRECEDENCE: eff.PRECEDENCE,
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
  closeDefault,
  bulkPreview,
  bulkApply,
  resolveEmployeeScope,
  getEffectiveForDate,
};
