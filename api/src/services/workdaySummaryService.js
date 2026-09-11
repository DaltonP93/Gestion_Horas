/**
 * workdaySummaryService.js — El ÚNICO camino de escritura de daily_summary
 * basado en el motor.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ CIERRA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Antes había DOS matemáticas: Marcadas pasaba por WorkdayEngine, pero
 * `recalcDailySummary` (operativo) calculaba por su cuenta —fecha civil, first
 * IN/last OUT propios, sábado/domingo hardcodeado, employees.schedule_id
 * ACTUAL—. Dos algoritmos sobre los mismos datos dan dos respuestas.
 *
 * Este servicio deja UN solo camino:
 *
 *   attendance_logs → WorkdayEngine → dailySummaryEngine → writer
 *
 * Reutiliza EXACTAMENTE el motor que usa Marcadas. No duplica first_in,
 * last_out, worked_minutes, late_minutes, break_minutes ni status.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * UNA MARCA PUEDE AFECTAR EL DÍA LABORAL ANTERIOR
 * ═══════════════════════════════════════════════════════════════════════
 *
 * No se recalcula `DATE(timestamp)` como única fecha. Un OUT de madrugada
 * (02/12 07:04) cierra una jornada que empezó el día anterior (01/12). Por eso
 * las fechas afectadas por una marca en `anchorDate` son {anchorDate-1,
 * anchorDate, anchorDate+1}: una jornada se fecha por su PRIMERA entrada, así
 * que la marca en sí pertenece a la del ancla o a la anterior, pero una marca
 * cargada FUERA DE ORDEN puede absorber una huérfana que ya se materializó como
 * fila del día siguiente, y esa fila obsoleta también debe reconciliarse (ver
 * el detalle en resolveSummary). Se lee una ventana ampliada (punchWindow) para
 * no truncar la jornada nocturna, y se recalculan esas tres fechas.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ESCRITURA CONTROLADA POR FLAG (default OFF)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `resolveSummary` es puro-lectura: devuelve las filas y las fechas afectadas.
 * Sólo escribe cuando el caller pide APPLY. En producción el flag
 * WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED arranca en OFF: el recalc operativo
 * conserva su comportamiento legacy hasta habilitar el rollout, y el
 * dry-run/auditor puede ejercitar este camino sin escribir.
 */

'use strict';

const { sequelize } = require('../config/database');
const engine = require('./workdayEngine');
const dsEngine = require('./dailySummaryEngine');
const { loadWorkdayConfig } = require('./workdayConfig');
const { withDayRecalcLock } = require('./recalcLock');
const { dbDateISO } = require('../utils/dbTime');

/**
 * Cerrojo de OPERACIONES (env): kill-switch del escritor hacia adelante del
 * motor. Sólo el string exacto 'true' habilita. Es la mitad que ops controla
 * sin tocar la base y que no se puede togglear desde un request.
 */
function isEngineSummaryWriteEnabled() {
  return process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED === 'true';
}

/** Clave del segundo cerrojo (BD) del escritor hacia adelante (migración 083). */
const FORWARD_SETTING_KEY = 'fase_e_forward_enabled';

/**
 * Cerrojo de APLICACIÓN (BD): el setting que la consola de FASE E flipea de
 * forma controlada y reversible con un click, sin reiniciar el proceso.
 *
 * Fail-closed: cualquier valor que no sea exactamente 'true' —fila ausente,
 * NULL, 'false', '1', o un error de lectura— cuenta como DESHABILITADO. La
 * tabla system_settings puede no existir todavía (083 sin aplicar): ahí también
 * devuelve false sin propagar el error, porque "aún no migrado" debe ser
 * fail-closed, no una excepción que rompa el recálculo operativo.
 */
async function isForwardSettingEnabled() {
  try {
    const [rows] = await sequelize.query(
      `SELECT value FROM system_settings WHERE key_name = ? LIMIT 1`,
      { replacements: [FORWARD_SETTING_KEY] },
    );
    return String(rows[0]?.value ?? '') === 'true';
  } catch {
    return false;
  }
}

/**
 * Compuerta REAL del escritor hacia adelante: exige AMBOS cerrojos.
 *   env kill-switch === 'true'  AND  setting de BD === 'true'
 *
 * Con cualquiera de los dos en false, el recálculo operativo conserva su camino
 * LEGACY (comportamiento actual intacto). El env sigue siendo el kill-switch de
 * ops; el setting de BD es el flip controlado de la consola.
 */
async function isEngineForwardWriteEnabled() {
  if (!isEngineSummaryWriteEnabled()) return false; // corto-circuito sin tocar BD
  return isForwardSettingEnabled();
}

/** Fecha civil (wall-clock) de la marca ancla, en aritmética sin zona. */
function anchorDateISO(anchor) {
  // Acepta el string wall-clock persistido o un Date; dbDateISO deshace la
  // conversión del driver si viniera un Date.
  return dbDateISO(anchor) || (typeof anchor === 'string' ? anchor.slice(0, 10) : null);
}

/** Suma `dias` a una fecha 'YYYY-MM-DD' en aritmética de pared. */
function shiftDate(dateISO, dias) {
  const w = engine.toWall(`${dateISO} 00:00:00`);
  return engine.absToDateISO(w.abs + dias * 86400);
}

/**
 * ¿Está aplicada la migración 074 (ENUM con 'non_working' y 'unconfigured')?
 *
 * Es una condición de ESQUEMA, no la del flag de escritura: 074 puede aplicarse
 * antes o después de habilitar el writer. Mientras 074 NO esté aplicada, escribir
 * esos valores rompería el INSERT (el ENUM no los admite), así que se colapsan a
 * los valores clásicos. Con 074 aplicada, se persisten como corresponde.
 */
function isStatus074Enabled() {
  return process.env.WORKDAY_ENGINE_STATUS_074_ENABLED === 'true';
}

/**
 * Estados que emite el motor → ENUM de daily_summary.
 *
 * `non_working` y `unconfigured` sólo existen en el ENUM con la migración 074
 * aplicada (ver isStatus074Enabled):
 *   - non_working  → 'non_working' con 074; si no, 'weekend' (el valor clásico
 *     más cercano para un día no laborable).
 *   - unconfigured → 'unconfigured' con 074; si no, null → el caller reconcilia
 *     la fila (no se inventa una para un día del que no sabemos nada).
 */
function statusParaDb(status) {
  const con074 = isStatus074Enabled();
  switch (status) {
    case dsEngine.STATUS.PRESENT: return 'present';
    case dsEngine.STATUS.LATE: return 'late';
    case dsEngine.STATUS.ABSENT: return 'absent';
    case dsEngine.STATUS.PERMISSION: return 'permission';
    case dsEngine.STATUS.HOLIDAY: return 'holiday';
    case dsEngine.STATUS.WEEKEND: return 'weekend';
    case dsEngine.STATUS.NON_WORKING: return con074 ? 'non_working' : 'weekend';
    case dsEngine.STATUS.UNCONFIGURED: return con074 ? 'unconfigured' : null;
    default: return null;
  }
}

/**
 * Lee marcajes wall-clock de un empleado en la ventana [from, to] ampliada.
 * DATE_FORMAT devuelve la hora de pared cruda, independiente de la zona del
 * driver, que es lo que el motor necesita.
 */
async function leerMarcajes(employeeId, ventana) {
  const [rows] = await sequelize.query(`
    SELECT al.id,
           DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
           al.type
    FROM attendance_logs al
    WHERE al.employee_id = ?
      AND al.timestamp >= ? AND al.timestamp < ?
    ORDER BY al.timestamp, al.id
  `, { replacements: [employeeId, ventana.from, ventana.to] });
  return rows;
}

/** Feriados activos dentro de [from, to] como Set de 'YYYY-MM-DD'. */
async function leerFeriados(from, to) {
  const [rows] = await sequelize.query(
    `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM holidays WHERE active = 1 AND date >= ? AND date <= ?`,
    { replacements: [from, to] },
  );
  return new Set(rows.map((r) => r.d));
}

/**
 * Calcula (y opcionalmente escribe) las filas de daily_summary afectadas por
 * una marca del empleado.
 *
 * @param {number} employeeId
 * @param {string|Date} anchor  timestamp wall-clock de la marca que disparó el recalc.
 * @param {object} [opts]
 *        - `apply`  escribir en daily_summary (por defecto false).
 * @returns {Promise<{ rows: Array, affectedDates: string[] }>}
 */
async function resolveSummary(employeeId, anchor, opts = {}) {
  const apply = opts.apply === true;
  const anchorISO = anchorDateISO(anchor);
  if (!anchorISO) throw new Error(`Ancla de recalc inválida: ${anchor}`);

  // Fechas afectadas: {anchorDate-1, anchorDate, anchorDate+1}.
  //   · anchorDate-1: una jornada nocturna que empezó ayer se cierra hoy;
  //   · anchorDate:   la jornada de la propia marca;
  //   · anchorDate+1: aunque una jornada NUNCA se fecha en el futuro, una marca
  //     cargada fuera de orden puede ABSORBER una huérfana que ya se materializó
  //     como fila del día siguiente. Ej.: primero se guarda el OUT del 21 02:00
  //     (fila del 21 con actividad); al cargar después el IN del 20 22:00, la
  //     jornada correcta es del 20 y la fila del 21 queda obsoleta. Reconciliar
  //     anchorDate+1 la limpia en vez de duplicar la actividad en KPI/reportes.
  const from = shiftDate(anchorISO, -1);
  const to = shiftDate(anchorISO, 1);

  const ventana = engine.punchWindow({ from, to });
  const [punches, config, holidays] = await Promise.all([
    leerMarcajes(employeeId, ventana),
    loadWorkdayConfig([employeeId], { from, to }),
    leerFeriados(from, to),
  ]);

  const rows = dsEngine.buildDailySummaryRows(punches, {
    from,
    to,
    holidays,
    resolveConfig: (workDate) => config.forDate(employeeId, workDate),
    materializeEmptyDates: true,
  });

  const affectedDates = rows.map((r) => r.date);

  // anchorDate+1 es RECONCILE-ONLY: la marca del ancla nunca pertenece a una
  // jornada fechada en el futuro, así que esa fecha jamás debe INSERTAR una
  // fila nueva (materializar un día vacío ahí fabricaría una ausencia futura en
  // KPI/reportes). Sólo se usa para ACTUALIZAR o BORRAR una fila obsoleta que un
  // recalc anterior pudo materializar (la huérfana absorbida). Se pasa como set
  // de fechas donde el writer sólo reconcilia lo ya existente.
  const reconcileOnly = new Set([shiftDate(anchorISO, 1)]);

  if (apply) await escribirFilas(employeeId, rows, { reconcileOnly });

  return { rows, affectedDates };
}

// ═══════════════════════════════════════════════════════════════════════════
// [B3] SEMÁNTICA DE ESCRITURA — FUNCIÓN PURA COMPARTIDA
//
// `effectiveDailySummary` es la ÚNICA fuente de verdad de QUÉ persiste el writer
// para un par (fila engine, fila previa guardada). La usan por igual el WRITER
// (escribirFilas / la consola de FASE E) y el PREVIEW/DIGEST, para que el preview
// anuncie EXACTAMENTE lo que se escribirá — nunca un cambio de status que el
// writer luego preserva por una justificación manual.
// ═══════════════════════════════════════════════════════════════════════════

/** Los 8 campos mutables persistidos (el orden es el del INSERT/UPDATE). */
const WRITE_FIELDS = ['first_in', 'last_out', 'worked_minutes', 'break_minutes', 'overtime_minutes', 'late_minutes', 'notes', 'status'];

/** ¿La fila previa tiene una JUSTIFICACIÓN MANUAL (que el motor no conoce)? */
function hasManualJustification(storedRow) {
  return !!storedRow && (storedRow.justification != null || storedRow.justification_type != null);
}
/** Estado DERIVADO de una justificación manual: injustificada → absent; resto → permission. */
function derivedJustificationStatus(storedRow) {
  return String(storedRow?.justification_type || '') === 'injustificada' ? 'absent' : 'permission';
}

/**
 * [B3] Resultado EFECTIVO que el writer persistirá para (engineRow, storedRow).
 * Devuelve { action: 'insert'|'update'|'delete'|'noop', row? } con la fila EXACTA
 * (los 8 campos) que quedaría en daily_summary. Reproduce, en JS puro, la
 * semántica que antes vivía en el SQL (status null → borrar o preservar la
 * justificación con minutos en cero; día vacío con justificación manual → estado
 * derivado; reconcileOnly nunca inserta).
 */
function effectiveDailySummary(engineRow, storedRow, opts = {}) {
  const reconcileOnly = opts.reconcileOnly === true;
  const status = statusParaDb(engineRow.status);
  if (status == null) {
    // unconfigured: sin evidencia de jornada. Una fila con justificación manual
    // sobrevive con su estado derivado y minutos en cero; el resto se borra.
    if (!storedRow) return { action: 'noop' };
    // Reconcile: la fila justificada NUNCA se recrea si desapareció (updateOnly).
    if (hasManualJustification(storedRow)) {
      return {
        action: 'update', updateOnly: true,
        row: { first_in: null, last_out: null, worked_minutes: 0, break_minutes: 0, overtime_minutes: 0, late_minutes: 0, notes: null, status: derivedJustificationStatus(storedRow) },
      };
    }
    return { action: 'delete' };
  }
  // ¿día SIN jornada real? Sólo ahí una justificación manual gana sobre el status.
  const esDiaVacio = (engineRow.workday_count || 0) === 0;
  const effStatus = (esDiaVacio && hasManualJustification(storedRow)) ? derivedJustificationStatus(storedRow) : status;
  const row = {
    first_in: engineRow.first_in || null,
    last_out: engineRow.last_out || null,
    worked_minutes: engineRow.worked_minutes || 0,
    break_minutes: engineRow.break_minutes || 0,
    overtime_minutes: engineRow.overtime_minutes || 0,
    late_minutes: engineRow.late_minutes || 0,
    notes: engineRow.notes || null,
    status: effStatus,
  };
  // reconcileOnly (anchorDate+1): jamás inserta una fila nueva; sólo actualiza la
  // existente (updateOnly). Sin fila previa → noop.
  if (reconcileOnly) return storedRow ? { action: 'update', updateOnly: true, row } : { action: 'noop' };
  return { action: storedRow ? 'update' : 'insert', row };
}

/** Normaliza una fila guardada a los 8 campos, para comparar / clasificar. */
function normalizeStoredForWrite(storedRow) {
  if (!storedRow) return null;
  return {
    first_in: storedRow.first_in || null,
    last_out: storedRow.last_out || null,
    worked_minutes: Number(storedRow.worked_minutes || 0),
    break_minutes: Number(storedRow.break_minutes || 0),
    overtime_minutes: Number(storedRow.overtime_minutes || 0),
    late_minutes: Number(storedRow.late_minutes || 0),
    notes: storedRow.notes || null,
    status: storedRow.status || null,
  };
}

/**
 * Clasifica el efecto de aplicar `eff` sobre `storedRow`, para conteos
 * inequívocos: 'inserted' | 'updated' | 'deleted' | 'unchanged'. Un 'update' cuyo
 * resultado sea idéntico al estado previo cuenta como 'unchanged' (no muta nada).
 */
function classifyEffective(eff, storedRow) {
  if (eff.action === 'insert') return 'inserted';
  if (eff.action === 'delete') return storedRow ? 'deleted' : 'unchanged';
  if (eff.action === 'noop') return 'unchanged';
  // update
  const s = normalizeStoredForWrite(storedRow);
  if (!s) return 'updated';
  const same = WRITE_FIELDS.every((f) => (eff.row[f] ?? null) === (s[f] ?? null));
  return same ? 'unchanged' : 'updated';
}

/**
 * Lee la fila previa de daily_summary para (empleado, fecha) DENTRO de la
 * transacción/lock del caller. `FOR UPDATE` lee la ÚLTIMA versión committeada y
 * bloquea la fila: hace que la verificación de estado previo sea real (no de un
 * snapshot MVCC viejo) y que ningún writer concurrente la cambie hasta el commit.
 */
async function readDailySummaryRow(t, employeeId, date) {
  const [rows] = await sequelize.query(
    `SELECT DATE_FORMAT(first_in,'%Y-%m-%d %H:%i:%s') AS first_in,
            DATE_FORMAT(last_out,'%Y-%m-%d %H:%i:%s') AS last_out,
            worked_minutes, break_minutes, overtime_minutes, late_minutes, notes, status,
            justification, justification_type
       FROM daily_summary WHERE employee_id = ? AND date = ? FOR UPDATE`,
    { replacements: [employeeId, date], transaction: t },
  );
  return rows[0] || null;
}

/**
 * Aplica el resultado EFECTIVO ya calculado, dentro de la transacción `t` del
 * caller (que YA sostiene el lock de la fecha). El status/valores vienen resueltos
 * por `effectiveDailySummary`, así que el SQL es plano (sin CASE): una sola fuente
 * de semántica. `reconcileOnly` fuerza UPDATE puro (nunca recrea una fila borrada).
 */
async function applyEffectiveWrite(t, employeeId, date, eff) {
  if (eff.action === 'noop') return;
  if (eff.action === 'delete') {
    await sequelize.query('DELETE FROM daily_summary WHERE employee_id = ? AND date = ?', { replacements: [employeeId, date], transaction: t });
    return;
  }
  const r = eff.row;
  // updateOnly (reconcile / status-null justificado): jamás recrea una fila; sólo
  // actualiza la existente (no-op si desapareció). No usa upsert.
  if (eff.action === 'update' && eff.updateOnly === true) {
    await sequelize.query(
      `UPDATE daily_summary SET first_in = ?, last_out = ?, worked_minutes = ?, break_minutes = ?,
              overtime_minutes = ?, late_minutes = ?, notes = ?, status = ?
         WHERE employee_id = ? AND date = ?`,
      { replacements: [r.first_in, r.last_out, r.worked_minutes, r.break_minutes, r.overtime_minutes, r.late_minutes, r.notes, r.status, employeeId, date], transaction: t },
    );
    return;
  }
  // insert o update normal: upsert idempotente. La clasificación bajo el lock ya
  // decidió insert/update; el ON DUPLICATE sólo cubre una carrera imposible.
  await sequelize.query(
    `INSERT INTO daily_summary (employee_id, date, first_in, last_out, worked_minutes, break_minutes, overtime_minutes, late_minutes, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE first_in = VALUES(first_in), last_out = VALUES(last_out),
       worked_minutes = VALUES(worked_minutes), break_minutes = VALUES(break_minutes),
       overtime_minutes = VALUES(overtime_minutes), late_minutes = VALUES(late_minutes),
       notes = VALUES(notes), status = VALUES(status)`,
    { replacements: [employeeId, date, r.first_in, r.last_out, r.worked_minutes, r.break_minutes, r.overtime_minutes, r.late_minutes, r.notes, r.status], transaction: t },
  );
}

/**
 * Escribe las filas de UN empleado en daily_summary, cada una bajo su lock de
 * fecha. Reutiliza la semántica compartida: lee la fila previa (FOR UPDATE),
 * calcula el resultado EFECTIVO con `effectiveDailySummary` y lo aplica. Así el
 * writer y el preview comparten exactamente la misma lógica.
 *
 * `opts.reconcileOnly` es un Set de fechas donde NO se puede INSERTAR una fila
 * nueva: sólo se actualiza/borra la que ya exista.
 */
async function escribirFilas(employeeId, rows, opts = {}) {
  const reconcileOnly = opts.reconcileOnly || new Set();
  for (const row of rows) {
    const soloReconciliar = reconcileOnly.has(row.date);
    await withDayRecalcLock(row.date, async (t) => {
      const stored = await readDailySummaryRow(t, employeeId, row.date);
      const eff = effectiveDailySummary(row, stored, { reconcileOnly: soloReconciliar });
      await applyEffectiveWrite(t, employeeId, row.date, eff, { reconcileOnly: soloReconciliar });
    }, { label: `engineRecalc:${row.date}:${employeeId}` });
  }
}

/**
 * Recálculo en bloque para una fecha, POR LOTE de empleados.
 *
 * Lee marcajes, feriados y configuración UNA sola vez para todo el lote (no por
 * empleado): loadWorkdayConfig ya acepta un array de ids y resuelve en memoria.
 * Así un reproceso de cientos de empleados por decenas de días no dispara miles
 * de viajes a la base. Incluye a los empleados SIN marcas para materializar sus
 * días vacíos desde la config histórica.
 *
 * @param {number[]} employeeIds
 * @param {string} date  fecha objetivo 'YYYY-MM-DD'.
 * @param {object} [opts] - `apply` escribir (por defecto false).
 * @returns {Promise<{ rowsByEmployee: Map<number, Array> }>}
 */
async function resolveSummaryBatchForDate(employeeIds, date, opts = {}) {
  const apply = opts.apply === true;
  const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { rowsByEmployee: new Map() };

  const from = shiftDate(date, -1);
  const to = date;
  const ventana = engine.punchWindow({ from, to });

  // Una lectura de marcajes para TODO el lote; una carga de config; un set de
  // feriados. El resto se resuelve en memoria.
  const [todosPunches, config, holidays] = await Promise.all([
    leerMarcajesLote(ids, ventana),
    loadWorkdayConfig(ids, { from, to }),
    leerFeriados(from, to),
  ]);

  const porEmpleado = new Map();
  for (const p of todosPunches) {
    const arr = porEmpleado.get(p.employee_id) || [];
    arr.push(p);
    porEmpleado.set(p.employee_id, arr);
  }

  const rowsByEmployee = new Map();
  for (const employeeId of ids) {
    const rows = dsEngine.buildDailySummaryRows(porEmpleado.get(employeeId) || [], {
      from,
      to,
      holidays,
      resolveConfig: (workDate) => config.forDate(employeeId, workDate),
      materializeEmptyDates: true,
    });
    rowsByEmployee.set(employeeId, rows);
    if (apply) await escribirFilas(employeeId, rows);
  }

  return { rowsByEmployee };
}

/**
 * [P1-F] Aplica filas del motor YA RESUELTAS, SIN recomputarlas.
 *
 * Es la primitiva que la consola de FASE E usa para escribir EXACTAMENTE el plan
 * que previamente resolvió y validó con plan_digest, sin un segundo
 * `resolveSummaryBatchForDate(..., {apply:true})` que releería datos vivos y
 * podría persistir algo distinto del preview.
 *
 * Reutiliza el ÚNICO escritor real (`escribirFilas`) con TODA su semántica: status
 * null → borrar/preservar justificación, preservación de justificación manual en
 * día vacío, los 8 campos mutables y el lock por fecha (last-write-wins). NO
 * duplica ni una línea de SQL del writer. Las `rows` deben ser las filas engine
 * tal como las devolvió `resolveSummary*` (con `status` engine, `workday_count`,
 * `first_in`, `last_out`, minutos y `notes`).
 *
 * @param {number} employeeId
 * @param {Array}  rows        filas engine ya resueltas (el plan validado).
 * @param {object} [opts]      `reconcileOnly` (Set de fechas), igual que escribirFilas.
 */
async function applyResolvedRows(employeeId, rows, opts = {}) {
  await escribirFilas(employeeId, rows, opts);
}

/** Marcajes wall-clock de VARIOS empleados en la ventana. */
async function leerMarcajesLote(employeeIds, ventana) {
  const marcas = employeeIds.map(() => '?').join(',');
  const [rows] = await sequelize.query(`
    SELECT al.employee_id, al.id,
           DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
           al.type
    FROM attendance_logs al
    WHERE al.employee_id IN (${marcas})
      AND al.timestamp >= ? AND al.timestamp < ?
    ORDER BY al.employee_id, al.timestamp, al.id
  `, { replacements: [...employeeIds, ventana.from, ventana.to] });
  return rows;
}

module.exports = {
  isEngineSummaryWriteEnabled,
  isForwardSettingEnabled,
  isEngineForwardWriteEnabled,
  FORWARD_SETTING_KEY,
  isStatus074Enabled,
  resolveSummary,
  resolveSummaryBatchForDate,
  applyResolvedRows,
  statusParaDb,
  anchorDateISO,
  shiftDate,
  // [B1/B3] semántica de escritura compartida (writer ↔ preview ↔ consola FASE E)
  effectiveDailySummary,
  classifyEffective,
  readDailySummaryRow,
  applyEffectiveWrite,
  hasManualJustification,
  derivedJustificationStatus,
  WRITE_FIELDS,
};
