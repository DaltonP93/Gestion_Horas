/**
 * mysqlRetry.js — Reintento acotado ante deadlocks / lock-wait de MySQL.
 *
 * Envuelve una operación que ejecuta sus PROPIAS sentencias/transacciones y la
 * reintenta si MySQL devuelve:
 *   - 1213 ER_LOCK_DEADLOCK      → "Deadlock found; try restarting transaction"
 *   - 1205 ER_LOCK_WAIT_TIMEOUT  → "Lock wait timeout exceeded"
 *
 * Máximo `retries` intentos, backoff incremental con jitter. Como cada intento
 * vuelve a invocar `fn`, y `fn` abre su propia transacción/sentencia (autocommit
 * o sequelize.transaction), cada reintento usa una TRANSACCIÓN NUEVA.
 *
 * No reintenta otros errores (se propagan tal cual).
 */
const logger = require('../config/logger');

function mysqlErrno(err) {
  const e = err && (err.original || err.parent || err);
  if (!e) return null;
  if (typeof e.errno === 'number') return e.errno;
  if (e.code === 'ER_LOCK_DEADLOCK') return 1213;
  if (e.code === 'ER_LOCK_WAIT_TIMEOUT') return 1205;
  return null;
}
const isDeadlock       = (err) => mysqlErrno(err) === 1213;
const isLockWaitTimeout = (err) => mysqlErrno(err) === 1205;
const isRetryable      = (err) => isDeadlock(err) || isLockWaitTimeout(err);

/**
 * @param {(attempt:number)=>Promise<any>} fn  operación (recibe el nº de intento).
 * @param {object} opts { retries=3, baseMs=50, label='op', onRetry(attempt,err,waitMs) }
 * @returns {Promise<{ result:any, attempts:number, retries:number }>} o lanza el error.
 */
async function withDeadlockRetry(fn, { retries = 3, baseMs = 50, label = 'op', onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt, retries: attempt - 1 };
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryable(err)) throw err;
      const wait = baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * baseMs); // 50→100→200 + jitter
      const kind = isDeadlock(err) ? 'deadlock(1213)' : 'lock-wait(1205)';
      logger.warn(`[mysqlRetry:${label}] intento ${attempt}/${retries} ${kind} — reintenta en ${wait}ms`);
      if (typeof onRetry === 'function') { try { onRetry(attempt, err, wait); } catch { /* opcional */ } }
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = { withDeadlockRetry, isDeadlock, isLockWaitTimeout, isRetryable, mysqlErrno };
