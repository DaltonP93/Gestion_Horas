'use strict';

/**
 * runPilot.js — orquesta el piloto aislado de estados de UN reloj.
 *
 * Orden y garantías:
 *   1. MySQL con sesión READ ONLY: sólo SELECT del reloj y del lock MySQL.
 *   2. Lock en Redis con la clave compartida (zkPilot/lock.js). Ocupado,
 *      Redis caído o lock MySQL vigente/no verificable → no se conecta al reloj.
 *   3. Cada intento corre en un proceso hijo (readChild.js). Al vencer el
 *      intento, al perder el lock, ante una señal o al agotar la duración
 *      total, el hijo se mata y se ESPERA su terminación (y el cierre del canal)
 *      antes de reintentar o liberar el lock. Si la terminación no se confirma,
 *      el lock NO se libera: vence solo por TTL.
 *   4. TTL = timeout del intento + gracia del hijo + margen + renovación. El
 *      hijo se termina solo antes de que el lock pueda vencer, aunque este
 *      proceso muera sin liberarlo: no hay ventana de solapamiento.
 *   5. Salida: JSON agregado y saneado (ver aggregate.js), con el resultado y
 *      los intentos realmente ejecutados.
 *
 * No usa zktecoReader, deviceLock, auditoría, el ORM ni ningún camino de
 * importación, staging, recálculo o actualización de dispositivos.
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const mysql = require('mysql2/promise');
const { keyFor } = require('../deviceLockKeys');
const { connectRedis, createPilotLock, checkMysqlLock } = require('./lock');
const { releaseCommit } = require('./args');

const CHILD = path.join(__dirname, 'readChild.js');
const FORMAT = 'sishoras.zk-raw-state-pilot/1';
const CHILD_GRACE_S = 1;          // el hijo se termina solo este tiempo después del timeout del intento
const SAFETY_S = 5;               // margen del TTL sobre la vida máxima del hijo
const KILL_WAIT_MS = 10000;       // espera máxima de la terminación tras SIGKILL
const EXIT_DISCONNECT_WAIT_MS = 1000;
const CHILD_ENV_KEYS = ['PATH', 'TZ', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'HOME'];
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const EXIT_CODES = Object.freeze({
  ok: 0,
  error_interno: 1,
  cierre_no_confirmado: 1,
  argumentos_invalidos: 2,
  id_invalido: 2,
  salida_existente: 2,
  configuracion_invalida: 2,
  captura_no_garantizada: 3,
  captura_incompleta: 3,
  reloj_ocupado: 4,
  lock_mysql_vigente: 4,
  exclusion_no_garantizada: 4,
  redis_no_disponible: 5,
  sin_lectura_completa: 6,
  limite_total: 6,
  lock_perdido: 7,
  reloj_inexistente: 8,
  reloj_sin_direccion: 8,
  base_no_disponible: 8,
});

const ADVERTENCIA = 'Conteos crudos de los bytes de estado y verificación del reloj. El piloto no interpreta '
  + 'ningún valor como entrada o salida, no importa marcaciones, no modifica horas, dispositivos ni configuración. '
  + 'Disponer del byte no demuestra su semántica ni la configuración del equipo.';

const ttlSecondsFor = (opts) => opts.attemptTimeoutS + CHILD_GRACE_S + SAFETY_S + opts.renewS;

function nodeZklibVersion() {
  try {
    return JSON.parse(fs.readFileSync(require.resolve('node-zklib/package.json'), 'utf8')).version || null;
  } catch { return null; }
}

/** Esqueleto del JSON; `opts` puede ser null (entrada inválida). */
function skeletonFor(opts, rootDir) {
  const rel = releaseCommit(rootDir);
  return {
    formato: FORMAT,
    advertencia: ADVERTENCIA,
    herramienta: { commit: rel.commit, origen_commit: rel.origen, node_zklib: nodeZklibVersion(), node: process.version },
    reloj: { id: opts ? opts.deviceId : null, modo_conexion: null },
    limites: opts ? {
      intentos_max: opts.attempts,
      timeout_intento_s: opts.attemptTimeoutS,
      duracion_max_s: opts.maxDurationS,
      espera_entre_intentos_s: opts.cooldownS,
      renovacion_s: opts.renewS,
      ttl_lock_s: ttlSecondsFor(opts),
    } : null,
    exclusion: {
      backend: 'redis',
      clave: opts ? keyFor(opts.deviceId) : null,
      mysql_device_locks: null,
      auditoria_mysql: false,
      fallback_mysql: false,
    },
    resultado: null,
    codigo_salida: null,
    senal: null,
    duracion_ms: 0,
    intentos_ejecutados: 0,
    intentos: [],
    lectura: null,
  };
}

function childEnv() {
  const env = {};
  for (const k of CHILD_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * @param {object} opts  salida de parseArgs().opts
 * @param {{ env?:object, rootDir:string }} ctx
 * @returns {Promise<{ json:object, exitCode:number }>}
 */
async function runPilot(opts, { env = process.env, rootDir }) {
  const t0 = Date.now();
  const json = skeletonFor(opts, rootDir);
  const attemptMs = opts.attemptTimeoutS * 1000;
  const deadline = t0 + opts.maxDurationS * 1000;
  const ttlMs = ttlSecondsFor(opts) * 1000;

  const state = { abort: null, signal: null, killChild: null, wake: null };
  const abort = (reason, signal = null) => {
    if (state.abort) return;
    state.abort = reason;
    if (signal) state.signal = signal;
    if (state.killChild) state.killChild(reason);
    if (state.wake) state.wake();
  };
  const onSignal = {};
  for (const sig of Object.keys(SIGNALS)) {
    onSignal[sig] = () => abort('interrumpido', sig);
    process.on(sig, onSignal[sig]);
  }
  const deadlineTimer = setTimeout(() => abort('limite_total'), Math.max(0, deadline - Date.now()));

  let conn = null;
  let redis = null;
  let lock = null;
  let holding = false;
  let lockLost = false;
  let closeUnconfirmed = false;
  let renewTimer = null;
  let renewBusy = false;
  let resultado = null;

  /** Renueva y vuelve a verificar el lock MySQL. false (y abort) si la exclusión ya no está garantizada. */
  const verifyExclusion = async () => {
    try {
      if (!(await lock.renew())) { lockLost = true; abort('lock_perdido'); return false; }
    } catch { abort('redis_no_disponible'); return false; }
    try {
      if ((await checkMysqlLock(conn, opts.deviceId)) === 'lock_vigente') { abort('lock_mysql_vigente'); return false; }
    } catch { abort('exclusion_no_garantizada'); return false; }
    return true;
  };

  const sleepInterruptible = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { state.wake = null; resolve(); }, ms);
    state.wake = () => { clearTimeout(t); state.wake = null; resolve(); };
  });

  const runAttempt = (n, device) => new Promise((resolve) => {
    const started = Date.now();
    const child = fork(CHILD, [], { env: childEnv(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    let message = null;
    let reason = null;
    let exited = false;
    let disconnected = false;
    let settled = false;
    let killWatch = null;
    let exitWait = null;
    const attempt = { intento: n, estado: null, codigo: null, duracion_ms: 0, registros: 0, validos: 0, basura: 0, captura: null, bytes_estimados: null, cierre: null };

    const settle = (cierre) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killWatch);
      clearTimeout(exitWait);
      state.killChild = null;
      attempt.cierre = cierre;
      attempt.duracion_ms = Date.now() - started;
      if (message && message.type === 'resultado' && !reason) {
        const a = message.agregado || {};
        Object.assign(attempt, {
          estado: message.estado, codigo: message.codigo,
          registros: a.registros, validos: a.validos, basura: a.basura, captura: a.captura, bytes_estimados: a.bytes_estimados,
        });
        resolve({ attempt, agregado: message.estado === 'completa' ? a : null });
        return;
      }
      if (reason === 'tiempo_agotado') Object.assign(attempt, { estado: 'timeout', codigo: 'tiempo_agotado' });
      else if (reason) Object.assign(attempt, { estado: 'cancelado', codigo: reason });
      else if (message && message.type === 'captura') attempt.estado = 'captura_no_garantizada';
      else Object.assign(attempt, { estado: 'error', codigo: 'proceso_sin_resultado' });
      resolve({ attempt, agregado: null });
    };
    const maybeDone = () => {
      if (!exited) return;
      if (disconnected) { settle('proceso_terminado'); return; }
      if (!exitWait) exitWait = setTimeout(() => settle('proceso_terminado'), EXIT_DISCONNECT_WAIT_MS);
    };
    const kill = (why) => {
      if (settled || exited) return;
      if (!reason && !(message && message.type === 'resultado')) reason = why;
      try { child.kill('SIGKILL'); } catch { /* ya terminó */ }
      if (!killWatch) killWatch = setTimeout(() => { closeUnconfirmed = true; settle('no_confirmado'); }, KILL_WAIT_MS);
    };

    child.on('message', (m) => { if (!message) message = m; });
    child.on('exit', () => { exited = true; maybeDone(); });
    child.on('disconnect', () => { disconnected = true; maybeDone(); });
    child.on('error', () => kill('error_proceso'));
    const timer = setTimeout(() => kill('tiempo_agotado'), attemptMs);
    state.killChild = kill;
    if (state.abort) { kill(state.abort); return; }
    try {
      child.send({
        type: 'leer',
        limiteMs: attemptMs + CHILD_GRACE_S * 1000,
        reloj: {
          ip_address: device.ip_address,
          port: device.port,
          connection_mode: device.connection_mode,
          timeout_ms: device.timeout_ms,
        },
      });
    } catch { kill('error_proceso'); }
  });

  // Cuerpo en una función propia: cualquier salida temprana pasa por `finally`
  // (liberación ordenada) y después se arma el resultado.
  await (async () => {
    try {
      // 1) MySQL de sólo lectura.
      try {
        conn = await mysql.createConnection({
          host: env.DB_HOST || 'localhost',
          port: Number(env.DB_PORT || 3306),
          user: env.DB_USER || 'root',
          password: env.DB_PASSWORD ?? '',
          database: env.DB_NAME || 'asistencia',
          connectTimeout: 5000,
        });
        await conn.query('SET SESSION TRANSACTION READ ONLY');
      } catch { resultado = 'base_no_disponible'; return; }
      if (state.abort) { resultado = state.abort; return; }

      const [rows] = await conn.query(
        'SELECT id, ip_address, port, connection_mode, timeout_ms FROM devices WHERE id = ? LIMIT 1', [opts.deviceId],
      );
      if (!rows.length) { resultado = 'reloj_inexistente'; return; }
      const device = rows[0];
      json.reloj.modo_conexion = device.connection_mode || 'auto';
      if (!device.ip_address || !String(device.ip_address).trim()) { resultado = 'reloj_sin_direccion'; return; }
      if (state.abort) { resultado = state.abort; return; }

      // 2) Lock compartido en Redis (sin auditoría, sin fallback, sin DDL).
      try {
        redis = await connectRedis(env.REDIS_URL || 'redis://localhost:6379', {
          onError: () => { if (holding) abort('redis_no_disponible'); },
        });
      } catch { resultado = 'redis_no_disponible'; return; }
      lock = createPilotLock({ redis, deviceId: opts.deviceId, ttlMs });
      let acquired;
      try { acquired = await lock.acquire(); } catch { resultado = 'redis_no_disponible'; return; }
      if (!acquired) { resultado = 'reloj_ocupado'; return; }
      holding = true;
      try {
        json.exclusion.mysql_device_locks = await checkMysqlLock(conn, opts.deviceId);
      } catch { resultado = 'exclusion_no_garantizada'; return; }
      if (json.exclusion.mysql_device_locks === 'lock_vigente') { resultado = 'lock_mysql_vigente'; return; }

      renewTimer = setInterval(async () => {
        if (renewBusy || state.abort) return;
        renewBusy = true;
        try { await verifyExclusion(); } finally { renewBusy = false; }
      }, opts.renewS * 1000);

      // 3) Intentos, cada uno en su proceso.
      let selected = null;
      let captureFailed = false;
      let stoppedByLimit = false;
      for (let n = 1; n <= opts.attempts; n += 1) {
        if (state.abort) break;
        if (deadline - Date.now() < attemptMs) { stoppedByLimit = true; break; }
        while (renewBusy) await new Promise((r) => setTimeout(r, 20));
        if (!(await verifyExclusion())) break;
        const { attempt, agregado } = await runAttempt(n, device);
        json.intentos.push(attempt);
        json.intentos_ejecutados = n;
        if (attempt.cierre !== 'proceso_terminado') break;
        if (attempt.estado === 'captura_no_garantizada') { captureFailed = true; break; }
        if (attempt.estado === 'completa') { selected = { intento: n, ...agregado }; break; }
        if (n < opts.attempts && opts.cooldownS > 0 && !state.abort) await sleepInterruptible(opts.cooldownS * 1000);
      }

      if (closeUnconfirmed) resultado = 'cierre_no_confirmado';
      else if (state.abort) resultado = state.abort;
      else if (selected) {
        json.lectura = selected;
        resultado = selected.captura && selected.captura.ok === selected.registros ? 'ok' : 'captura_incompleta';
      } else if (captureFailed) resultado = 'captura_no_garantizada';
      else if (stoppedByLimit) resultado = 'limite_total';
      else resultado = 'sin_lectura_completa';
      return;
    } catch {
      resultado = resultado || 'error_interno';
      return;
    } finally {
      clearTimeout(deadlineTimer);
      if (renewTimer) clearInterval(renewTimer);
      while (renewBusy) await new Promise((r) => setTimeout(r, 20));
      // El lock se libera sólo con el hijo terminado, si sigue siendo nuestro.
      if (holding && lock && !lockLost && !closeUnconfirmed) {
        try { await lock.release(); } catch { /* vence por TTL */ }
      }
      if (redis) {
        try { await redis.quit(); } catch { try { await redis.disconnect(); } catch { /* cerrado */ } }
      }
      if (conn) {
        try { await conn.end(); } catch { try { conn.destroy(); } catch { /* cerrado */ } }
      }
      for (const sig of Object.keys(SIGNALS)) process.removeListener(sig, onSignal[sig]);
      if (state.abort === 'interrumpido' && resultado !== 'cierre_no_confirmado') resultado = 'interrumpido';
      json.resultado = resultado || 'error_interno';
      json.senal = state.signal;
      json.codigo_salida = json.resultado === 'interrumpido' ? SIGNALS[state.signal] : (EXIT_CODES[json.resultado] ?? 1);
      json.duracion_ms = Date.now() - t0;
    }
  })();
  return { json, exitCode: json.codigo_salida };
}

module.exports = { runPilot, skeletonFor, ttlSecondsFor, EXIT_CODES, SIGNALS, FORMAT, CHILD };
