'use strict';

/**
 * faseEConsoleService.js — Motor de la CONSOLA DE ACTIVACIÓN GUIADA de FASE E.
 *
 * La ruta /api/fase-e pone la DOBLE COMPUERTA (RBAC super_admin + master-flag).
 * Este servicio pone la matemática, el GO/NO-GO exigido, la EXCLUSIÓN MUTUA con
 * PROPIEDAD (lock con token + lease + heartbeat), el BACKUP ATÓMICO, el RESTORE
 * RECUPERABLE y la PARIDAD EXACTA dry-run/apply (plan_digest + PLAN_CHANGED).
 *
 * NO conoce ATT2000. NO escribe attendance_logs. Reutiliza el ÚNICO escritor del
 * motor (workdaySummaryService) — no duplica matemática de jornada. Las
 * MIGRACIONES ya NO se aplican desde HTTP: son un paso de OPS separado
 * (scripts/ops-migrate.sh), con un usuario admin por socket.
 *
 * Correcciones de la 2ª auditoría (P1-A..F, migraciones, P2) documentadas en
 * línea con la etiqueta [Pn-x].
 */

const crypto = require('crypto');
const { sequelize } = require('../config/database');
const workdaySummary = require('./workdaySummaryService');
// [B1] La consola comparte con el writer operativo EL MISMO lock por fecha
// (GET_LOCK 'sishoras:recalc:<fecha>'), para que la re-lectura del estado previo,
// el backup y la escritura sean atómicos frente al escritor operativo.
const { keyFor: recalcKeyFor } = require('./recalcLock');

const REQUIRED_MIGRATIONS = [
  '072_employee_schedule_history.sql',
  '073_workday_profile_and_overlap_guard.sql',
  '074_daily_summary_status_unknown.sql',
  '075_workday_configuration_phase_c.sql',
];
const CONSOLE_MIGRATION = '083_fase_e_activation_console.sql';

const MAX_RANGE_DAYS = 366;      // cota dura del recálculo/impacto
const EMP_CHUNK = 500;           // lote de empleados por consulta
// filas por INSERT de respaldo. Configurable (entero >= 1) SÓLO para poder forzar
// múltiples chunks reales con pocos datos en los tests de integración; el default
// de producción es 200.
const BACKUP_CHUNK = Math.max(1, Math.floor(Number(process.env.FASE_E_BACKUP_CHUNK) || 200));
const CONSOLE_LOCK_ID = 1;       // fila única del lock
// [P1-C] duración del lease; el supervisor lo renueva. Configurable (entero >= 1)
// para poder ejercer expiración/heartbeat en segundos en tests de integración.
const LOCK_LEASE_SEC = Math.max(1, Math.floor(Number(process.env.FASE_E_LOCK_LEASE_SEC) || 120));
// [P1-F/B3] versión del digest canónico del plan. Bumpear si cambia la forma del
// canónico (invalida digests viejos → PLAN_CHANGED, que es lo correcto). v3: el
// target es el resultado EFECTIVO del writer (no el crudo del motor) + categoría.
const PLAN_DIGEST_VERSION = 'fase-e-plan/v3';
// [B1] timeout (s) para tomar el lock por fecha compartido con el writer.
const DATE_LOCK_TIMEOUT_S = 10;

// scope_kind admitidos, EXACTOS. Cualquier otro valor se rechaza (nunca "all").
const VALID_SCOPES = new Set(['all', 'department', 'employee']);

// [B5] Barreras deterministas SÓLO para pruebas de integración: puntos donde un
// test puede interponer una acción concurrente (mutar daily_summary, robar el
// lease) de forma reproducible, sin sleeps ni mocks de affectedRows. En
// producción nadie las registra, así que son no-ops (una búsqueda en objeto).
const _hooks = Object.create(null);
async function _hook(name, ctx) { const fn = _hooks[name]; if (fn) await fn(ctx); }
function _setTestHook(name, fn) { _hooks[name] = fn; }
function _clearTestHooks() { for (const k of Object.keys(_hooks)) delete _hooks[k]; }

// Columnas MUTABLES que el escritor del motor puede cambiar (las que respalda y
// restaura el batch, las que el dry-run compara y las que forman el plan_digest).
const MUTABLE_FIELDS = [
  'first_in', 'last_out', 'worked_minutes', 'break_minutes',
  'late_minutes', 'overtime_minutes', 'status', 'notes',
];

// ─── master-flag ─────────────────────────────────────────────────────────
/** Segundo cerrojo de la consola: env master-flag. Sólo 'true' habilita. */
function isActivationEnabled() {
  return process.env.FASE_E_ACTIVATION_ENABLED === 'true';
}

// ─── helpers de fecha (aritmética de pared, sin zona) ───────────────────
/** [P2] Valida una fecha civil REAL, no sólo el patrón: rechaza 2025-02-30. */
function isRealCivilDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function rangeDays(from, to) {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000) + 1;
}
function eachDate(from, to) {
  const out = [];
  let d = from;
  for (let i = 0; i < MAX_RANGE_DAYS && d <= to; i++) {
    out.push(d);
    d = workdaySummary.shiftDate(d, 1);
  }
  return out;
}

function badRequest(message, code = 'BAD_REQUEST') {
  const err = new Error(message); err.status = 400; err.code = code; return err;
}
function conflict(message, code = 'CONFLICT') {
  const err = new Error(message); err.status = 409; err.code = code; return err;
}

// ─── introspección de esquema (SOLO LECTURA) ────────────────────────────
async function tableExists(name) {
  const [rows] = await sequelize.query(
    `SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    { replacements: [name] },
  );
  return Boolean(rows[0]);
}

async function migrationStatus() {
  if (!(await tableExists('schema_migrations'))) {
    return [...REQUIRED_MIGRATIONS, CONSOLE_MIGRATION].map((filename) => ({ filename, recorded: false }));
  }
  const wanted = [...REQUIRED_MIGRATIONS, CONSOLE_MIGRATION];
  const [rows] = await sequelize.query(
    `SELECT filename FROM schema_migrations WHERE filename IN (${wanted.map(() => '?').join(',')})`,
    { replacements: wanted },
  );
  const set = new Set(rows.map((r) => r.filename));
  return wanted.map((filename) => ({ filename, recorded: set.has(filename) }));
}

async function dailyStatusHas074() {
  if (!(await tableExists('daily_summary'))) return false;
  const [rows] = await sequelize.query(
    `SELECT COLUMN_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_summary'
        AND COLUMN_NAME = 'status' LIMIT 1`,
  );
  const type = String(rows[0]?.type || '');
  return type.includes("'non_working'") && type.includes("'unconfigured'");
}

/** [P1] GO/NO-GO real del esquema. `assert` lanza 409 si falta algo. */
async function evalGoNoGo() {
  const migrations = await migrationStatus();
  const engineOk = REQUIRED_MIGRATIONS.every((m) => migrations.find((x) => x.filename === m)?.recorded);
  const consoleOk = Boolean(migrations.find((x) => x.filename === CONSOLE_MIGRATION)?.recorded);
  const has074 = await dailyStatusHas074();
  const backupReady =
    (await tableExists('daily_summary_recalc_batch')) &&
    (await tableExists('daily_summary_backup')) &&
    (await tableExists('fase_e_console_lock'));
  const missing = [];
  if (!engineOk) missing.push('migraciones 072–075 registradas');
  if (!has074) missing.push("ENUM 074 en daily_summary.status ('non_working'/'unconfigured')");
  if (!consoleOk) missing.push('migración de consola 083 registrada');
  if (!backupReady) missing.push('tablas de consola (recalc_batch/backup/console_lock)');
  return { ok: missing.length === 0, engineOk, consoleOk, has074, backupReady, missing };
}
async function assertGoNoGo(context) {
  const g = await evalGoNoGo();
  if (!g.ok) {
    const err = conflict(`GO/NO-GO: esquema incompleto para "${context}". Falta: ${g.missing.join('; ')}.`, 'NO_GO_SCHEMA_INCOMPLETE');
    err.missing = g.missing; throw err;
  }
}

async function getStatus() {
  const historyExists = await tableExists('employee_schedule_history');
  const migrations = await migrationStatus();
  const g = await evalGoNoGo();
  let historyRows = null;
  if (historyExists) {
    const [[c]] = await sequelize.query('SELECT COUNT(*) AS n FROM employee_schedule_history');
    historyRows = Number(c?.n || 0);
  }
  const envKillSwitch = workdaySummary.isEngineSummaryWriteEnabled();
  const forwardSetting = await workdaySummary.isForwardSettingEnabled();
  const gates = {
    rbac: 'super_admin',
    master_flag_env: 'FASE_E_ACTIVATION_ENABLED',
    master_flag_enabled: isActivationEnabled(),
    forward_env_kill_switch: envKillSwitch,
    forward_db_setting: forwardSetting,
    forward_effective: envKillSwitch && forwardSetting,
    status_074_env: process.env.WORKDAY_ENGINE_STATUS_074_ENABLED === 'true',
    workday_config_write_env: process.env.WORKDAY_CONFIG_WRITE_ENABLED === 'true',
  };
  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    migrations,
    engine_migrations_applied: g.engineOk,
    console_migration_applied: g.consoleOk,
    daily_summary_status_has_074: g.has074,
    backup_tables_ready: g.backupReady,
    employee_schedule_history: { exists: historyExists, rows: historyRows },
    gates,
    go_no_go: {
      schema_ready: g.ok,
      missing: g.missing,
      forward_ready_to_flip: g.ok && envKillSwitch,
      note: 'El esquema completo es OBLIGATORIO en backend para forward/enable y recalc/apply. '
        + 'Las migraciones se aplican por OPS (fuera de HTTP). La activación real exige master-flag + '
        + 'confirmación tipeada + backup declarado por el operador.',
    },
  };
}

// ─── alcance de empleados [P1-B] ─────────────────────────────────────────
async function resolveEmployeeIds(scopeKind, scopeId) {
  if (!VALID_SCOPES.has(scopeKind)) {
    // Nunca se coacciona a 'all'; "", null, false, 0, undefined → INVALID_SCOPE.
    throw badRequest(
      `scope_kind inválido: ${JSON.stringify(scopeKind)}. Debe ser exactamente "all", "department" o "employee".`,
      'INVALID_SCOPE',
    );
  }
  if (scopeKind === 'employee') {
    const id = Number(scopeId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('scopeId (employee) inválido', 'INVALID_SCOPE_ID');
    return [id];
  }
  if (scopeKind === 'department') {
    const id = Number(scopeId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('scopeId (department) inválido', 'INVALID_SCOPE_ID');
    const [rows] = await sequelize.query('SELECT id FROM employees WHERE department_id = ? ORDER BY id', { replacements: [id] });
    return rows.map((r) => r.id);
  }
  const [rows] = await sequelize.query("SELECT id FROM employees WHERE status = 'active' ORDER BY id");
  return rows.map((r) => r.id);
}

function validateRange(from, to) {
  // [P2] fecha civil REAL (no sólo regex) + orden + cota.
  if (!isRealCivilDate(from) || !isRealCivilDate(to)) {
    throw badRequest('from/to deben ser fechas civiles reales YYYY-MM-DD', 'INVALID_RANGE');
  }
  if (from > to) throw badRequest('from debe ser <= to', 'INVALID_RANGE');
  if (rangeDays(from, to) > MAX_RANGE_DAYS) throw badRequest(`El rango excede el máximo de ${MAX_RANGE_DAYS} días`, 'RANGE_TOO_WIDE');
}


async function loadExistingRows(ids, fromDate, toDate) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += EMP_CHUNK) {
    const chunk = ids.slice(i, i + EMP_CHUNK);
    const [rows] = await sequelize.query(
      `SELECT employee_id, DATE_FORMAT(date,'%Y-%m-%d') AS date,
              DATE_FORMAT(first_in,'%Y-%m-%d %H:%i:%s') AS first_in,
              DATE_FORMAT(last_out,'%Y-%m-%d %H:%i:%s') AS last_out,
              worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes,
              justification, justification_type
         FROM daily_summary
        WHERE employee_id IN (${chunk.map(() => '?').join(',')}) AND date >= ? AND date <= ?`,
      { replacements: [...chunk, fromDate, toDate] },
    );
    for (const r of rows) map.set(`${r.employee_id}|${r.date}`, r);
  }
  return map;
}

/**
 * [B3] Resultado EFECTIVO por celda usando la MISMA función pura del writer.
 * Devuelve la operación efectiva, la categoría (inserted/updated/deleted/
 * unchanged) y el estado EFECTIVO persistido (los 8 campos o null si se borra).
 * Así el preview/digest anuncian exactamente lo que el writer escribirá — nunca un
 * cambio de status que el writer luego preserva por una justificación manual.
 */
function effectiveForCell(engineRow, storedRow) {
  const eff = workdaySummary.effectiveDailySummary(engineRow, storedRow, { reconcileOnly: false });
  const category = workdaySummary.classifyEffective(eff, storedRow);
  let effState = null;
  if (eff.action === 'insert' || eff.action === 'update') effState = eff.row;
  else if (eff.action === 'noop') effState = storedRow ? normalizeStoredForWrite(storedRow) : null;
  // 'delete' → effState = null (la fila deja de existir).
  return { eff, category, effState };
}
/** Normaliza una fila previa a los 8 campos efectivos (para diff/target). */
function normalizeStoredForWrite(storedRow) {
  if (!storedRow) return null;
  return {
    first_in: storedRow.first_in || null, last_out: storedRow.last_out || null,
    worked_minutes: Number(storedRow.worked_minutes || 0), break_minutes: Number(storedRow.break_minutes || 0),
    overtime_minutes: Number(storedRow.overtime_minutes || 0), late_minutes: Number(storedRow.late_minutes || 0),
    notes: storedRow.notes || null, status: storedRow.status || null,
  };
}
/** Los 8 campos efectivos como array ordenado (para el target del digest). */
function effStateArray(effState) {
  if (!effState) return null;
  return WRITE_ORDER.map((f) => effState[f] ?? null);
}
const WRITE_ORDER = ['first_in', 'last_out', 'worked_minutes', 'break_minutes', 'overtime_minutes', 'late_minutes', 'notes', 'status'];

/**
 * [P1-F] Construye el PLAN FINAL por celda con semántica LAST-WRITE-WINS.
 * El escritor por fecha toca {d-1, d}, así que una celda puede computarse en dos
 * ventanas (como primaria de X y como d-1 de X+1). Iterando las fechas en orden
 * ascendente, la ÚLTIMA computación gana. Devuelve el plan (Map celda→{ row engine,
 * eff, category, effState }), las filas previas existentes y las celdas con su
 * diff/outsideRange para el reporte. NO escribe. Conserva la FILA ENGINE completa
 * y el RESULTADO EFECTIVO (para digest/preview idénticos a la escritura).
 */
async function buildPlan(ids, from, to) {
  const spanFrom = workdaySummary.shiftDate(from, -1);
  const existing = await loadExistingRows(ids, spanFrom, to);
  const plan = new Map();       // key → { row (engine) }
  for (const d of eachDate(from, to)) {
    const { rowsByEmployee } = await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: false });
    for (const [emp, rows] of rowsByEmployee) {
      for (const row of rows) {
        plan.set(`${emp}|${row.date}`, { row }); // overwrite = last-write-wins
      }
    }
  }
  // Resuelve el efecto EFECTIVO por celda contra el estado previo del snapshot.
  for (const [key, entry] of plan) {
    const stored = existing.get(key) || null;
    const { eff, category, effState } = effectiveForCell(entry.row, stored);
    entry.eff = eff; entry.category = category; entry.effState = effState;
  }
  const cells = [];
  for (const [key, entry] of plan) {
    const [empStr, date] = key.split('|');
    const stored = existing.get(key);
    const prev = normalizeStoredForWrite(stored);
    // changed_fields = diferencia entre el estado EFECTIVO y el previo.
    let changed;
    if (entry.eff.action === 'delete') changed = prev ? WRITE_ORDER.slice() : [];
    else if (!prev) changed = entry.effState ? WRITE_ORDER.slice() : [];
    else changed = WRITE_ORDER.filter((f) => (entry.effState?.[f] ?? null) !== (prev[f] ?? null));
    cells.push({
      emp: Number(empStr), date,
      existed: stored ? 1 : 0,
      category: entry.category,
      differs: entry.category !== 'unchanged',
      changed,
      outsideRange: date < from || date > to,
    });
  }
  return { plan, existing, cells };
}

/**
 * [B1] Agrupa las celdas del plan por FECHA (todas las empleados de esa fecha),
 * en orden ascendente. El apply toma el lock de cada fecha (compartido con el
 * writer operativo) y procesa todas sus celdas bajo ese lock.
 */
function planCellsByDate(plan, existing) {
  const byDate = new Map();
  for (const [key, entry] of plan) {
    const [empStr, date] = key.split('|');
    const arr = byDate.get(date) || [];
    arr.push({ emp: Number(empStr), date, engineRow: entry.row, digestedStored: existing.get(key) || null });
    byDate.set(date, arr);
  }
  return new Map([...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * [P1-F/B3] Representación CANÓNICA y VERSIONADA del plan. Cubre: versión, rango,
 * scope, empleados, y por celda: clave, existencia, estado PREVIO (8 campos +
 * justificación), estado OBJETIVO EFECTIVO (lo que el writer persistirá, o null si
 * borra), categoría, workday_count. El digest cambia (→ PLAN_CHANGED) si driftean
 * asistencia/config (cambia el efectivo), el estado previo de daily_summary
 * (incluida la justificación) o el alcance.
 */
function canonicalPlan({ from, to, scopeKind, scopeId, ids, plan, existing }) {
  const cells = [...plan.keys()].sort().map((key) => {
    const entry = plan.get(key);
    const stored = existing.get(key);
    const prev = normalizeStoredForWrite(stored);
    return {
      k: key,
      existed: existing.has(key) ? 1 : 0,
      wc: Number(entry.row.workday_count || 0),
      cat: entry.category,
      prev: prev ? WRITE_ORDER.map((f) => prev[f] ?? null) : null,
      // Justificación previa: el estado efectivo depende de ella, así que un
      // cambio de justificación tras el preview también dispara PLAN_CHANGED.
      just: stored ? [stored.justification_type ?? null, stored.justification != null ? 1 : 0] : null,
      // Estado OBJETIVO EFECTIVO (lo que el writer escribirá), no el crudo del motor.
      target: effStateArray(entry.effState),
    };
  });
  return {
    v: PLAN_DIGEST_VERSION,
    range: { from, to },
    scope: { kind: scopeKind, id: scopeId ?? null },
    employees: [...new Set((ids || []).map(Number))].sort((a, b) => a - b),
    cells,
  };
}

/** [P1-F] Huella estable del plan (sha256 sobre el JSON canónico versionado). */
function planDigest(canon) {
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/**
 * Impacto dry-run: mismas celdas que recalcApply (spillover [from-1]), diff de
 * los 8 campos mutables, fechas fuera de rango, y el plan_digest que recalcApply
 * exigirá para garantizar paridad exacta.
 */
async function getImpact({ from, to, scopeKind, scopeId = null, maxExamples = 50 }) {
  validateRange(from, to);
  const ids = await resolveEmployeeIds(scopeKind, scopeId);
  const report = {
    read_only: true, period: { from, to }, scope: { kind: scopeKind, id: scopeId ?? null },
    employees: ids.length, cells_evaluated: 0, rows_differ: 0, rows_new: 0,
    rows_differ_outside_range: 0, dates_outside_range: [], plan_digest: null, examples: [],
  };
  if (!ids.length) {
    report.plan_digest = planDigest(canonicalPlan({ from, to, scopeKind, scopeId, ids, plan: new Map(), existing: new Map() }));
    return report;
  }
  const { plan, existing, cells } = await buildPlan(ids, from, to);
  report.plan_digest = planDigest(canonicalPlan({ from, to, scopeKind, scopeId, ids, plan, existing }));
  const outside = new Set();
  for (const c of cells) {
    report.cells_evaluated++;
    if (c.outsideRange) outside.add(c.date);
    if (c.differs) {
      // 'differs' = el resultado EFECTIVO muta el estado previo (no un diff crudo
      // del motor que el writer luego preservaría).
      report.rows_differ++;
      if (c.category === 'inserted') report.rows_new++;
      if (c.outsideRange) report.rows_differ_outside_range++;
      if (report.examples.length < maxExamples) {
        report.examples.push({
          employee_id: c.emp, date: c.date, outside_requested_range: c.outsideRange,
          existed: c.existed, category: c.category, changed_fields: c.changed,
        });
      }
    }
  }
  report.dates_outside_range = [...outside].sort();
  return report;
}

// ─── lock con PROPIEDAD (token + lease + heartbeat) [P1-C] ───────────────
/** Toma el lock. Genera un token propio; sólo quien tiene el token libera/renueva. */
async function acquireConsoleLock(operation, userId) {
  const token = crypto.randomUUID();
  const [res] = await sequelize.query(
    `UPDATE fase_e_console_lock
        SET lock_token = ?, operation = ?, held_by = ?, acquired_at = NOW(),
            lease_expires_at = (NOW() + INTERVAL ${LOCK_LEASE_SEC} SECOND)
      WHERE id = ?
        AND (lock_token IS NULL OR lease_expires_at < NOW())`,
    { replacements: [token, operation, userId ?? null, CONSOLE_LOCK_ID] },
  );
  const affected = (res && (res.affectedRows ?? res.rowCount)) || 0;
  if (!affected) throw conflict('Otra operación de consola FASE E (recalc/restore) está en curso.', 'CONSOLE_BUSY');
  return token;
}
/**
 * Renueva el lease. Distingue MATCHED de LOST de forma robusta [P1-C]:
 * el UPDATE SIEMPRE incrementa `heartbeat_seq`, así que la fila CAMBIA cuando el
 * WHERE machea (somos dueños) → affectedRows>=1; y es 0 sólo si el token ya no es
 * el nuestro (lease vencido y robado). Esto evita el falso LOCK_LOST cuando el
 * heartbeat cae en el MISMO segundo (lease_expires_at idéntico daría 0 filas
 * "cambiadas" con sólo tocar la fecha). affectedRows=0 → LOCK_LOST.
 */
async function heartbeatConsoleLock(token) {
  const [res] = await sequelize.query(
    `UPDATE fase_e_console_lock
        SET lease_expires_at = (NOW() + INTERVAL ${LOCK_LEASE_SEC} SECOND),
            heartbeat_seq = heartbeat_seq + 1
      WHERE id = ? AND lock_token = ?`,
    { replacements: [CONSOLE_LOCK_ID, token] },
  );
  const affected = (res && (res.affectedRows ?? res.rowCount)) || 0;
  if (!affected) throw conflict('El lock de consola se perdió (lease vencido y reasignado). Operación abortada.', 'LOCK_LOST');
}
/** Libera SÓLO si somos dueños del token: una operación vieja no libera otra. */
async function releaseConsoleLock(token) {
  await sequelize.query(
    `UPDATE fase_e_console_lock
        SET lock_token = NULL, operation = NULL, held_by = NULL, lease_expires_at = NULL
      WHERE id = ? AND lock_token = ?`,
    { replacements: [CONSOLE_LOCK_ID, token] },
  );
}

/**
 * [P1-C] SUPERVISOR de lease: renueva el lock en segundo plano cada TTL/3 (como
 * máximo), desde inmediatamente después del acquire hasta el `finally`, cubriendo
 * TODA la operación (buildPlan, backup, apply/restore). Si el heartbeat detecta
 * LOCK_LOST (token robado tras vencer el lease), el supervisor:
 *   · marca la pérdida y DEJA DE RENOVAR (no vuelve a tocar la fila del nuevo dueño);
 *   · guarda el error para que el hilo principal lo observe con assertAlive() y
 *     ABORTE antes de cualquier escritura nueva.
 * Un fallo TRANSITORIO del heartbeat (no LOCK_LOST) no se interpreta como pérdida:
 * se saltea ese tick y se reintenta en el siguiente (el lease aún tiene margen);
 * si la base sigue caída, el lease vence, otro roba el lock y el próximo heartbeat
 * devuelve 0 → LOCK_LOST real.
 */
function startLeaseSupervisor(token) {
  const intervalMs = Math.max(250, Math.floor((LOCK_LEASE_SEC * 1000) / 3));
  let lost = false;
  let lostError = null;
  let stopped = false;
  let timer = null;

  const schedule = () => {
    if (stopped || lost) return;
    timer = setTimeout(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // no mantener vivo el proceso
  };
  const tick = async () => {
    if (stopped || lost) return;
    try {
      await heartbeatConsoleLock(token);
    } catch (e) {
      if (e && e.code === 'LOCK_LOST') { lost = true; lostError = e; return; } // no reprogramar
      // transitorio: no declarar pérdida; reintentar en el próximo tick.
    }
    schedule();
  };
  schedule();

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    isLost() { return lost; },
    /** Lanza LOCK_LOST si el lease se perdió. Se llama ANTES de cada escritura. */
    assertAlive() { if (lost) throw lostError || conflict('El lock de consola se perdió.', 'LOCK_LOST'); },
  };
}

async function assertNoOverlap(from, to) {
  const spanFrom = workdaySummary.shiftDate(from, -1);
  const [rows] = await sequelize.query(
    `SELECT batch_id, status, DATE_FORMAT(from_date,'%Y-%m-%d') AS from_date, DATE_FORMAT(to_date,'%Y-%m-%d') AS to_date
       FROM daily_summary_recalc_batch
      WHERE status <> 'restored'
        AND DATE_SUB(from_date, INTERVAL 1 DAY) <= ? AND to_date >= ? LIMIT 1`,
    { replacements: [to, spanFrom] },
  );
  if (rows.length) {
    const b = rows[0];
    throw conflict(
      `El rango se superpone con el lote ${b.batch_id} (${b.from_date}→${b.to_date}, estado ${b.status}), no restaurado.`,
      'RANGE_OVERLAP',
    );
  }
}

// ─── activación hacia adelante (reversible) ──────────────────────────────
async function setForwardEnabled(enabled) {
  if (enabled) await assertGoNoGo('forward/enable'); // disable NO se gatea (P2)
  await sequelize.query(
    `INSERT INTO system_settings (key_name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    { replacements: [workdaySummary.FORWARD_SETTING_KEY, enabled ? 'true' : 'false'] },
  );
  return {
    forward_db_setting: enabled,
    forward_env_kill_switch: workdaySummary.isEngineSummaryWriteEnabled(),
    forward_effective: enabled && workdaySummary.isEngineSummaryWriteEnabled(),
  };
}

// ─── [B2] fencing DB-side del lease ──────────────────────────────────────
/**
 * Verificación DB-SIDE del token vigente. Corre en una conexión APARTE (sin la
 * transacción del apply/restore) para ver el ÚLTIMO valor committeado de
 * lock_token: así detecta un robo del lease aunque nuestra transacción esté en
 * REPEATABLE READ. Se llama INMEDIATAMENTE antes de cada escritura y antes de la
 * marca final; si el token ya no es el nuestro → LOCK_LOST (la transacción activa
 * hace rollback). No depende del flag JS del supervisor.
 */
async function assertLeaseHeldDb(token) {
  const [rows] = await sequelize.query('SELECT lock_token FROM fase_e_console_lock WHERE id = ?', { replacements: [CONSOLE_LOCK_ID] });
  if (!rows[0] || rows[0].lock_token !== token) {
    throw conflict('El lock de consola se perdió (token vigente distinto). Escritura abortada.', 'LOCK_LOST');
  }
}

// ─── [B1] lock por FECHA compartido con el writer operativo ──────────────
async function acquireDateLock(t, date) {
  const [rows] = await sequelize.query('SELECT GET_LOCK(?, ?) AS ok', { replacements: [recalcKeyFor(date), DATE_LOCK_TIMEOUT_S], transaction: t });
  const ok = Array.isArray(rows) && rows[0] ? rows[0].ok : null;
  if (Number(ok) !== 1) throw conflict(`No se pudo tomar el lock de la fecha ${date} (GET_LOCK=${ok}).`, 'DATE_LOCK_BUSY');
}
async function releaseDateLock(t, date) {
  await sequelize.query('SELECT RELEASE_LOCK(?)', { replacements: [recalcKeyFor(date)], transaction: t }).catch(() => {});
}

/** Compara dos estados previos (8 campos + justificación + existencia). */
const PREV_CMP_FIELDS = ['first_in', 'last_out', 'worked_minutes', 'break_minutes', 'overtime_minutes', 'late_minutes', 'notes', 'status'];
function sameStoredState(a, b) {
  const na = normalizeStoredForWrite(a);
  const nb = normalizeStoredForWrite(b);
  if (!na && !nb) return true;
  if (!na || !nb) return false;
  if (!PREV_CMP_FIELDS.every((f) => (na[f] ?? null) === (nb[f] ?? null))) return false;
  // justificación (de la que depende el estado efectivo)
  const ja = [a.justification_type ?? null, a.justification != null ? 1 : 0];
  const jb = [b.justification_type ?? null, b.justification != null ? 1 : 0];
  return ja[0] === jb[0] && ja[1] === jb[1];
}

// ─── recálculo histórico acotado, REVERSIBLE ─────────────────────────────
/**
 * Secuencia fail-safe [B1/B2/B3/P1-*]:
 *   0. validación + GO/NO-GO + scope estricto + lock(token) + SUPERVISOR de lease;
 *   1. buildPlan (motor apply:false = LECTURA) + digest CANÓNICO versionado; drift
 *      vs el dry-run → PLAN_CHANGED (antes de tocar la base);
 *   2. UNA SOLA TRANSACCIÓN todo-o-nada. Por FECHA (orden ascendente): se toma el
 *      GET_LOCK de la fecha COMPARTIDO con el writer operativo; por cada celda,
 *      bajo el lock: fence DB-side del lease → RE-LECTURA `FOR UPDATE` del estado
 *      previo (última versión committeada) → VERIFICACIÓN vs el prev digestado
 *      (drift → PLAN_CHANGED) → BACKUP de ESE prev validado → escritura EFECTIVA
 *      (misma función pura del writer) → conteo por categoría. El backup y la
 *      escritura de una celda ocurren consecutivos bajo el mismo lock+row-lock: el
 *      prev validado es EXACTAMENTE el respaldado y el sobrescrito, sin ventana.
 *   3. fence final + header 'applied' con conteos → commit. Cualquier fallo (drift,
 *      lease perdido, error) → ROLLBACK TOTAL: no hay header, ni backup, ni
 *      escrituras; daily_summary intacto y el rango libre (estado recuperable).
 */
async function recalcApply({ from, to, scopeKind, scopeId = null, userId = null, planDigestExpected = null }) {
  validateRange(from, to);
  await assertGoNoGo('recalc/apply');
  // [P1-B] scope estricto ANTES de tomar lock o escribir.
  const ids = await resolveEmployeeIds(scopeKind, scopeId);
  if (!ids.length) {
    return { batch_id: null, status: 'noop', employees: 0, rows_backed_up: 0, rows_written: 0, cells_processed: 0, rows_inserted: 0, rows_updated: 0, rows_deleted: 0, rows_unchanged: 0, note: 'Sin empleados en alcance' };
  }
  // [P1-F] el digest del dry-run es OBLIGATORIO (se exige antes de tomar el lock).
  if (!planDigestExpected) throw badRequest('Falta plan_digest del dry-run previo.', 'PLAN_DIGEST_REQUIRED');

  const token = await acquireConsoleLock('recalc', userId);
  const lease = startLeaseSupervisor(token); // [P1-C] renovación en 2º plano
  const batchId = crypto.randomUUID();
  try {
    await assertNoOverlap(from, to);

    // 1. plan (una sola vez) + digest canónico (paridad exacta con el dry-run).
    const { plan, existing, cells } = await buildPlan(ids, from, to);
    const digest = planDigest(canonicalPlan({ from, to, scopeKind, scopeId, ids, plan, existing }));
    if (planDigestExpected !== digest) {
      throw conflict('El plan cambió desde el dry-run (asistencia/config o el estado previo de daily_summary difieren). Volvé a previsualizar.', 'PLAN_CHANGED');
    }
    lease.assertAlive();
    await assertLeaseHeldDb(token); // fence antes de entrar a la transacción de escritura
    // [B5] barrera determinista: permite a un test mutar daily_summary EXACTAMENTE
    // tras validar el digest y antes de backup/write (la re-lectura FOR UPDATE bajo
    // el lock lo detectará → PLAN_CHANGED). Inerte en producción.
    await _hook('afterDigest', { from, to });

    const counts = { cells_processed: 0, rows_backed_up: 0, rows_inserted: 0, rows_updated: 0, rows_deleted: 0, rows_unchanged: 0 };
    const cellsByDate = planCellsByDate(plan, existing);

    // 2. UNA transacción todo-o-nada.
    await sequelize.transaction(async (t) => {
      for (const [date, dateCells] of cellsByDate) {
        await acquireDateLock(t, date); // lock compartido con el writer operativo
        try {
          for (const cell of dateCells) {
            // fence DB-side del lease antes de leer/respaldar la celda.
            lease.assertAlive();
            await assertLeaseHeldDb(token);
            // re-lectura FOR UPDATE (última committeada) + verificación bajo el lock.
            const current = await workdaySummary.readDailySummaryRow(t, cell.emp, date);
            if (!sameStoredState(current, cell.digestedStored)) {
              throw conflict('El estado previo de daily_summary cambió bajo el lock desde el dry-run. Volvé a previsualizar.', 'PLAN_CHANGED');
            }
            // BACKUP del prev EXACTO validado (== current == digestado) + lo aplicado.
            const eff = workdaySummary.effectiveDailySummary(cell.engineRow, current, { reconcileOnly: false });
            const category = workdaySummary.classifyEffective(eff, current);
            const appliedState = (eff.action === 'insert' || eff.action === 'update') ? eff.row : null;
            await backupOneCell(t, batchId, cell.emp, date, current, appliedState);
            counts.rows_backed_up++;
            // [B5] barrera entre backup y write (la fila está FOR-UPDATE-lockeada).
            await _hook('beforeCellWrite', { emp: cell.emp, date });
            // [B2] fence DB-side INMEDIATAMENTE antes de la escritura efectiva.
            lease.assertAlive();
            await assertLeaseHeldDb(token);
            await workdaySummary.applyEffectiveWrite(t, cell.emp, date, eff);
            counts.cells_processed++;
            counts[`rows_${category}`]++;
          }
        } finally {
          await releaseDateLock(t, date);
        }
      }
      // fence final antes de persistir el header 'applied'.
      lease.assertAlive();
      await assertLeaseHeldDb(token);
      const rowsWritten = counts.rows_inserted + counts.rows_updated + counts.rows_deleted;
      await sequelize.query(
        `INSERT INTO daily_summary_recalc_batch
           (batch_id, from_date, to_date, scope_kind, scope_id, status, employees, rows_backed_up,
            cells_processed, rows_inserted, rows_updated, rows_deleted, rows_unchanged, rows_written, plan_digest, created_by)
         VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [batchId, from, to, scopeKind, scopeId ?? null, ids.length, counts.rows_backed_up,
          counts.cells_processed, counts.rows_inserted, counts.rows_updated, counts.rows_deleted, counts.rows_unchanged, rowsWritten, digest, userId ?? null], transaction: t },
      );
    });

    return {
      batch_id: batchId, status: 'applied', period: { from, to },
      scope: { kind: scopeKind, id: scopeId ?? null }, employees: ids.length,
      rows_backed_up: counts.rows_backed_up,
      cells_processed: counts.cells_processed,
      rows_inserted: counts.rows_inserted, rows_updated: counts.rows_updated,
      rows_deleted: counts.rows_deleted, rows_unchanged: counts.rows_unchanged,
      rows_written: counts.rows_inserted + counts.rows_updated + counts.rows_deleted,
      plan_digest: digest,
      dates_outside_range: [...new Set(cells.filter((c) => c.outsideRange).map((c) => c.date))].sort(),
      backup_confirmation: 'operator_declared',
    };
  } finally {
    lease.stop();               // [P1-C] cerrar el supervisor limpiamente
    await releaseConsoleLock(token); // sólo libera NUESTRO token: nunca el del nuevo dueño
  }
}

/** [B1] Respalda UNA celda (prev validado bajo el lock) dentro de la transacción. */
async function backupOneCell(t, batchId, emp, date, current, appliedState) {
  await sequelize.query(
    `INSERT INTO daily_summary_backup
       (batch_id, employee_id, date, existed, first_in, last_out, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes, row_json, applied_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [
      batchId, emp, date, current ? 1 : 0,
      current?.first_in ?? null, current?.last_out ?? null,
      current?.worked_minutes ?? null, current?.break_minutes ?? null,
      current?.late_minutes ?? null, current?.overtime_minutes ?? null,
      current?.status ?? null, current?.notes ?? null,
      current ? JSON.stringify(current) : null,
      appliedState ? JSON.stringify(appliedState) : null,
    ], transaction: t },
  );
}

/** ¿La fila actual sigue siendo lo que ESTE lote aplicó? (para no pisar un cambio
 *  legítimo concurrente posterior al apply). `appliedJson` = 8 campos que escribimos
 *  (o null = la habíamos borrado / no dejamos fila). */
function currentMatchesApplied(current, appliedJson) {
  const cur = normalizeStoredForWrite(current);
  if (appliedJson == null) return cur == null; // esperábamos SIN fila
  if (!cur) return false;                        // esperábamos una fila y no está
  return WRITE_ORDER.every((f) => (cur[f] ?? null) === (appliedJson[f] ?? null));
}

/**
 * RESTORE por batch_id, RECUPERABLE y SEGURO [B1/B2/P1-E].
 *   · Exclusión mutua (console lock con token) + SUPERVISOR de lease.
 *   · Verifica COUNT(backup)==rows_backed_up antes de tocar nada.
 *   · UNA SOLA TRANSACCIÓN todo-o-nada. Por FECHA: GET_LOCK compartido con el
 *     writer; por celda, bajo el lock: fence DB-side del lease → RE-LECTURA
 *     FOR UPDATE. Si la celda YA NO tiene lo que este lote aplicó (cambio legítimo
 *     concurrente), se SALTA (no se pisa) y se cuenta como skipped; si no, se repone
 *     el estado previo respaldado (upsert) o se borra (existed=0).
 *   · La marca 'restored'/restored_at ocurre dentro de la misma transacción. Un
 *     fallo (incl. pérdida del lease) → ROLLBACK TOTAL: daily_summary y el lote
 *     intactos (restaurable) → REINTENTABLE, nunca bloqueado en 'restoring'.
 */
async function restoreBatch({ batchId, userId = null }) {
  const token = await acquireConsoleLock('restore', userId);
  const lease = startLeaseSupervisor(token);
  try {
    const [[batch]] = await sequelize.query(
      'SELECT batch_id, status, rows_backed_up FROM daily_summary_recalc_batch WHERE batch_id = ? LIMIT 1',
      { replacements: [batchId] },
    );
    if (!batch) throw badRequest('batch_id inexistente', 'BATCH_NOT_FOUND');
    if (batch.status === 'restored') throw conflict('El lote ya fue restaurado', 'BATCH_ALREADY_RESTORED');
    if (!['applied', 'failed'].includes(batch.status)) throw conflict(`No se puede restaurar un lote en estado "${batch.status}"`, 'BATCH_NOT_RESTORABLE');

    const [[cnt]] = await sequelize.query('SELECT COUNT(*) AS n FROM daily_summary_backup WHERE batch_id = ?', { replacements: [batchId] });
    const actual = Number(cnt?.n || 0);
    if (actual !== Number(batch.rows_backed_up)) {
      throw conflict(`Respaldo incompleto: ${actual} vs ${batch.rows_backed_up} registradas. No se restaura.`, 'BACKUP_COUNT_MISMATCH');
    }

    const [rows] = await sequelize.query(
      `SELECT employee_id, DATE_FORMAT(date,'%Y-%m-%d') AS date, existed,
              DATE_FORMAT(first_in,'%Y-%m-%d %H:%i:%s') AS first_in,
              DATE_FORMAT(last_out,'%Y-%m-%d %H:%i:%s') AS last_out,
              worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes, applied_json
         FROM daily_summary_backup WHERE batch_id = ? ORDER BY date`,
      { replacements: [batchId] },
    );
    // agrupar por fecha para tomar el lock compartido por fecha.
    const byDate = new Map();
    for (const b of rows) { const a = byDate.get(b.date) || []; a.push(b); byDate.set(b.date, a); }

    const counts = { rows_restored: 0, rows_deleted: 0, rows_skipped: 0 };
    await sequelize.transaction(async (t) => {
      for (const [date, dateRows] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        await acquireDateLock(t, date);
        try {
          for (const b of dateRows) {
            lease.assertAlive();
            await assertLeaseHeldDb(token);
            const current = await workdaySummary.readDailySummaryRow(t, b.employee_id, date);
            const applied = typeof b.applied_json === 'string' ? JSON.parse(b.applied_json) : b.applied_json;
            if (!currentMatchesApplied(current, applied)) { counts.rows_skipped++; continue; } // cambio concurrente → no pisar
            // [B5] barrera + [B2] fence DB-side INMEDIATAMENTE antes de la escritura.
            await _hook('restoreBeforeCellWrite', { emp: b.employee_id, date });
            lease.assertAlive();
            await assertLeaseHeldDb(token);
            if (b.existed) {
              await sequelize.query(
                `INSERT INTO daily_summary (employee_id, date, first_in, last_out, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE first_in = VALUES(first_in), last_out = VALUES(last_out),
                   worked_minutes = VALUES(worked_minutes), break_minutes = VALUES(break_minutes),
                   late_minutes = VALUES(late_minutes), overtime_minutes = VALUES(overtime_minutes),
                   status = VALUES(status), notes = VALUES(notes)`,
                { replacements: [b.employee_id, date, b.first_in, b.last_out, b.worked_minutes, b.break_minutes, b.late_minutes, b.overtime_minutes, b.status, b.notes], transaction: t },
              );
              counts.rows_restored++;
            } else {
              await sequelize.query('DELETE FROM daily_summary WHERE employee_id = ? AND date = ?', { replacements: [b.employee_id, date], transaction: t });
              counts.rows_deleted++;
            }
          }
        } finally {
          await releaseDateLock(t, date);
        }
      }
      lease.assertAlive();
      await assertLeaseHeldDb(token);
      await sequelize.query(
        "UPDATE daily_summary_recalc_batch SET status = 'restored', restored_by = ?, restored_at = NOW() WHERE batch_id = ?",
        { replacements: [userId ?? null, batchId], transaction: t },
      );
    });
    return { batch_id: batchId, status: 'restored', rows_restored: counts.rows_restored, rows_deleted: counts.rows_deleted, rows_skipped: counts.rows_skipped };
  } finally {
    lease.stop();
    await releaseConsoleLock(token);
  }
}

async function listBatches({ limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await sequelize.query(
    `SELECT batch_id, DATE_FORMAT(from_date,'%Y-%m-%d') AS from_date, DATE_FORMAT(to_date,'%Y-%m-%d') AS to_date,
            scope_kind, scope_id, status, employees, rows_backed_up,
            cells_processed, rows_inserted, rows_updated, rows_deleted, rows_unchanged, rows_written, plan_digest,
            created_by, created_at, restored_by, restored_at
       FROM daily_summary_recalc_batch ORDER BY created_at DESC LIMIT ${lim}`,
  );
  return rows;
}

module.exports = {
  isActivationEnabled,
  getStatus,
  getImpact,
  setForwardEnabled,
  recalcApply,
  restoreBatch,
  listBatches,
  // exportados para pruebas / referencia
  evalGoNoGo, assertGoNoGo, buildPlan, planDigest, canonicalPlan, planCellsByDate,
  effectiveForCell, normalizeStoredForWrite, sameStoredState, currentMatchesApplied, isRealCivilDate,
  acquireConsoleLock, heartbeatConsoleLock, releaseConsoleLock, startLeaseSupervisor, assertLeaseHeldDb,
  MAX_RANGE_DAYS, LOCK_LEASE_SEC, BACKUP_CHUNK, PLAN_DIGEST_VERSION, DATE_LOCK_TIMEOUT_S,
  REQUIRED_MIGRATIONS, CONSOLE_MIGRATION, VALID_SCOPES, MUTABLE_FIELDS, WRITE_ORDER,
  // [B5] barreras deterministas SÓLO para IT (inertes en producción).
  _setTestHook, _clearTestHooks,
};
