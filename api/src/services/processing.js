/**
 * processing.js
 * Recalcula `daily_summary` para un rango de fechas y (opcionalmente) un
 * subconjunto de empleados, emitiendo progreso por Socket.io.
 *
 * Evento emitido: 'processing:progress'
 *   { jobId, date, employeeId, done, total, percent, stage }
 *
 * Uso típico: POST /api/processing/recompute { dateFrom, dateTo, employeeIds? }
 */

const { sequelize } = require('../config/database');
const { recalcDailySummary } = require('../controllers/attendanceController');
const { bulkRecalcDailySummary } = require('./scheduler');
const logger = require('../config/logger');

function daysInRange(dateFrom, dateTo) {
  const out = [];
  const d = new Date(dateFrom + 'T00:00:00');
  const end = new Date(dateTo + 'T00:00:00');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Recalcula daily_summary para cada (empleado, fecha) en el rango.
 * Solo procesa empleados que tienen al menos un marcaje ese día.
 */
async function recomputeRange({ dateFrom, dateTo, employeeIds = null, jobId, io }) {
  if (!dateFrom || !dateTo) throw new Error('dateFrom y dateTo son requeridos (YYYY-MM-DD)');
  if (dateFrom > dateTo) throw new Error('dateFrom debe ser <= dateTo');

  const emit = (stage, payload) => {
    if (!io) return;
    io.emit('processing:progress', { jobId, stage, ...payload });
  };

  emit('start', { dateFrom, dateTo, employeeIds });

  const hasEmployeeFilter = Array.isArray(employeeIds) && employeeIds.length > 0;

  // ── Vía rápida (sin filtro de empleados): recalcular por DÍA con una
  //    única sentencia set-based (bulkRecalcDailySummary), en vez de una
  //    llamada por cada par (empleado, día). Reduce miles de queries a una
  //    por día del rango. ──────────────────────────────────────────────
  if (!hasEmployeeFilter) {
    const days = daysInRange(dateFrom, dateTo);
    const total = days.length;
    logger.info(`[processing:${jobId}] recompute ${dateFrom}..${dateTo} — ${total} día(s) (set-based)`);
    let done = 0, errors = 0;
    const errList = [];
    for (const d of days) {
      try {
        await bulkRecalcDailySummary(d);
      } catch (err) {
        errors++;
        if (errList.length < 20) errList.push({ date: d, error: err.message });
      }
      done++;
      emit('progress', { done, total, percent: total ? Math.round((done / total) * 100) : 100, date: d });
    }
    emit('done', { done, total, errors });
    return { dateFrom, dateTo, days: total, processed: done, errors, errList };
  }

  // ── Con filtro de empleados: recalcular solo esos (empleado, día) que
  //    tienen marcajes. Consulta sargable (rango en vez de DATE(ts)). ──
  let where = 'al.timestamp >= ? AND al.timestamp < DATE_ADD(?, INTERVAL 1 DAY)';
  const replacements = [dateFrom, dateTo];
  where += ` AND al.employee_id IN (${employeeIds.map(() => '?').join(',')})`;
  replacements.push(...employeeIds);

  const [rows] = await sequelize.query(`
    SELECT DISTINCT al.employee_id, DATE(al.timestamp) AS d
    FROM attendance_logs al
    WHERE ${where}
    ORDER BY d, al.employee_id
  `, { replacements });

  const total = rows.length;
  logger.info(`[processing:${jobId}] recompute ${dateFrom}..${dateTo} — ${total} pares (emp,día)`);

  let done = 0, errors = 0;
  const errList = [];

  for (const row of rows) {
    try {
      // recalcDailySummary espera (employeeId, Date). Usamos mediodía UTC
      // del día para que toISOString().split('T')[0] devuelva la misma fecha.
      const ts = new Date(`${row.d}T12:00:00Z`);
      await recalcDailySummary(row.employee_id, ts);
    } catch (err) {
      errors++;
      if (errList.length < 20) errList.push({ employeeId: row.employee_id, date: row.d, error: err.message });
    }
    done++;

    // Emit cada 25 para no saturar
    if (done % 25 === 0 || done === total) {
      emit('progress', {
        done, total,
        percent: total ? Math.round((done / total) * 100) : 100,
        date: row.d, employeeId: row.employee_id,
      });
    }
  }

  emit('done', { done, total, errors });

  return { dateFrom, dateTo, pairs: total, processed: done, errors, errList };
}

module.exports = { recomputeRange, daysInRange };
