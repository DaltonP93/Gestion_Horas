/**
 * recalcLock.js — Serialización lógica del recálculo de daily_summary por FECHA.
 *
 * Dos procesos no pueden recalcular el MISMO día a la vez (worker, bridge,
 * reproceso manual, cron att2000). Se usa un lock nombrado de MySQL
 * (GET_LOCK/RELEASE_LOCK) por fecha, tomado sobre la conexión de una
 * transacción, para que el trabajo interno herede esa conexión.
 *
 * Combinado con rangos sargables y el reintento de deadlocks, elimina el
 * "Deadlock found ..." del INSERT INTO daily_summary ... SELECT ... sobre
 * attendance_logs. NO se envuelve toda la sincronización: sólo el recálculo de
 * un día.
 */
const { sequelize } = require('../config/database');
const { withDeadlockRetry } = require('../utils/mysqlRetry');

const LOCK_TIMEOUT_S = 10;
const keyFor = (date) => `sishoras:recalc:${date}`;

/**
 * Límites [inicio, díaSiguiente) de una fecha 'YYYY-MM-DD' para usar rangos
 * SARGABLES sobre attendance_logs.timestamp (evita DATE(timestamp), que impide
 * el uso eficiente del índice idx_ts y amplía los locks de rango / next-key).
 * @param {string} date 'YYYY-MM-DD'
 * @returns {{ start:string, next:string }} 'YYYY-MM-DD HH:mm:ss'
 */
function dayBounds(date) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  const next = d.toISOString().slice(0, 10);
  return { start: `${date} 00:00:00`, next: `${next} 00:00:00` };
}

/**
 * Ejecuta fn(t) bajo el lock del día `date`, dentro de una transacción.
 * Reintenta ante deadlock/lock-wait (cada intento = transacción nueva y lock nuevo).
 * @returns {Promise<{ retries:number }>}
 */
async function withDayRecalcLock(date, fn, { label } = {}) {
  const key = keyFor(date);
  const { retries } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    // GET_LOCK devuelve 1 (tomado), 0 (timeout: otro proceso lo tiene) o NULL
    // (error interno). Si NO se toma, NO se puede ejecutar fn: correría en paralelo
    // con el tenedor real y la carrera de escritura (un snapshot viejo pisando uno
    // nuevo, o al revés) vuelve. Por eso una adquisición fallida se trata como
    // lock-wait RETRYABLE: withDeadlockRetry reintenta con una transacción y un
    // lock nuevos; si se agotan los intentos, FALLA en vez de recalcular
    // desprotegido. Un GET_LOCK que lance (conexión) también propaga, no se traga.
    const [rows] = await sequelize.query('SELECT GET_LOCK(?, ?) AS ok', { replacements: [key, LOCK_TIMEOUT_S], transaction: t });
    const ok = Array.isArray(rows) && rows[0] ? rows[0].ok : null;
    if (ok !== 1) {
      const err = new Error(`No se pudo tomar el lock de recálculo ${key} (GET_LOCK=${ok === null ? 'NULL/error' : ok})`);
      err.code = 'ER_LOCK_WAIT_TIMEOUT'; // retryable por withDeadlockRetry (errno 1205)
      throw err;
    }
    try {
      await fn(t);
    } finally {
      // Liberar SIEMPRE (aunque fn falle). Al cerrar la conexión también se
      // libera, pero lo hacemos explícito para no dejar locks huérfanos.
      await sequelize.query('SELECT RELEASE_LOCK(?)', { replacements: [key], transaction: t }).catch(() => {});
    }
  }), { label: label || `recalc:${date}` });
  return { retries };
}

module.exports = { withDayRecalcLock, keyFor, dayBounds };
