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
// [P1-F] versión del digest canónico del plan. Bumpear si cambia la forma del
// canónico (invalida digests viejos → PLAN_CHANGED, que es lo correcto).
const PLAN_DIGEST_VERSION = 'fase-e-plan/v2';

// scope_kind admitidos, EXACTOS. Cualquier otro valor se rechaza (nunca "all").
const VALID_SCOPES = new Set(['all', 'department', 'employee']);

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

// ─── normalización + diff de los 8 campos mutables ───────────────────────
function motorRowNormalized(row) {
  return {
    first_in: row.first_in || null,
    last_out: row.last_out || null,
    worked_minutes: Number(row.worked_minutes || 0),
    break_minutes: Number(row.break_minutes || 0),
    late_minutes: Number(row.late_minutes || 0),
    overtime_minutes: Number(row.overtime_minutes || 0),
    status: workdaySummary.statusParaDb(row.status),
    notes: row.notes || null,
  };
}
function storedRowNormalized(r) {
  if (!r) return null;
  return {
    first_in: r.first_in || null,
    last_out: r.last_out || null,
    worked_minutes: Number(r.worked_minutes || 0),
    break_minutes: Number(r.break_minutes || 0),
    late_minutes: Number(r.late_minutes || 0),
    overtime_minutes: Number(r.overtime_minutes || 0),
    status: r.status || null,
    notes: r.notes || null,
  };
}
function diffMutableFields(motorRow, storedRow) {
  const m = motorRowNormalized(motorRow);
  const s = storedRowNormalized(storedRow);
  if (!s) return { differs: true, changed: MUTABLE_FIELDS.slice() };
  const changed = MUTABLE_FIELDS.filter((f) => (m[f] ?? null) !== (s[f] ?? null));
  return { differs: changed.length > 0, changed };
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
 * [P1-F] Semántica de OPERACIÓN por celda, derivada de la fila engine. Va en el
 * digest para que el plan valide no sólo QUÉ se escribe sino CÓMO:
 *   · reconcile_null → status inconfigurable: el writer BORRA la fila (o preserva
 *     la justificación manual), nunca inserta;
 *   · write_empty    → día sin jornada (workday_count 0): la justificación manual
 *     puede ganar sobre el estado calculado;
 *   · write_worked   → día con jornada real: gana el estado trabajado.
 */
function opForRow(row) {
  const status = workdaySummary.statusParaDb(row.status);
  if (status == null) return 'reconcile_null';
  if ((row.workday_count || 0) === 0) return 'write_empty';
  return 'write_worked';
}

/**
 * [P1-F] Construye el PLAN FINAL por celda con semántica LAST-WRITE-WINS.
 * El escritor por fecha toca {d-1, d}, así que una celda puede computarse en dos
 * ventanas (como primaria de X y como d-1 de X+1). Iterando las fechas en orden
 * ascendente, la ÚLTIMA computación gana — igual que el motor al aplicar en ese
 * mismo orden. Devuelve el plan (Map celda→{ row engine, norm target }), las
 * filas previas existentes y las celdas con su diff/outsideRange para el reporte.
 * NO escribe. Conserva la FILA ENGINE completa (status engine, workday_count,
 * minutos, notas) para que el apply la escriba EXACTAMENTE sin recomputar.
 */
async function buildPlan(ids, from, to) {
  const spanFrom = workdaySummary.shiftDate(from, -1);
  const existing = await loadExistingRows(ids, spanFrom, to);
  const plan = new Map();       // key → { row (engine), norm (target normalizado) }
  for (const d of eachDate(from, to)) {
    const { rowsByEmployee } = await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: false });
    for (const [emp, rows] of rowsByEmployee) {
      for (const row of rows) {
        // overwrite = last-write-wins; se guarda la fila engine cruda + su target.
        plan.set(`${emp}|${row.date}`, { row, norm: motorRowNormalized(row) });
      }
    }
  }
  const cells = [];
  for (const [key, { norm }] of plan) {
    const [empStr, date] = key.split('|');
    const stored = existing.get(key);
    const s = storedRowNormalized(stored);
    const changed = s ? MUTABLE_FIELDS.filter((f) => (norm[f] ?? null) !== (s[f] ?? null)) : MUTABLE_FIELDS.slice();
    cells.push({
      emp: Number(empStr), date,
      existed: stored ? 1 : 0,
      differs: !s || changed.length > 0,
      changed,
      outsideRange: date < from || date > to,
    });
  }
  return { plan, existing, cells };
}

/**
 * [P1-F] Agrupa las filas ENGINE del plan por empleado (ordenadas por fecha) para
 * pasárselas al escritor (applyResolvedRows). Escribir cada celda UNA sola vez con
 * su fila last-write-wins produce el MISMO estado final que el motor al aplicar
 * fecha-por-fecha, sin un segundo recálculo desde datos vivos.
 */
function planRowsByEmployee(plan) {
  const byEmp = new Map();
  for (const [key, { row }] of plan) {
    const emp = Number(key.split('|')[0]);
    const arr = byEmp.get(emp) || [];
    arr.push(row);
    byEmp.set(emp, arr);
  }
  for (const arr of byEmp.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return byEmp;
}

/**
 * [P1-F] Representación CANÓNICA y VERSIONADA del plan. Cubre: versión, rango,
 * scope, empleados en alcance, y por celda: clave, existencia y estado PREVIO,
 * estado OBJETIVO, workday_count y la semántica de operación. Así el digest cambia
 * (→ PLAN_CHANGED) si driftean los datos de asistencia/config (cambia el target),
 * el estado previo de daily_summary (cambia prev/existencia) o el alcance.
 */
function canonicalPlan({ from, to, scopeKind, scopeId, ids, plan, existing }) {
  const cells = [...plan.keys()].sort().map((key) => {
    const { row, norm } = plan.get(key);
    const stored = existing.get(key);
    const prev = storedRowNormalized(stored);
    return {
      k: key,
      existed: existing.has(key) ? 1 : 0,
      wc: Number(row.workday_count || 0),
      op: opForRow(row),
      prev: prev ? MUTABLE_FIELDS.map((f) => prev[f] ?? null) : null,
      // La preservación de justificación del writer hace que el estado escrito
      // dependa de justification/justification_type del estado previo; incluirlos
      // en el digest hace que un cambio de justificación tras el preview también
      // dispare PLAN_CHANGED (no se escribe algo distinto de lo previsualizado).
      just: stored ? [stored.justification_type ?? null, stored.justification != null ? 1 : 0] : null,
      target: MUTABLE_FIELDS.map((f) => norm[f] ?? null),
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
      report.rows_differ++;
      if (!c.existed) report.rows_new++;
      if (c.outsideRange) report.rows_differ_outside_range++;
      if (report.examples.length < maxExamples) {
        report.examples.push({
          employee_id: c.emp, date: c.date, outside_requested_range: c.outsideRange,
          existed: c.existed, changed_fields: c.changed,
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

// ─── recálculo histórico acotado, REVERSIBLE ─────────────────────────────
/**
 * Secuencia fail-safe [P1-D/P1-F/P1-C]:
 *   0. validación + GO/NO-GO + scope estricto + lock(token) + SUPERVISOR de lease
 *      (renueva en 2º plano toda la operación) + no-overlap;
 *   1. buildPlan UNA sola vez (motor apply:false = LECTURA) → filas engine + prev;
 *      digest CANÓNICO versionado (rango/scope/empleados/celda/prev/existencia/
 *      target/op). Falta digest → PLAN_DIGEST_REQUIRED; drift de asistencia/config
 *      O del estado previo de daily_summary → PLAN_CHANGED, ANTES de escribir;
 *   2. BACKUP ATÓMICO del MISMO `existing` validado: header 'prepared' + todas las
 *      filas de backup en UNA transacción (todo o nada); verificación de conteo;
 *   3. 'applying'; se ESCRIBE EXACTAMENTE el plan validado con el ÚNICO escritor
 *      (applyResolvedRows → escribirFilas), SIN un segundo recálculo desde datos
 *      vivos; assertAlive() antes de cada empleado corta si se perdió el lease;
 *   4. 'applied' (sólo al terminar). Error en 2–3 → 'failed' con backup completo.
 */
async function recalcApply({ from, to, scopeKind, scopeId = null, userId = null, planDigestExpected = null }) {
  validateRange(from, to);
  await assertGoNoGo('recalc/apply');
  // [P1-B] scope estricto ANTES de tomar lock o escribir.
  const ids = await resolveEmployeeIds(scopeKind, scopeId);
  if (!ids.length) {
    return { batch_id: null, status: 'noop', employees: 0, rows_backed_up: 0, rows_written: 0, note: 'Sin empleados en alcance' };
  }
  // [P1-F] el digest del dry-run es OBLIGATORIO (se exige antes de tomar el lock).
  if (!planDigestExpected) throw badRequest('Falta plan_digest del dry-run previo.', 'PLAN_DIGEST_REQUIRED');

  const token = await acquireConsoleLock('recalc', userId);
  const lease = startLeaseSupervisor(token); // [P1-C] renovación en 2º plano
  const batchId = crypto.randomUUID();
  let headerCommitted = false;
  try {
    await assertNoOverlap(from, to);

    // 1. plan (una sola vez) + digest canónico (paridad exacta con el dry-run).
    const { plan, existing, cells } = await buildPlan(ids, from, to);
    const digest = planDigest(canonicalPlan({ from, to, scopeKind, scopeId, ids, plan, existing }));
    if (planDigestExpected !== digest) {
      throw conflict(
        'El plan cambió desde el dry-run (asistencia/config o el estado previo de daily_summary difieren). Volvé a previsualizar.',
        'PLAN_CHANGED',
      );
    }
    lease.assertAlive();

    // 2. BACKUP ATÓMICO en una transacción: header + backups (del MISMO `existing`).
    const t = await sequelize.transaction();
    try {
      await sequelize.query(
        `INSERT INTO daily_summary_recalc_batch
           (batch_id, from_date, to_date, scope_kind, scope_id, status, employees, rows_backed_up, rows_written, plan_digest, created_by)
         VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, 0, ?, ?)`,
        { replacements: [batchId, from, to, scopeKind, scopeId ?? null, ids.length, cells.length, digest, userId ?? null], transaction: t },
      );
      const buffer = [];
      const flush = async () => {
        if (!buffer.length) return;
        const flat = [];
        for (const b of buffer) {
          flat.push(batchId, b.emp, b.date, b.existed, b.first_in, b.last_out,
            b.worked_minutes, b.break_minutes, b.late_minutes, b.overtime_minutes, b.status, b.notes, b.row_json);
        }
        const ph = buffer.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        await sequelize.query(
          `INSERT INTO daily_summary_backup
             (batch_id, employee_id, date, existed, first_in, last_out, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes, row_json)
           VALUES ${ph}`,
          { replacements: flat, transaction: t },
        );
        buffer.length = 0;
      };
      for (const cell of cells) {
        const cur = existing.get(`${cell.emp}|${cell.date}`);
        buffer.push({
          emp: cell.emp, date: cell.date, existed: cur ? 1 : 0,
          first_in: cur?.first_in ?? null, last_out: cur?.last_out ?? null,
          worked_minutes: cur?.worked_minutes ?? null, break_minutes: cur?.break_minutes ?? null,
          late_minutes: cur?.late_minutes ?? null, overtime_minutes: cur?.overtime_minutes ?? null,
          status: cur?.status ?? null, notes: cur?.notes ?? null,
          row_json: cur ? JSON.stringify(cur) : null,
        });
        if (buffer.length >= BACKUP_CHUNK) await flush();
      }
      await flush();
      await t.commit();
    } catch (e) {
      await t.rollback(); // [P1-D] fallo en cualquier chunk → NO deja header ni backups huérfanos, ni bloquea el rango.
      throw e;
    }
    headerCommitted = true;

    // Verificación mecánica del conteo ANTES de escribir daily_summary [P1-D].
    const [[cnt]] = await sequelize.query('SELECT COUNT(*) AS n FROM daily_summary_backup WHERE batch_id = ?', { replacements: [batchId] });
    if (Number(cnt?.n || 0) !== cells.length) {
      throw conflict(`Respaldo incompleto (${cnt?.n} vs ${cells.length}); no se escribe daily_summary.`, 'BACKUP_COUNT_MISMATCH');
    }

    // 3. 'applying' + ESCRIBIR EXACTAMENTE EL PLAN VALIDADO (sin segundo recálculo).
    //    Se usa el ÚNICO escritor (applyResolvedRows → escribirFilas) sobre las
    //    filas engine capturadas en buildPlan. assertAlive() aborta si el lease se
    //    perdió, ANTES de tocar daily_summary del empleado siguiente.
    await sequelize.query("UPDATE daily_summary_recalc_batch SET status = 'applying' WHERE batch_id = ?", { replacements: [batchId] });
    const rowsByEmp = planRowsByEmployee(plan);
    let rowsWritten = 0;
    for (const [emp, engineRows] of rowsByEmp) {
      lease.assertAlive();
      await workdaySummary.applyResolvedRows(emp, engineRows);
      rowsWritten += engineRows.length;
    }

    // 4. 'applied' (todo terminó). rows_written = celdas del plan aplicadas por el
    //    escritor (upsert o reconciliación) = cells.length; semántica documentada.
    await sequelize.query("UPDATE daily_summary_recalc_batch SET status = 'applied', rows_written = ? WHERE batch_id = ?", { replacements: [rowsWritten, batchId] });
    return {
      batch_id: batchId, status: 'applied', period: { from, to },
      scope: { kind: scopeKind, id: scopeId ?? null }, employees: ids.length,
      rows_backed_up: cells.length, rows_written: rowsWritten, plan_digest: digest,
      dates_outside_range: [...new Set(cells.filter((c) => c.outsideRange).map((c) => c.date))].sort(),
      backup_confirmation: 'operator_declared',
    };
  } catch (err) {
    if (headerCommitted) {
      try {
        await sequelize.query(
          "UPDATE daily_summary_recalc_batch SET status = 'failed' WHERE batch_id = ? AND status IN ('prepared','applying')",
          { replacements: [batchId] },
        );
      } catch { /* no enmascarar el error original */ }
    }
    throw err;
  } finally {
    lease.stop();               // [P1-C] cerrar el supervisor limpiamente
    await releaseConsoleLock(token); // sólo libera NUESTRO token: nunca el del nuevo dueño
  }
}

/**
 * RESTORE por batch_id, RECUPERABLE [P1-E].
 *   · Exclusión mutua con propiedad (lock token).
 *   · Verifica COUNT(backup)==rows_backed_up antes de tocar nada.
 *   · TODA la reposición + la marca 'restored'/restored_at ocurren en UNA
 *     transacción: si algo falla, ROLLBACK deja daily_summary y el batch intactos
 *     (estado restaurable) → REINTENTABLE, nunca bloqueado en 'restoring'.
 */
async function restoreBatch({ batchId, userId = null }) {
  const token = await acquireConsoleLock('restore', userId);
  const lease = startLeaseSupervisor(token); // [P1-C] renovación en 2º plano
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
              worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes
         FROM daily_summary_backup WHERE batch_id = ?`,
      { replacements: [batchId] },
    );

    // TODO-o-NADA: reposición + marca final en una transacción. Reintentable.
    lease.assertAlive();
    const t = await sequelize.transaction();
    let restored = 0; let deleted = 0;
    try {
      for (const b of rows) {
        if (b.existed) {
          await sequelize.query(
            `INSERT INTO daily_summary
               (employee_id, date, first_in, last_out, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               first_in = VALUES(first_in), last_out = VALUES(last_out),
               worked_minutes = VALUES(worked_minutes), break_minutes = VALUES(break_minutes),
               late_minutes = VALUES(late_minutes), overtime_minutes = VALUES(overtime_minutes),
               status = VALUES(status), notes = VALUES(notes)`,
            { replacements: [b.employee_id, b.date, b.first_in, b.last_out, b.worked_minutes, b.break_minutes, b.late_minutes, b.overtime_minutes, b.status, b.notes], transaction: t },
          );
          restored++;
        } else {
          await sequelize.query('DELETE FROM daily_summary WHERE employee_id = ? AND date = ?', { replacements: [b.employee_id, b.date], transaction: t });
          deleted++;
        }
      }
      // restored_at sólo al finalizar correctamente, dentro de la misma transacción.
      await sequelize.query(
        "UPDATE daily_summary_recalc_batch SET status = 'restored', restored_by = ?, restored_at = NOW() WHERE batch_id = ?",
        { replacements: [userId ?? null, batchId], transaction: t },
      );
      await t.commit();
    } catch (e) {
      await t.rollback(); // fallo parcial → nada cambia; el batch queda restaurable y REINTENTABLE.
      throw e;
    }
    return { batch_id: batchId, status: 'restored', rows_restored: restored, rows_deleted: deleted };
  } finally {
    lease.stop();               // [P1-C] cerrar el supervisor limpiamente
    await releaseConsoleLock(token); // sólo libera NUESTRO token
  }
}

async function listBatches({ limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await sequelize.query(
    `SELECT batch_id, DATE_FORMAT(from_date,'%Y-%m-%d') AS from_date, DATE_FORMAT(to_date,'%Y-%m-%d') AS to_date,
            scope_kind, scope_id, status, employees, rows_backed_up, rows_written, plan_digest,
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
  evalGoNoGo, assertGoNoGo, buildPlan, planDigest, canonicalPlan, planRowsByEmployee, opForRow, isRealCivilDate,
  acquireConsoleLock, heartbeatConsoleLock, releaseConsoleLock, startLeaseSupervisor,
  MAX_RANGE_DAYS, LOCK_LEASE_SEC, BACKUP_CHUNK, PLAN_DIGEST_VERSION,
  REQUIRED_MIGRATIONS, CONSOLE_MIGRATION, VALID_SCOPES, MUTABLE_FIELDS,
};
