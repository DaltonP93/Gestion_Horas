'use strict';

/**
 * faseEConsoleService.js — Motor de la CONSOLA DE ACTIVACIÓN GUIADA de FASE E.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ ES Y QUÉ NO ES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Concentra la lógica que la ruta /api/fase-e expone. La ruta pone la DOBLE
 * COMPUERTA (RBAC super_admin + master-flag FASE_E_ACTIVATION_ENABLED); este
 * servicio pone la matemática, el GO/NO-GO exigido, la EXCLUSIÓN MUTUA y la
 * REVERSIBILIDAD con máquina de estados:
 *
 *   · SOLO LECTURA  → getStatus / getImpact / listBatches. No escriben nada.
 *   · MUTANTE       → applyMigrations / setForwardEnabled / recalcApply /
 *                     restoreBatch. Cada una respalda o es trivialmente
 *                     reversible, y el recálculo histórico respalda ANTES de
 *                     sobrescribir una sola fila de daily_summary.
 *
 * NO conoce ATT2000 (no lo importa ni lee ATT_*). NO escribe attendance_logs.
 * Reutiliza el ÚNICO escritor del motor (workdaySummaryService) — no duplica
 * matemática de jornada.
 *
 * Invariantes endurecidas (revisión pre-Ready):
 *   1. scope_kind SÓLO all|department|employee; nunca se coacciona a all.
 *   2. dry-run enumera EXACTAMENTE las mismas celdas que recalcApply (incluida
 *      la ventana nocturna [from-1]) y compara los 8 campos mutables.
 *   3. dry-run reporta explícitamente las fechas modificables FUERA del rango.
 *   4. GO/NO-GO exigido en backend antes de forward/enable y recalc/apply.
 *   5. applyMigrations NO bloquea el event loop (spawn asíncrono, proceso aparte).
 *   6. Exclusión mutua recalc/restore + rechazo de rangos superpuestos.
 *   7. Estados prepared/applying/applied/failed/restoring/restored; NUNCA se
 *      marca applied antes de terminar el motor.
 *   8. RESTORE verifica que el conteo real de respaldos == rows_backed_up y no
 *      marca restored ante ejecución parcial.
 */

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { sequelize } = require('../config/database');
const workdaySummary = require('./workdaySummaryService');

const REQUIRED_MIGRATIONS = [
  '072_employee_schedule_history.sql',
  '073_workday_profile_and_overlap_guard.sql',
  '074_daily_summary_status_unknown.sql',
  '075_workday_configuration_phase_c.sql',
];
const CONSOLE_MIGRATION = '083_fase_e_activation_console.sql';
// Tope de las migraciones que la consola aplica: el conjunto del motor (FASE C)
// hasta 075. Nunca arrastra 076+ (incluida 083) en el mismo paso.
const MIGRATE_UPTO = '075_workday_configuration_phase_c.sql';

const MAX_RANGE_DAYS = 366;      // cota dura del recálculo/impacto
const EMP_CHUNK = 500;           // lote de empleados por consulta
const BACKUP_CHUNK = 200;        // filas por INSERT de respaldo
const LOCK_TTL_MIN = 30;         // TTL del lock de consola (auto-recupera si un proceso murió)
const CONSOLE_LOCK_ID = 1;       // fila única del lock

// scope_kind admitidos, EXACTOS. Cualquier otro valor se rechaza (nunca "all").
const VALID_SCOPES = new Set(['all', 'department', 'employee']);

// Columnas MUTABLES que el escritor del motor puede cambiar (las que respalda y
// restaura el batch, y las que el dry-run compara para paridad con recalcApply).
const MUTABLE_FIELDS = [
  'first_in', 'last_out', 'worked_minutes', 'break_minutes',
  'late_minutes', 'overtime_minutes', 'status', 'notes',
];

// ─── master-flag (documentado, NUNCA en true en el repo) ────────────────
/** Segundo cerrojo de la consola: env master-flag. Sólo 'true' habilita. */
function isActivationEnabled() {
  return process.env.FASE_E_ACTIVATION_ENABLED === 'true';
}

// ─── helpers de fecha (aritmética de pared, sin zona) ───────────────────
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}
function rangeDays(from, to) {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000) + 1;
}
function eachDate(from, to) {
  const out = [];
  let d = from;
  // Cota de seguridad por si el rango fuese inválido: nunca más de MAX_RANGE_DAYS.
  for (let i = 0; i < MAX_RANGE_DAYS && d <= to; i++) {
    out.push(d);
    d = workdaySummary.shiftDate(d, 1);
  }
  return out;
}

function badRequest(message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}
function conflict(message, code = 'CONFLICT') {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  return err;
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
    return [...REQUIRED_MIGRATIONS, CONSOLE_MIGRATION]
      .map((filename) => ({ filename, recorded: false }));
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

/**
 * Verifica el GO/NO-GO REAL del esquema y lo devuelve. Si `assert` es true,
 * lanza 409 NO_GO_SCHEMA_INCOMPLETE cuando falta algo. Es la compuerta que
 * forward/enable y recalc/apply exigen en el backend (no sólo advisory).
 */
async function evalGoNoGo() {
  const migrations = await migrationStatus();
  const engineOk = REQUIRED_MIGRATIONS.every(
    (m) => migrations.find((x) => x.filename === m)?.recorded,
  );
  const consoleOk = Boolean(migrations.find((x) => x.filename === CONSOLE_MIGRATION)?.recorded);
  const has074 = await dailyStatusHas074();
  const backupReady =
    (await tableExists('daily_summary_recalc_batch')) &&
    (await tableExists('daily_summary_backup'));

  const missing = [];
  if (!engineOk) missing.push('migraciones 072–075 registradas');
  if (!has074) missing.push("ENUM 074 en daily_summary.status ('non_working'/'unconfigured')");
  if (!consoleOk) missing.push('migración de consola 083 registrada');
  if (!backupReady) missing.push('tablas de respaldo (daily_summary_recalc_batch/daily_summary_backup)');

  return { ok: missing.length === 0, engineOk, consoleOk, has074, backupReady, missing };
}

async function assertGoNoGo(context) {
  const g = await evalGoNoGo();
  if (!g.ok) {
    const err = conflict(
      `GO/NO-GO: esquema incompleto para "${context}". Falta: ${g.missing.join('; ')}.`,
      'NO_GO_SCHEMA_INCOMPLETE',
    );
    err.missing = g.missing;
    throw err;
  }
}

/**
 * Estado COMPLETO de solo lectura para la consola: migraciones, esquema,
 * cerrojos (env + BD) y un GO/NO-GO. No modifica nada.
 */
async function getStatus() {
  const historyExists = await tableExists('employee_schedule_history');
  const migrations = await migrationStatus();
  const g = await evalGoNoGo();

  let historyRows = null;
  if (historyExists) {
    const [[c]] = await sequelize.query('SELECT COUNT(*) AS n FROM employee_schedule_history');
    historyRows = Number(c?.n || 0);
  }

  // Cerrojos del escritor hacia adelante.
  const envKillSwitch = workdaySummary.isEngineSummaryWriteEnabled();
  const forwardSetting = await workdaySummary.isForwardSettingEnabled();
  const forwardEffective = envKillSwitch && forwardSetting;

  const gates = {
    rbac: 'super_admin',
    master_flag_env: 'FASE_E_ACTIVATION_ENABLED',
    master_flag_enabled: isActivationEnabled(),
    forward_env_kill_switch: envKillSwitch,          // WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED
    forward_db_setting: forwardSetting,              // fase_e_forward_enabled
    forward_effective: forwardEffective,             // AMBOS → el motor escribe
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
    // GO/NO-GO: el backend LO EXIGE (409) antes de forward/enable y recalc/apply,
    // además de mostrarlo acá. NO es la autorización: la ejecuta el dueño con la
    // doble compuerta (master-flag + confirmación tipeada + backup).
    go_no_go: {
      schema_ready: g.ok,
      missing: g.missing,
      forward_ready_to_flip: g.ok && envKillSwitch,
      note: 'El esquema completo (072–075 + 074 + 083 + tablas de respaldo) es OBLIGATORIO en backend '
        + 'para forward/enable y recalc/apply; la activación real exige además master-flag + confirmación '
        + 'tipeada + backup declarado por el operador.',
    },
  };
}

// ─── alcance de empleados ────────────────────────────────────────────────
async function resolveEmployeeIds(scopeKind, scopeId) {
  // (1) scope_kind EXACTO. Un valor desconocido NUNCA cae a 'all'.
  if (!VALID_SCOPES.has(scopeKind)) {
    throw badRequest(
      `scope_kind inválido: "${scopeKind}". Debe ser exactamente "all", "department" o "employee".`,
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
    const [rows] = await sequelize.query(
      `SELECT id FROM employees WHERE department_id = ? ORDER BY id`,
      { replacements: [id] },
    );
    return rows.map((r) => r.id);
  }
  // all → padrón activo
  const [rows] = await sequelize.query(
    `SELECT id FROM employees WHERE status = 'active' ORDER BY id`,
  );
  return rows.map((r) => r.id);
}

function validateRange(from, to) {
  if (!validDate(from) || !validDate(to) || from > to) {
    throw badRequest('from/to deben ser YYYY-MM-DD válidas con from <= to', 'INVALID_RANGE');
  }
  if (rangeDays(from, to) > MAX_RANGE_DAYS) {
    throw badRequest(`El rango excede el máximo de ${MAX_RANGE_DAYS} días`, 'RANGE_TOO_WIDE');
  }
}

// ─── normalización + diff de las 8 columnas mutables ─────────────────────
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
/** Devuelve { differs, changed:[campos] } comparando LAS 8 columnas mutables. */
function diffMutableFields(motorRow, storedRow) {
  const m = motorRowNormalized(motorRow);
  const s = storedRowNormalized(storedRow);
  if (!s) return { differs: true, changed: MUTABLE_FIELDS.slice() };
  const changed = MUTABLE_FIELDS.filter((f) => (m[f] ?? null) !== (s[f] ?? null));
  return { differs: changed.length > 0, changed };
}

/** Carga las filas existentes de daily_summary para un span, indexadas por celda. */
async function loadExistingRows(ids, fromDate, toDate) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += EMP_CHUNK) {
    const chunk = ids.slice(i, i + EMP_CHUNK);
    const [rows] = await sequelize.query(
      `SELECT employee_id,
              DATE_FORMAT(date,'%Y-%m-%d') AS date,
              DATE_FORMAT(first_in,'%Y-%m-%d %H:%i:%s') AS first_in,
              DATE_FORMAT(last_out,'%Y-%m-%d %H:%i:%s') AS last_out,
              worked_minutes, break_minutes, late_minutes, overtime_minutes,
              status, notes
         FROM daily_summary
        WHERE employee_id IN (${chunk.map(() => '?').join(',')})
          AND date >= ? AND date <= ?`,
      { replacements: [...chunk, fromDate, toDate] },
    );
    for (const r of rows) map.set(`${r.employee_id}|${r.date}`, r);
  }
  return map;
}

/**
 * Enumera las celdas (employee, date) EXACTAS que el recálculo del rango
 * escribiría — las mismas que respalda recalcApply — y las compara contra lo
 * guardado. El escritor por fecha toca {date-1, date}, así que enumerar por
 * dry-run sobre [from, to] produce el conjunto real, incluida la ventana
 * nocturna [from-1]. Devuelve las celdas (con diff de los 8 campos y si están
 * FUERA del rango pedido) y el Map de filas existentes (para el respaldo).
 */
async function enumerateAndDiff(ids, from, to) {
  const spanFrom = workdaySummary.shiftDate(from, -1);
  const existing = await loadExistingRows(ids, spanFrom, to);
  const cells = [];
  const seen = new Set();
  for (const d of eachDate(from, to)) {
    const { rowsByEmployee } = await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: false });
    for (const [emp, rows] of rowsByEmployee) {
      for (const row of rows) {
        const key = `${emp}|${row.date}`;
        if (seen.has(key)) continue; // la ventana nocturna hace que una celda aparezca en dos días
        seen.add(key);
        const stored = existing.get(key);
        const { differs, changed } = diffMutableFields(row, stored);
        cells.push({
          emp,
          date: row.date,
          existed: stored ? 1 : 0,
          differs,
          changed,
          outsideRange: row.date < from || row.date > to,
        });
      }
    }
  }
  return { cells, existing };
}

/**
 * Impacto dry-run: cuántas celdas de daily_summary DIFERIRÍAN entre lo guardado
 * (legacy) y el motor para el rango/alcance, SIN escribir. Enumera EXACTAMENTE
 * las mismas celdas que recalcApply, compara los 8 campos mutables y reporta
 * explícitamente las fechas modificables FUERA del rango pedido (ventana nocturna).
 */
async function getImpact({ from, to, scopeKind = 'all', scopeId = null, maxExamples = 50 }) {
  validateRange(from, to);
  const ids = await resolveEmployeeIds(scopeKind, scopeId);

  const report = {
    read_only: true,
    period: { from, to },
    scope: { kind: scopeKind, id: scopeId ?? null },
    employees: ids.length,
    cells_evaluated: 0,
    rows_differ: 0,
    rows_new: 0,
    rows_differ_outside_range: 0,
    dates_outside_range: [],
    examples: [],
  };
  if (!ids.length) return report;

  const { cells } = await enumerateAndDiff(ids, from, to);
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
          employee_id: c.emp,
          date: c.date,
          outside_requested_range: c.outsideRange,
          existed: c.existed,
          changed_fields: c.changed, // los que difieren, de las 8 columnas mutables
        });
      }
    }
  }
  report.dates_outside_range = [...outside].sort();
  return report;
}

// ─── exclusión mutua de consola (recalc/restore) ─────────────────────────
/**
 * Toma el lock ÚNICO de operaciones mutantes de la consola. Atómico e
 * independiente de la conexión (una sola UPDATE condicional), con TTL que
 * auto-recupera si un proceso murió sin liberar. Si ya está tomado por una
 * operación viva → 409 CONSOLE_BUSY.
 */
async function acquireConsoleLock(operation, userId) {
  const [res] = await sequelize.query(
    `UPDATE fase_e_console_lock
        SET held = 1, operation = ?, held_by = ?, acquired_at = NOW()
      WHERE id = ?
        AND (held = 0 OR acquired_at < (NOW() - INTERVAL ${LOCK_TTL_MIN} MINUTE))`,
    { replacements: [operation, userId ?? null, CONSOLE_LOCK_ID] },
  );
  const affected = (res && (res.affectedRows ?? res.rowCount)) || 0;
  if (!affected) {
    throw conflict(
      'Otra operación de consola FASE E (recalc/restore) está en curso. Reintentá cuando termine.',
      'CONSOLE_BUSY',
    );
  }
}
async function releaseConsoleLock() {
  await sequelize.query(
    `UPDATE fase_e_console_lock SET held = 0, operation = NULL, held_by = NULL WHERE id = ?`,
    { replacements: [CONSOLE_LOCK_ID] },
  );
}

/**
 * Rechaza un recálculo cuyo rango se SUPERPONE con un lote todavía no
 * restaurado. Considera la ventana nocturna en ambos lados: un lote guardado
 * [f, t] tocó [f-1, t]; el nuevo toca [from-1, to]. Overlap si
 * (f-1) <= to AND t >= (from-1). Sólo 'restored' libera el período.
 */
async function assertNoOverlap(from, to) {
  const spanFrom = workdaySummary.shiftDate(from, -1);
  const [rows] = await sequelize.query(
    `SELECT batch_id, status,
            DATE_FORMAT(from_date,'%Y-%m-%d') AS from_date,
            DATE_FORMAT(to_date,'%Y-%m-%d') AS to_date
       FROM daily_summary_recalc_batch
      WHERE status <> 'restored'
        AND DATE_SUB(from_date, INTERVAL 1 DAY) <= ?
        AND to_date >= ?
      LIMIT 1`,
    { replacements: [to, spanFrom] },
  );
  if (rows.length) {
    const b = rows[0];
    throw conflict(
      `El rango se superpone con el lote ${b.batch_id} (${b.from_date}→${b.to_date}, estado ${b.status}), `
      + 'todavía no restaurado. Restaurá ese lote o esperá antes de recalcular ese período.',
      'RANGE_OVERLAP',
    );
  }
}

// ─── activación hacia adelante (reversible, un click) ────────────────────
/** Flip del setting de BD fase_e_forward_enabled. Reversible sin reiniciar. */
async function setForwardEnabled(enabled) {
  // (4) forward/enable exige GO/NO-GO en backend (no basta el flag del cliente).
  //     El disable NO se gatea: apagar siempre es seguro (vuelve a legacy).
  if (enabled) await assertGoNoGo('forward/enable');
  const value = enabled ? 'true' : 'false';
  await sequelize.query(
    `INSERT INTO system_settings (key_name, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    { replacements: [workdaySummary.FORWARD_SETTING_KEY, value] },
  );
  return {
    forward_db_setting: enabled,
    forward_env_kill_switch: workdaySummary.isEngineSummaryWriteEnabled(),
    forward_effective: enabled && workdaySummary.isEngineSummaryWriteEnabled(),
  };
}

// ─── migraciones desde la consola (runner real, acotado a 075) ──────────
/**
 * (5) Aplica las migraciones pendientes del motor HASTA 075 con el runner real,
 * en un PROCESO HIJO y de forma ASÍNCRONA (spawn, no spawnSync): NO bloquea el
 * event loop de la API mientras corre. Acotado con --upto para no arrastrar 083+
 * en el mismo paso. Sólo se invoca detrás del master-flag. Resuelve con la salida
 * del runner (nunca rechaza: empaqueta el error en ok=false).
 */
function applyMigrations() {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'migrate.js');
  const cwd = path.resolve(__dirname, '..', '..');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (payload) => { if (done) return; done = true; resolve(payload); };
    let child;
    try {
      child = spawn(process.execPath, [script, `--upto=${MIGRATE_UPTO}`], { cwd, env: process.env });
    } catch (err) {
      return finish({ ok: false, upto: MIGRATE_UPTO, exit_code: null, stdout: '', stderr: String(err.message) });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      finish({ ok: false, upto: MIGRATE_UPTO, exit_code: null, timed_out: true, stdout: stdout.slice(-8000), stderr: (stderr + '\n[timeout 5min: proceso terminado]').slice(-4000) });
    }, 5 * 60 * 1000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, upto: MIGRATE_UPTO, exit_code: null, stdout: stdout.slice(-8000), stderr: String(err.message).slice(-4000) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, upto: MIGRATE_UPTO, exit_code: code, stdout: stdout.slice(-8000), stderr: stderr.slice(-4000) });
    });
  });
}

// ─── recálculo histórico acotado, REVERSIBLE + máquina de estados ────────
/**
 * Recálculo histórico ACOTADO y REVERSIBLE, con máquina de estados y exclusión
 * mutua.
 *
 * Secuencia fail-safe (7):
 *   0. GO/NO-GO backend + lock de consola + no-overlap;
 *   1. enumerar celdas objetivo por DRY-RUN (sin escribir);
 *   2. cabecera del lote en 'prepared';
 *   3. RESPALDAR el estado PREVIO de cada celda ANTES de tocar nada
 *      (existed=0 marca las que el recálculo creará → el RESTORE las borra);
 *   4. estado 'applying';
 *   5. APLICAR el recálculo por el motor, fecha por fecha;
 *   6. estado 'applied' (sólo al terminar TODO). Si algo falla en 3–5 → 'failed'.
 *
 * NUNCA se marca 'applied' antes de terminar. Un fallo intermedio deja el lote
 * 'failed' con el respaldo completo, de modo que el RESTORE deshace lo parcial.
 */
async function recalcApply({ from, to, scopeKind = 'all', scopeId = null, userId = null }) {
  validateRange(from, to);
  await assertGoNoGo('recalc/apply');
  const ids = await resolveEmployeeIds(scopeKind, scopeId);
  if (!ids.length) {
    return { batch_id: null, status: 'noop', employees: 0, rows_backed_up: 0, rows_written: 0, note: 'Sin empleados en alcance' };
  }

  await acquireConsoleLock('recalc', userId);
  const batchId = crypto.randomUUID();
  let headerInserted = false;
  try {
    await assertNoOverlap(from, to);

    // 1. celdas objetivo exactas (incluye [from-1] por la ventana nocturna) + existentes.
    const { cells, existing } = await enumerateAndDiff(ids, from, to);

    // 2. cabecera del lote en 'prepared' (aún no se escribió daily_summary).
    await sequelize.query(
      `INSERT INTO daily_summary_recalc_batch
         (batch_id, from_date, to_date, scope_kind, scope_id, status, employees, rows_backed_up, rows_written, created_by)
       VALUES (?, ?, ?, ?, ?, 'prepared', ?, 0, 0, ?)`,
      { replacements: [batchId, from, to, scopeKind, scopeId ?? null, ids.length, userId ?? null] },
    );
    headerInserted = true;

    // 3. respaldo del estado PREVIO de TODA celda objetivo, ANTES de escribir.
    let rowsBackedUp = 0;
    const backupBuffer = [];
    const flushBackup = async () => {
      if (!backupBuffer.length) return;
      const flat = [];
      for (const b of backupBuffer) {
        flat.push(batchId, b.emp, b.date, b.existed,
          b.first_in, b.last_out, b.worked_minutes, b.break_minutes,
          b.late_minutes, b.overtime_minutes, b.status, b.notes, b.row_json);
      }
      const ph = backupBuffer.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
      await sequelize.query(
        `INSERT INTO daily_summary_backup
          (batch_id, employee_id, date, existed, first_in, last_out,
           worked_minutes, break_minutes, late_minutes, overtime_minutes,
           status, notes, row_json)
         VALUES ${ph}`,
        { replacements: flat },
      );
      backupBuffer.length = 0;
    };

    for (const cell of cells) {
      const cur = existing.get(`${cell.emp}|${cell.date}`);
      backupBuffer.push({
        emp: cell.emp,
        date: cell.date,
        existed: cur ? 1 : 0,
        first_in: cur?.first_in ?? null,
        last_out: cur?.last_out ?? null,
        worked_minutes: cur?.worked_minutes ?? null,
        break_minutes: cur?.break_minutes ?? null,
        late_minutes: cur?.late_minutes ?? null,
        overtime_minutes: cur?.overtime_minutes ?? null,
        status: cur?.status ?? null,
        notes: cur?.notes ?? null,
        row_json: cur ? JSON.stringify(cur) : null,
      });
      rowsBackedUp++;
      if (backupBuffer.length >= BACKUP_CHUNK) await flushBackup();
    }
    await flushBackup();

    // Registrar cuántas filas se respaldaron (lo usa el RESTORE para validar).
    await sequelize.query(
      `UPDATE daily_summary_recalc_batch SET rows_backed_up = ? WHERE batch_id = ?`,
      { replacements: [rowsBackedUp, batchId] },
    );

    // 4. estado 'applying': a partir de acá el motor SÍ escribe.
    await sequelize.query(
      `UPDATE daily_summary_recalc_batch SET status = 'applying' WHERE batch_id = ?`,
      { replacements: [batchId] },
    );

    // 5. aplicar el recálculo real por el motor, fecha por fecha.
    for (const d of eachDate(from, to)) {
      await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: true });
    }

    // 6. recién ahora 'applied' (todo terminó) + rows_written reales.
    const rowsWritten = cells.length;
    await sequelize.query(
      `UPDATE daily_summary_recalc_batch SET status = 'applied', rows_written = ? WHERE batch_id = ?`,
      { replacements: [rowsWritten, batchId] },
    );

    return {
      batch_id: batchId,
      status: 'applied',
      period: { from, to },
      scope: { kind: scopeKind, id: scopeId ?? null },
      employees: ids.length,
      rows_backed_up: rowsBackedUp,
      rows_written: rowsWritten,
      dates_outside_range: [...new Set(cells.filter((c) => c.outsideRange).map((c) => c.date))].sort(),
      backup_confirmation: 'operator_declared', // (10) backup_confirmed lo declara el operador; no es verificación automática.
    };
  } catch (err) {
    // Fallo en 2–5 → NUNCA 'applied'. Marcamos 'failed' (best-effort) para que el
    // RESTORE deshaga lo parcial. Si ni la cabecera se insertó, no hay nada que marcar.
    if (headerInserted) {
      try {
        await sequelize.query(
          `UPDATE daily_summary_recalc_batch SET status = 'failed'
            WHERE batch_id = ? AND status IN ('prepared', 'applying')`,
          { replacements: [batchId] },
        );
      } catch { /* no enmascarar el error original */ }
    }
    throw err;
  } finally {
    await releaseConsoleLock();
  }
}

/**
 * RESTORE por batch_id: repone el estado PREVIO de cada celda respaldada.
 *   · existed=1 → UPSERT de las columnas mutables originales;
 *   · existed=0 → DELETE (la fila la había creado el recálculo).
 *
 * (6) Exclusión mutua con recalc/otro restore. (8) Verifica que el conteo real
 * de respaldos == rows_backed_up antes de tocar nada y NO marca 'restored' si la
 * ejecución fue parcial (un fallo intermedio deja el lote 'restoring').
 */
async function restoreBatch({ batchId, userId = null }) {
  await acquireConsoleLock('restore', userId);
  try {
    const [[batch]] = await sequelize.query(
      `SELECT batch_id, status, rows_backed_up FROM daily_summary_recalc_batch WHERE batch_id = ? LIMIT 1`,
      { replacements: [batchId] },
    );
    if (!batch) throw badRequest('batch_id inexistente', 'BATCH_NOT_FOUND');
    if (batch.status === 'restored') throw conflict('El lote ya fue restaurado', 'BATCH_ALREADY_RESTORED');
    if (batch.status === 'restoring') throw conflict('El lote está siendo restaurado', 'BATCH_RESTORE_IN_PROGRESS');
    if (!['applied', 'failed'].includes(batch.status)) {
      throw conflict(`No se puede restaurar un lote en estado "${batch.status}"`, 'BATCH_NOT_RESTORABLE');
    }

    // (8) el respaldo debe estar COMPLETO antes de restaurar.
    const [[cnt]] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM daily_summary_backup WHERE batch_id = ?`,
      { replacements: [batchId] },
    );
    const actualBackups = Number(cnt?.n || 0);
    if (actualBackups !== Number(batch.rows_backed_up)) {
      throw conflict(
        `Respaldo incompleto: ${actualBackups} filas respaldadas vs ${batch.rows_backed_up} registradas. `
        + 'No se restaura para no dejar daily_summary en estado inconsistente.',
        'BACKUP_COUNT_MISMATCH',
      );
    }

    // Estado 'restoring' mientras dura. Si algo falla, queda 'restoring' (parcial),
    // NUNCA 'restored'.
    await sequelize.query(
      `UPDATE daily_summary_recalc_batch SET status = 'restoring', restored_by = ?, restored_at = NOW()
        WHERE batch_id = ?`,
      { replacements: [userId ?? null, batchId] },
    );

    const [rows] = await sequelize.query(
      `SELECT employee_id,
              DATE_FORMAT(date,'%Y-%m-%d') AS date, existed,
              DATE_FORMAT(first_in,'%Y-%m-%d %H:%i:%s') AS first_in,
              DATE_FORMAT(last_out,'%Y-%m-%d %H:%i:%s') AS last_out,
              worked_minutes, break_minutes, late_minutes, overtime_minutes,
              status, notes
         FROM daily_summary_backup WHERE batch_id = ?`,
      { replacements: [batchId] },
    );

    let restored = 0;
    let deleted = 0;
    let processed = 0;
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
          { replacements: [
            b.employee_id, b.date, b.first_in, b.last_out,
            b.worked_minutes, b.break_minutes, b.late_minutes, b.overtime_minutes,
            b.status, b.notes,
          ] },
        );
        restored++;
      } else {
        await sequelize.query(
          `DELETE FROM daily_summary WHERE employee_id = ? AND date = ?`,
          { replacements: [b.employee_id, b.date] },
        );
        deleted++;
      }
      processed++;
    }

    // (8) sólo 'restored' si se procesaron TODAS las filas respaldadas.
    if (processed !== actualBackups) {
      throw conflict(
        `Restauración parcial: ${processed}/${actualBackups} filas. El lote queda 'restoring'.`,
        'RESTORE_PARTIAL',
      );
    }

    await sequelize.query(
      `UPDATE daily_summary_recalc_batch SET status = 'restored' WHERE batch_id = ?`,
      { replacements: [batchId] },
    );

    return { batch_id: batchId, status: 'restored', rows_restored: restored, rows_deleted: deleted };
  } finally {
    await releaseConsoleLock();
  }
}

/** Lista de lotes (SOLO LECTURA), sin PII. */
async function listBatches({ limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const [rows] = await sequelize.query(
    `SELECT batch_id, DATE_FORMAT(from_date,'%Y-%m-%d') AS from_date,
            DATE_FORMAT(to_date,'%Y-%m-%d') AS to_date,
            scope_kind, scope_id, status, employees, rows_backed_up, rows_written,
            created_by, created_at, restored_by, restored_at
       FROM daily_summary_recalc_batch
      ORDER BY created_at DESC
      LIMIT ${lim}`,
  );
  return rows;
}

module.exports = {
  isActivationEnabled,
  getStatus,
  getImpact,
  setForwardEnabled,
  applyMigrations,
  recalcApply,
  restoreBatch,
  listBatches,
  // exportados para pruebas / referencia del contrato
  evalGoNoGo,
  assertGoNoGo,
  MIGRATE_UPTO,
  MAX_RANGE_DAYS,
  REQUIRED_MIGRATIONS,
  CONSOLE_MIGRATION,
  VALID_SCOPES,
  MUTABLE_FIELDS,
};
