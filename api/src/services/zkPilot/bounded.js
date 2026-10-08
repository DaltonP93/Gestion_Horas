'use strict';

/**
 * bounded.js — operaciones externas ACOTADAS del piloto (MySQL y Redis).
 *
 * Ningún `await` del piloto sobre una consulta, un comando o un cierre puede
 * quedar esperando sin tope: cada operación corre contra
 *   - su propio tope (`capMs`): al vencer se CANCELA el cliente (`cancel()`,
 *     p. ej. destroy()/disconnect()) porque ya no responde, y se rechaza;
 *   - una señal de corte (`stop`, opcional): al dispararse (límite total, señal,
 *     lock perdido) se deja de esperar SIN cancelar el cliente, que puede seguir
 *     sano y hacer falta para liberar el lock.
 * La promesa original sigue su curso: su resultado tardío se descarta. Con la
 * señal ya disparada, la operación ni siquiera se lanza.
 */

class BoundedError extends Error {
  /**
   * @param {'timeout'|'detenido'|'error'} motivo
   * @param {string} kind  'mysql' | 'redis'
   * @param {Error} [cause]
   */
  constructor(motivo, kind, cause) {
    super(`${kind}:${motivo}`);
    this.name = 'BoundedError';
    this.motivo = motivo;
    this.kind = kind;
    this.cause = cause;
  }
}

/** Señal de corte: `fire()` despierta a todas las operaciones en curso que la escuchan. */
function createStop() {
  const listeners = new Set();
  let fired = false;
  return {
    get fired() { return fired; },
    fire() {
      if (fired) return;
      fired = true;
      for (const l of [...listeners]) l();
      listeners.clear();
    },
    on(fn) {
      if (fired) { fn(); return () => {}; }
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * @param {string} kind
 * @param {() => Promise<any>} fn      la operación
 * @param {{ capMs:number, cancel?:() => void, stop?:ReturnType<typeof createStop> }} o
 */
function bounded(kind, fn, { capMs, cancel = () => {}, stop = null }) {
  // Ya cortado: la operación NO se lanza (una toma no debe salir después de abortar).
  if (stop && stop.fired) return Promise.reject(new BoundedError('detenido', kind));
  return new Promise((resolve, reject) => {
    let done = false;
    let off = () => {};
    const finish = (f, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      f(v);
    };
    const timer = setTimeout(() => {
      if (done) return;
      try { cancel(); } catch { /* ya cerrado */ }
      finish(reject, new BoundedError('timeout', kind));
    }, Math.max(0, capMs));
    if (stop) off = stop.on(() => finish(reject, new BoundedError('detenido', kind)));
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    p.then((v) => finish(resolve, v), (e) => finish(reject, new BoundedError('error', kind, e)));
  });
}

module.exports = { bounded, createStop, BoundedError };
