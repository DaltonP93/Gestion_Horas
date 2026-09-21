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

/** Nombre de lock determinista por alcance: todo cambio del MISMO scope compite acá. */
function lockNameForScope(scopeKeyStr) {
  return `sishoras:wcd:${scopeKeyStr}`.slice(0, 64);
}

async function acquireLock(t, lockName) {
  const [rows] = await sequelize.query('SELECT GET_LOCK(?, 10) AS ok', { replacements: [lockName], transaction: t });
  const ok = Array.isArray(rows) && rows[0] ? rows[0].ok : null;
  if (Number(ok) !== 1) throw httpError(409, 'WORKDAY_CONFIG_LOCK_TIMEOUT', 'no se pudo obtener el lock');
}

/**
 * Ejecuta `fn(t)` bajo el lock del alcance `scopeKeyStr` en su propia
 * transacción. Create/update/close del MISMO alcance usan esta misma identidad
 * de lock (Corrección D): nunca compiten por locks distintos.
 */
async function withScopeLock(scopeKeyStr, fn) {
  const { result } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    const lockName = lockNameForScope(scopeKeyStr);
    await acquireLock(t, lockName);
    try { return await fn(t); }
    finally { await sequelize.query('SELECT RELEASE_LOCK(?)', { replacements: [lockName], transaction: t }); }
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

async function updateDefault(id, body, actorId) {
  assertWriteEnabled();
  // Se bloquea el ALCANCE REAL de la fila (leído antes; el alcance es inmutable),
  // no el que venga en el body: así update compite por el MISMO lock que
  // create/close del mismo scope (Corrección D). Nunca bloquea general por omisión.
  const sk = await readScopeKeyById(id);
  if (!sk) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
  return withScopeLock(sk, async (t) => {
    const before = await readDefault(t, id);
    if (!before) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
    // El alcance de un default NO se muda; se corrige su vigencia/payload.
    const merged = { ...before, ...body, scope: before.scope, company_id: before.company_id, department_id: before.department_id };
    const row = normalizeDefaultBody(merged);
    await assertNoOverlapDb(t, { ...row, excludeId: id });
    await sequelize.query(
      `UPDATE workday_config_defaults SET
         ${UPDATE_COLS.map(c => `${c}=?`).join(', ')},
         config_version = config_version + 1, updated_by=?
       WHERE id=?`,
      { replacements: [...UPDATE_COLS.map(c => colValue(row, c)), actorId ?? null, id], transaction: t }
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
  // Mismo lock de alcance que create/update (Corrección D), no `close:<id>`.
  const sk = await readScopeKeyById(id);
  if (!sk) throw httpError(404, 'NOT_FOUND', 'default no encontrado');
  return withScopeLock(sk, async (t) => {
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

  // (4) Locks en orden determinista (scope_keys ordenados).
  const scopeKeysSorted = [...new Set(rows.map(r => r.scope_key))].sort();

  const { result } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    const acquired = [];
    try {
      for (const sk of scopeKeysSorted) { const ln = lockNameForScope(sk); await acquireLock(t, ln); acquired.push(ln); }
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
    } finally {
      for (const ln of acquired.reverse()) await sequelize.query('SELECT RELEASE_LOCK(?)', { replacements: [ln], transaction: t });
    }
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
  closeDefault,
  bulkPreview,
  bulkApply,
  getEffectiveForDate,
};
