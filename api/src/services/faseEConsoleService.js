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
 * servicio pone la matemática y la REVERSIBILIDAD:
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
 */

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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

// Columnas MUTABLES que el escritor del motor puede cambiar (las que respalda y
// restaura el batch): first_in, last_out, worked_minutes, break_minutes,
// late_minutes, overtime_minutes, status, notes. schedule_id/justification NO
// las toca el escritor, por eso el RESTORE no necesita reponerlas.

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
 * Estado COMPLETO de solo lectura para la consola: migraciones, esquema,
 * cerrojos (env + BD) y un GO/NO-GO advisory. No modifica nada.
 */
async function getStatus() {
  const historyExists = await tableExists('employee_schedule_history');
  const migrations = await migrationStatus();
  const has074 = await dailyStatusHas074();
  const backupTablesReady =
    (await tableExists('daily_summary_recalc_batch')) &&
    (await tableExists('daily_summary_backup'));

  let historyRows = null;
  if (historyExists) {
    const [[c]] = await sequelize.query('SELECT COUNT(*) AS n FROM employee_schedule_history');
    historyRows = Number(c?.n || 0);
  }

  const engineMigrationsApplied = REQUIRED_MIGRATIONS.every(
    (m) => migrations.find((x) => x.filename === m)?.recorded,
  );

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
    engine_migrations_applied: engineMigrationsApplied,
    console_migration_applied: migrations.find((x) => x.filename === CONSOLE_MIGRATION)?.recorded || false,
    daily_summary_status_has_074: has074,
    backup_tables_ready: backupTablesReady,
    employee_schedule_history: { exists: historyExists, rows: historyRows },
    gates,
    // GO/NO-GO advisory: es seguro activar el motor hacia adelante sólo si el
    // esquema del motor está aplicado. NO es una autorización: la ejecuta el
    // dueño con la doble compuerta.
    go_no_go: {
      schema_ready: engineMigrationsApplied && has074,
      forward_ready_to_flip: engineMigrationsApplied && has074 && envKillSwitch && backupTablesReady,
      note: 'Advisory. La activación real exige master-flag + confirmación tipeada + backup.',
    },
  };
}

// ─── alcance de empleados ────────────────────────────────────────────────
async function resolveEmployeeIds(scopeKind, scopeId) {
  if (scopeKind === 'employee') {
    const id = Number(scopeId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('scopeId (employee) inválido');
    return [id];
  }
  if (scopeKind === 'department') {
    const id = Number(scopeId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('scopeId (department) inválido');
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

function badRequest(message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

function validateRange(from, to) {
  if (!validDate(from) || !validDate(to) || from > to) {
    throw badRequest('from/to deben ser YYYY-MM-DD válidas con from <= to', 'INVALID_RANGE');
  }
  if (rangeDays(from, to) > MAX_RANGE_DAYS) {
    throw badRequest(`El rango excede el máximo de ${MAX_RANGE_DAYS} días`, 'RANGE_TOO_WIDE');
  }
}

// ─── impacto / dry-run (SOLO LECTURA) ────────────────────────────────────
async function loadStoredForDate(ids, date) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += EMP_CHUNK) {
    const chunk = ids.slice(i, i + EMP_CHUNK);
    const [rows] = await sequelize.query(
      `SELECT employee_id, DATE_FORMAT(date,'%Y-%m-%d') AS date,
              DATE_FORMAT(first_in,'%Y-%m-%d %H:%i:%s') AS first_in,
              DATE_FORMAT(last_out,'%Y-%m-%d %H:%i:%s') AS last_out,
              worked_minutes, late_minutes, status
         FROM daily_summary
        WHERE employee_id IN (${chunk.map(() => '?').join(',')}) AND date = ?`,
      { replacements: [...chunk, date] },
    );
    for (const r of rows) map.set(r.employee_id, r);
  }
  return map;
}

function rowDiffers(motor, stored) {
  if (!stored) return true; // el motor produce fila donde no había
  const mStatus = workdaySummary.statusParaDb(motor.status);
  if ((mStatus || '') !== (stored.status || '')) return true;
  if ((motor.worked_minutes || 0) !== (stored.worked_minutes || 0)) return true;
  if ((motor.late_minutes || 0) !== (stored.late_minutes || 0)) return true;
  if ((motor.first_in || null) !== (stored.first_in || null)) return true;
  if ((motor.last_out || null) !== (stored.last_out || null)) return true;
  return false;
}

/**
 * Impacto dry-run: cuántas filas de daily_summary DIFERIRÍAN entre lo guardado
 * (legacy) y el motor para el rango/alcance, SIN escribir. Devuelve conteos y
 * ejemplos (sin PII: sólo employee_id, fecha y los campos comparados).
 */
async function getImpact({ from, to, scopeKind = 'all', scopeId = null, maxExamples = 50 }) {
  validateRange(from, to);
  const ids = await resolveEmployeeIds(scopeKind, scopeId);

  const report = {
    read_only: true,
    period: { from, to },
    scope: { kind: scopeKind, id: scopeId ?? null },
    employees: ids.length,
    dates_evaluated: 0,
    rows_evaluated: 0,
    rows_differ: 0,
    rows_new: 0,
    examples: [],
  };
  if (!ids.length) return report;

  for (const d of eachDate(from, to)) {
    report.dates_evaluated++;
    const { rowsByEmployee } = await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: false });
    const stored = await loadStoredForDate(ids, d);
    for (const [emp, rows] of rowsByEmployee) {
      for (const row of rows) {
        if (row.date !== d) continue; // sólo la fecha primaria del día evaluado
        report.rows_evaluated++;
        const st = stored.get(emp);
        if (rowDiffers(row, st)) {
          report.rows_differ++;
          if (!st) report.rows_new++;
          if (report.examples.length < maxExamples) {
            report.examples.push({
              employee_id: emp,
              date: d,
              motor: {
                status: workdaySummary.statusParaDb(row.status),
                worked_minutes: row.worked_minutes || 0,
                late_minutes: row.late_minutes || 0,
              },
              stored: st ? {
                status: st.status,
                worked_minutes: st.worked_minutes || 0,
                late_minutes: st.late_minutes || 0,
              } : null,
            });
          }
        }
      }
    }
  }
  return report;
}

// ─── activación hacia adelante (reversible, un click) ────────────────────
/** Flip del setting de BD fase_e_forward_enabled. Reversible sin reiniciar. */
async function setForwardEnabled(enabled) {
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
 * Aplica las migraciones pendientes del motor HASTA 075 con el runner real,
 * acotadas con --upto para no arrastrar 083+ en el mismo paso. Devuelve la
 * salida del runner y el estado posterior. Sólo se invoca detrás del master-flag.
 */
function applyMigrations() {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'migrate.js');
  const res = spawnSync(process.execPath, [script, `--upto=${MIGRATE_UPTO}`], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: process.env,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  const ok = res.status === 0;
  return {
    ok,
    upto: MIGRATE_UPTO,
    exit_code: res.status,
    stdout: (res.stdout || '').slice(-8000),
    stderr: (res.stderr || '').slice(-4000),
  };
}

// ─── recálculo histórico acotado, REVERSIBLE ─────────────────────────────
/**
 * Enumera las celdas (employee, date) que el recálculo del rango escribiría.
 * El escritor por fecha toca {date-1, date}, así que la unión sobre el rango es
 * [from-1, to]; enumerar por dry-run da el conjunto EXACTO, incluidas las filas
 * que se crearían (para poder borrarlas en el RESTORE).
 */
async function enumerateTargets(ids, from, to) {
  const cells = new Map(); // "emp|date" → {emp, date}
  for (const d of eachDate(from, to)) {
    const { rowsByEmployee } = await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: false });
    for (const [emp, rows] of rowsByEmployee) {
      for (const row of rows) {
        const key = `${emp}|${row.date}`;
        if (!cells.has(key)) cells.set(key, { emp, date: row.date });
      }
    }
  }
  return [...cells.values()];
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
 * Recálculo histórico ACOTADO y REVERSIBLE.
 *
 * Secuencia (fail-safe):
 *   1. enumerar celdas objetivo por DRY-RUN (sin escribir);
 *   2. RESPALDAR el estado PREVIO de cada celda ANTES de tocar nada
 *      (existed=0 marca las que el recálculo creará → el RESTORE las borra);
 *   3. registrar la cabecera del lote;
 *   4. recién entonces APLICAR el recálculo por el motor.
 *
 * Si el paso 2 fallara, no se escribió una sola fila de daily_summary.
 */
async function recalcApply({ from, to, scopeKind = 'all', scopeId = null, userId = null }) {
  validateRange(from, to);
  const ids = await resolveEmployeeIds(scopeKind, scopeId);
  const batchId = crypto.randomUUID();

  if (!ids.length) {
    return { batch_id: null, employees: 0, rows_backed_up: 0, rows_written: 0, note: 'Sin empleados en alcance' };
  }

  // 1. celdas objetivo exactas (incluye [from-1] por la ventana nocturna).
  const targets = await enumerateTargets(ids, from, to);

  // 2. respaldo del estado previo. La unión de celdas escritas cabe en el span
  //    [from-1, to]; una sola lectura por chunk de empleados.
  const spanFrom = workdaySummary.shiftDate(from, -1);
  const existing = await loadExistingRows(ids, spanFrom, to);

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
    // 13 columnas por fila (batch_id + 12).
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

  for (const cell of targets) {
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

  // 3. cabecera del lote (queda ANTES de aplicar; si algo falla, el respaldo ya
  //    está y el RESTORE es posible).
  await sequelize.query(
    `INSERT INTO daily_summary_recalc_batch
       (batch_id, from_date, to_date, scope_kind, scope_id, status, employees, rows_backed_up, rows_written, created_by)
     VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, 0, ?)`,
    { replacements: [batchId, from, to, scopeKind, scopeId ?? null, ids.length, rowsBackedUp, userId ?? null] },
  );

  // 4. aplicar el recálculo real por el motor, fecha por fecha.
  for (const d of eachDate(from, to)) {
    await workdaySummary.resolveSummaryBatchForDate(ids, d, { apply: true });
  }

  const rowsWritten = targets.length;
  await sequelize.query(
    `UPDATE daily_summary_recalc_batch SET rows_written = ? WHERE batch_id = ?`,
    { replacements: [rowsWritten, batchId] },
  );

  return {
    batch_id: batchId,
    period: { from, to },
    scope: { kind: scopeKind, id: scopeId ?? null },
    employees: ids.length,
    rows_backed_up: rowsBackedUp,
    rows_written: rowsWritten,
  };
}

/**
 * RESTORE por batch_id: repone el estado PREVIO de cada celda respaldada.
 *   · existed=1 → UPSERT de las columnas mutables originales;
 *   · existed=0 → DELETE (la fila la había creado el recálculo).
 * Idempotente respecto del estado: re-restaurar deja el mismo resultado, pero
 * un lote ya 'restored' se rechaza para no confundir la trazabilidad.
 */
async function restoreBatch({ batchId, userId = null }) {
  const [[batch]] = await sequelize.query(
    `SELECT batch_id, status FROM daily_summary_recalc_batch WHERE batch_id = ? LIMIT 1`,
    { replacements: [batchId] },
  );
  if (!batch) throw badRequest('batch_id inexistente', 'BATCH_NOT_FOUND');
  if (batch.status === 'restored') throw badRequest('El lote ya fue restaurado', 'BATCH_ALREADY_RESTORED');

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
  }

  await sequelize.query(
    `UPDATE daily_summary_recalc_batch
        SET status = 'restored', restored_by = ?, restored_at = NOW()
      WHERE batch_id = ?`,
    { replacements: [userId ?? null, batchId] },
  );

  return { batch_id: batchId, rows_restored: restored, rows_deleted: deleted };
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
  MIGRATE_UPTO,
  MAX_RANGE_DAYS,
  REQUIRED_MIGRATIONS,
  CONSOLE_MIGRATION,
};
