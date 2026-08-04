/**
 * cronRunner.js
 * Envoltorio único para todo trabajo programado.
 *
 * Aporta tres cosas que faltaban en los crons:
 *  1. Aislamiento: nunca rechaza. node-cron no espera la promesa del callback,
 *     así que un `async () => {...}` sin try/catch termina en unhandledRejection
 *     y se lleva puesto el diagnóstico (o el proceso, según la configuración).
 *  2. Observabilidad: cada corrida deja nombre, horario, duración, resultado,
 *     cantidad procesada y un error_code estable.
 *  3. Exclusión: dos disparos del mismo job no corren superpuestos.
 */
const logger = require('../config/logger');
const { serializeError, safeErrorCode } = require('./errorInfo');

// Jobs en ejecución, por nombre. Local al proceso: alcanza porque cada job
// está programado una sola vez por instancia de API.
const _running = new Map();

function isRunning(name) { return _running.has(name); }
function runningJobs() { return [..._running.keys()]; }

/** Normaliza lo que devuelve el job a una cantidad procesada, si la hay. */
function extractProcessed(result) {
  if (typeof result === 'number' && Number.isFinite(result)) return result;
  if (result && typeof result === 'object') {
    for (const k of ['processed', 'count', 'sent', 'imported', 'removed', 'updated', 'total']) {
      if (typeof result[k] === 'number' && Number.isFinite(result[k])) return result[k];
    }
  }
  return null;
}

/**
 * Ejecuta un job programado con logging estructurado y sin fugas de errores.
 *
 * @param {string} name  nombre estable del job (aparece en todos los logs)
 * @param {() => any} fn cuerpo del job
 * @param {{ scheduledAt?: Date, meta?: object, allowOverlap?: boolean }} opts
 * @returns {Promise<{ok:boolean, skipped?:boolean, duration_ms:number, processed:number|null, error_code?:string}>}
 */
async function runJob(name, fn, opts = {}) {
  const { scheduledAt = new Date(), meta = {}, allowOverlap = false } = opts;

  if (!allowOverlap && _running.has(name)) {
    const since = _running.get(name);
    logger.warn('Cron solapado: se omite esta corrida', {
      job: name,
      result: 'skipped',
      reason: 'already_running',
      running_since: new Date(since).toISOString(),
      running_ms: Date.now() - since,
      ...meta,
    });
    return { ok: false, skipped: true, duration_ms: 0, processed: null, error_code: 'JOB_ALREADY_RUNNING' };
  }

  const startedAt = Date.now();
  if (!allowOverlap) _running.set(name, startedAt);
  logger.info('▶️  Cron inicio', {
    job: name,
    scheduled_at: toIso(scheduledAt),
    started_at: new Date(startedAt).toISOString(),
    ...meta,
  });

  try {
    const result = await fn();
    const duration_ms = Date.now() - startedAt;
    const processed = extractProcessed(result);
    logger.info('✅ Cron OK', {
      job: name,
      scheduled_at: toIso(scheduledAt),
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms,
      result: 'ok',
      processed,
      ...meta,
    });
    return { ok: true, duration_ms, processed, value: result };
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const error_code = safeErrorCode(err);
    // Un job caído no puede tumbar la API ni frenar a los demás: se registra
    // con todo el detalle seguro y se devuelve el resultado como valor.
    logger.error('❌ Cron falló', {
      job: name,
      scheduled_at: toIso(scheduledAt),
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms,
      result: 'error',
      error_code,
      error: serializeError(err),
      ...meta,
    });
    return { ok: false, duration_ms, processed: null, error_code };
  } finally {
    if (!allowOverlap) _running.delete(name);
  }
}

function toIso(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/**
 * Callback listo para `cron.schedule`: sincrónico (node-cron no espera
 * promesas) y con la ejecución delegada a runJob.
 */
function cronCallback(name, fn, opts = {}) {
  return () => { void runJob(name, fn, { ...opts, scheduledAt: new Date() }); };
}

module.exports = { runJob, cronCallback, isRunning, runningJobs };
