'use strict';

/**
 * runPilot.js — orquesta el piloto aislado de estados de UN reloj.
 *
 * Orden y garantías:
 *   1. MySQL: una conexión con sesión READ ONLY sólo para el SELECT del reloj,
 *      que se cierra enseguida; después, otra PROPIA del lock (sesión fijada y
 *      verificada: zona de la app, autocommit, esperas cortas, base escribible)
 *      sólo para las sentencias de lock.js sobre device_locks.
 *   2. Exclusión: la clave compartida en Redis Y la fila propia en device_locks
 *      (zkPilot/lock.js). Ocupado, Redis caído, fila no tomada o sin tabla/
 *      permisos → no se conecta al reloj. Se renuevan las dos antes de cada
 *      intento y cada --renew-seconds; si alguna falla, se corta la lectura.
 *   3. Cada intento corre en un proceso hijo (readChild.js). Al vencer el
 *      intento, al perder el lock, ante una señal o al agotar la duración
 *      total, el hijo se mata y se ESPERA su terminación (y el cierre del canal)
 *      antes de reintentar o liberar el lock. Si la terminación no se confirma,
 *      el lock NO se libera: vence solo por TTL.
 *   4. TTL = timeout del intento + gracia del hijo + margen + renovación. La
 *      renovación previa a cada intento debe completarse dentro del margen, así
 *      que el hijo termina solo antes de que la clave o la fila puedan vencer,
 *      aunque este proceso muera sin liberarlas: no hay ventana de solapamiento.
 *   5. Ninguna espera sin tope (bounded.js): cada consulta y comando tiene su
 *      propio tope (vencido ⇒ se destruye el socket de ese cliente) y deja de
 *      esperarse al agotarse la duración total, ante una señal o al perder el
 *      lock; abortar NO destruye clientes. Al cerrar, lo que siga en vuelo
 *      tiene una gracia corta; si no termina, ese cliente se cancela y la clave
 *      o la fila se liberan por un cliente NUEVO. Las tomas nacen con un TTL
 *      provisional; una toma con resultado INCIERTO (tope, corte o red) se
 *      compensa por token, y si su cliente se canceló, antes se mata su sesión
 *      en el servidor (CLIENT KILL / KILL CONNECTION): lo que siga en vuelo ya
 *      no puede aplicarse después. Todo el cierre comparte UN presupuesto: el
 *      piloto termina dentro de --max-duration más una holgura fija
 *      (`limites.cierre_max_s`).
 *   6. Salida: JSON agregado y saneado (ver aggregate.js), con el resultado y
 *      los intentos realmente ejecutados; con --cutoff, el bloque `corte`.
 *
 * No usa zktecoReader, deviceLock, auditoría, el ORM ni ningún camino de
 * importación, staging, recálculo o actualización de dispositivos.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const mysql = require('mysql2/promise');
const { keyFor } = require('../deviceLockKeys');
const { pyDateTimeStr } = require('../zkRecordShape');
const { addMinutesWall, CANON_CORTE } = require('./corte');
const {
  createRedisClient, createPilotLock, createMysqlLock, mysqlLockError, hardCancelMysql, guardMysqlErrors, lockSessionOk,
  LOCK_SESSION_SQL, MYSQL_KILL_SQL, ER_NO_SUCH_THREAD, DB_TIMEZONE, MYSQL_ORIGIN, PROVISIONAL_TTL_S,
} = require('./lock');
const { bounded, createStop, BoundedError } = require('./bounded');
const { releaseCommit } = require('./args');

const CHILD = path.join(__dirname, 'readChild.js');
const FORMAT = 'sishoras.zk-raw-state-pilot/2';
const CHILD_GRACE_S = 1;          // el hijo se termina solo este tiempo después del timeout del intento
const SAFETY_S = 5;               // margen del TTL sobre la vida máxima del hijo
const KILL_WAIT_MS = 10000;       // espera máxima de la terminación tras SIGKILL
const EXIT_DISCONNECT_WAIT_MS = 1000;
const OP_TIMEOUT_MS = 5000;       // tope de cada consulta o comando (vencido ⇒ se destruye ese cliente)
const CONNECT_TIMEOUT_MS = 5000;
const CLOSE_OP_MS = 2000;         // tope de cada paso de cierre por un cliente que ya existe
const STOP_GRACE_MS = 400;        // al cerrar, lo que sigue en vuelo tiene esto para terminar; si no, se cancela
// UN presupuesto para todo el cierre (gracia, liberaciones con o sin cliente nuevo, matar la sesión
// vieja y cerrar): la cota no depende de cuántos pasos haga falta dar.
const CLOSE_BUDGET_MS = 6000;
const KILL_POLL_MS = 50;          // sondeo de PROCESSLIST hasta que el hilo matado desaparece
// La renovación previa a un intento debe terminar dentro del margen del TTL: así,
// al lanzar el hijo, a la clave y a la fila les queda más vida que al hijo.
const FRESH_RENEW_MS = (SAFETY_S - 1) * 1000;
// Holgura máxima sobre --max-duration: terminación del hijo + presupuesto de cierre.
const CLOSE_MAX_S = Math.ceil((KILL_WAIT_MS + CLOSE_BUDGET_MS) / 1000) + 1;
const SLOTS = ['conn', 'lockConn', 'redis'];
// TZ NO se hereda: el hijo decodifica la hora de pared en UTC (sin horas inexistentes; ver aggregate.js).
const CHILD_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'HOME'];
// Margen del corte respecto de "ahora": una marca nueva con el reloj atrasado hasta este tiempo no puede
// caer dentro del conjunto.
const CUTOFF_MARGIN_MIN = 120;
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const EXIT_CODES = Object.freeze({
  ok: 0,
  error_interno: 1,
  cierre_no_confirmado: 1,
  argumentos_invalidos: 2,
  id_invalido: 2,
  salida_existente: 2,
  configuracion_invalida: 2,
  corte_futuro: 2,
  corte_reciente: 2,
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
      ttl_provisional_s: PROVISIONAL_TTL_S,
      operacion_max_s: OP_TIMEOUT_MS / 1000,
      cierre_max_s: CLOSE_MAX_S,
    } : null,
    // Corte común: lo completa la lectura elegida (ver aggregate.cutoffBlock); sin lectura, sin conjunto.
    corte: opts && opts.cutoff ? { hasta: opts.cutoff, canon: CANON_CORTE, conjunto: null, huella_motivo: 'sin_lectura' } : null,
    exclusion: {
      backend: 'redis+mysql',
      clave: opts ? keyFor(opts.deviceId) : null,
      mysql: { tabla: 'device_locks', origen: MYSQL_ORIGIN, estado: null },
      auditoria_mysql: false,
    },
    resultado: null,
    codigo_salida: null,
    senal: null,
    duracion_ms: 0,
    intentos_ejecutados: 0,
    intentos: [],
    lectura: null,
    liberacion: { redis: 'no_tomado', mysql: 'no_tomado' },
    cierre_clientes: { redis: null, mysql: null, mysql_lock: null },
  };
}

function childEnv() {
  const env = { TZ: 'UTC' };
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

  // `stop` despierta toda espera de trabajo en curso (límite total, señal, lock
  // perdido o cierre) sin destruir clientes que pueden hacer falta para liberar.
  const stop = createStop();
  const state = { abort: null, signal: null, killChild: null, wake: null };
  const abort = (reason, signal = null) => {
    if (state.abort) return;
    state.abort = reason;
    if (signal) state.signal = signal;
    if (state.killChild) state.killChild(reason);
    if (state.wake) state.wake();
    stop.fire();
  };
  const onSignal = {};
  for (const sig of Object.keys(SIGNALS)) {
    onSignal[sig] = () => abort('interrumpido', sig);
    process.on(sig, onSignal[sig]);
  }
  const deadlineTimer = setTimeout(() => abort('limite_total'), Math.max(0, deadline - Date.now()));

  let conn = null;       // READ ONLY: sólo el SELECT del reloj
  let lockConn = null;   // sólo las sentencias del lock sobre device_locks
  let redis = null;
  let lock = null;
  let mysqlLock = null;
  const held = { redis: false, mysql: false };
  const lost = { redis: false, mysql: false };
  // Toma con resultado incierto (tope, corte o red): pudo aplicarse en el servidor sin que lo sepamos.
  const uncertain = { redis: false, mysql: false };
  const dead = { conn: false, lockConn: false, redis: false };
  const closed = { conn: null, lockConn: null };
  // Operaciones lanzadas que todavía no terminaron, por cliente (aunque ya no se las espere).
  const pending = { conn: new Set(), lockConn: new Set(), redis: new Set() };
  // Sesión de cada cliente del lock en el SERVIDOR, para matarla antes de compensar por otro cliente.
  const sessionIds = { redis: null, lockConn: null };
  let closeDeadline = null;
  let closeUnconfirmed = false;
  let renewTimer = null;
  let renewing = null;
  let resultado = null;

  // Cancelar = destruir el socket del cliente que ya no responde (lo pendiente se rechaza).
  const cancel = {
    conn: () => { dead.conn = true; hardCancelMysql(conn); },
    lockConn: () => { dead.lockConn = true; hardCancelMysql(lockConn); },
    redis: () => { dead.redis = true; try { if (redis) redis.disconnect().catch(() => {}); } catch { /* cerrado */ } },
  };
  const kindOf = (slot) => (slot === 'redis' ? 'redis' : 'mysql');
  /** Lanza `fn` y la anota como pendiente de ese cliente hasta que termine. */
  const tracked = (slot, fn) => () => {
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    const done = p.then(() => {}, () => {});
    pending[slot].add(done);
    done.then(() => pending[slot].delete(done));
    return p;
  };
  /** Lo que queda del presupuesto de cierre (sin cierre en curso, sin límite propio). */
  const closeLeft = () => (closeDeadline === null ? Infinity : Math.max(0, closeDeadline - Date.now()));
  /** Operación de trabajo: tope propio (cancela) y corte por `stop` (sólo deja de esperar). */
  const op = (slot, fn) => bounded(kindOf(slot), tracked(slot, fn), { capMs: OP_TIMEOUT_MS, cancel: cancel[slot], stop });
  /** Paso de cierre por un cliente existente: su tope, dentro del presupuesto de cierre (cancela). */
  const closeOp = (slot, fn) => bounded(kindOf(slot), tracked(slot, fn), {
    capMs: Math.min(CLOSE_OP_MS, closeLeft()), cancel: cancel[slot],
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  /** Espera `p` a lo sumo `ms` (nunca lanza). */
  const waitAtMost = (p, ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    const end = () => { clearTimeout(t); resolve(); };
    p.then(end, end);
  });
  /** Resultado ante un fallo: si fue un corte (límite, señal, lock perdido), manda ese motivo. */
  const failure = (err, fallback) => (err instanceof BoundedError && err.motivo === 'detenido' && state.abort ? state.abort : fallback);
  /** ¿La operación fallida pudo aplicarse igual? Sólo un error del SERVIDOR prueba que no. */
  const outcomeUncertain = (err, kind) => {
    if (!(err instanceof BoundedError) || err.motivo !== 'error') return true;
    const c = err.cause;
    if (kind === 'redis') return !(c && c.constructor && c.constructor.name === 'ErrorReply');
    return !(c && Number.isInteger(c.errno)) && !(c && c.code === 'PILOT_STOPPED');
  };

  const mysqlConfig = () => ({
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME || 'asistencia',
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  /**
   * Conecta con tope (`run` acota y corta); una conexión que llega tarde se destruye. Durante el
   * trabajo, el tope de conexión no pasa del límite total; al cerrar se usa el tope de cierre.
   */
  const connectMysql = async (run, connectTimeout = Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now()))) => {
    let abandoned = false;
    const connecting = mysql.createConnection({ ...mysqlConfig(), connectTimeout });
    connecting.then((c) => { guardMysqlErrors(c); if (abandoned) hardCancelMysql(c); }, () => {});
    try {
      return await run(() => connecting);
    } catch (e) {
      abandoned = true;
      throw e;
    }
  };
  /** Fija y VERIFICA la sesión de una conexión del lock; false si no quedó como se pidió. */
  const prepareLockSession = async (c, run) => {
    await run(() => c.query(LOCK_SESSION_SQL.set, [DB_TIMEZONE]));
    const [[row]] = await run(() => c.query(LOCK_SESSION_SQL.check));
    return lockSessionOk(row);
  };

  /** Renueva la clave y la fila EN PARALELO. false (y abort) si la exclusión ya no está garantizada. Nunca lanza. */
  const verifyExclusion = async () => {
    const [r, m] = await Promise.allSettled([op('redis', () => lock.renew()), op('lockConn', () => mysqlLock.renew())]);
    if (r.status === 'fulfilled' && !r.value) lost.redis = true;
    if (m.status === 'fulfilled' && !m.value) lost.mysql = true;
    if (r.status === 'rejected') { abort(failure(r.reason, 'redis_no_disponible')); return false; }
    if (m.status === 'rejected') { abort(failure(m.reason, 'exclusion_no_garantizada')); return false; }
    if (lost.redis || lost.mysql) { abort('lock_perdido'); return false; }
    return true;
  };
  /** Una sola verificación a la vez: la del temporizador y la previa a cada intento no se pisan. */
  const verifySerial = () => {
    if (!renewing) renewing = verifyExclusion().finally(() => { renewing = null; });
    return renewing;
  };
  const scheduleRenew = () => {
    renewTimer = setTimeout(() => {
      if (state.abort || stop.fired) return;
      verifySerial().then(() => { if (!state.abort && !stop.fired) scheduleRenew(); });
    }, opts.renewS * 1000);
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
        // La clave viaja sólo por el canal IPC (nunca por argumentos ni variables de entorno).
        corte: opts.cutoff ? { hasta: opts.cutoff, clave: env.PILOT_CORTE_CLAVE || null } : null,
        reloj: {
          ip_address: device.ip_address,
          port: device.port,
          connection_mode: device.connection_mode,
          timeout_ms: device.timeout_ms,
        },
      });
    } catch { kill('error_proceso'); }
  });

  /**
   * Mata en el servidor la sesión vieja del lock MySQL y espera a que su hilo desaparezca: después,
   * nada de lo que esa conexión tenga en vuelo puede aplicarse. true sólo si se confirmó.
   */
  const killMysqlSession = async (c, run, threadId) => {
    try {
      await run(() => c.query(MYSQL_KILL_SQL.kill, [threadId]));
    } catch (e) {
      const errno = e instanceof BoundedError && e.motivo === 'error' && e.cause ? e.cause.errno : null;
      if (errno !== ER_NO_SUCH_THREAD) return false;
    }
    for (;;) {
      const [[row]] = await run(() => c.query(MYSQL_KILL_SQL.alive, [threadId]));
      if (Number(row.n) === 0) return true;
      if (closeLeft() <= KILL_POLL_MS) return false;
      await sleep(KILL_POLL_MS);
    }
  };

  /**
   * Libera o compensa por un cliente NUEVO cuando el anterior se canceló. Con una toma INCIERTA,
   * antes mata la sesión vieja en el servidor (`CLIENT KILL ID` / `KILL CONNECTION`). Todo el
   * camino (conectar, sesión, matar, sentencia) va dentro del presupuesto de cierre, y el cliente
   * se descarta sin esperar. Devuelve { mine, killed }.
   */
  const viaFreshRedis = async (which, releaseWith) => {
    const c = createRedisClient(env.REDIS_URL || 'redis://localhost:6379', { connectTimeoutMs: Math.max(1, closeLeft()) });
    const run = (f) => bounded('redis', f, { capMs: closeLeft(), cancel: () => c.disconnect().catch(() => {}) });
    try {
      await run(() => c.connect());
      let killed = false;
      if (uncertain[which] && sessionIds.redis !== null) {
        // 1 si la cerró, 0 si ya no existía: en los dos casos la sesión vieja ya no ejecuta nada.
        try { await run(() => c.sendCommand(['CLIENT', 'KILL', 'ID', String(sessionIds.redis)])); killed = true; } catch { /* sin confirmar */ }
      }
      return { mine: await run(() => releaseWith(c)), killed };
    } finally {
      try { await c.disconnect(); } catch { /* no conectado */ }
    }
  };
  const viaFreshMysql = async (which, releaseWith) => {
    let c = null;
    const run = (f) => bounded('mysql', f, { capMs: closeLeft(), cancel: () => hardCancelMysql(c) });
    try {
      c = await connectMysql(run, Math.max(1, closeLeft()));
      // autocommit explícito: el DELETE por token tiene que quedar confirmado (no usa NOW()).
      await run(() => c.query(LOCK_SESSION_SQL.set, [DB_TIMEZONE]));
      let killed = false;
      if (uncertain[which] && sessionIds.lockConn !== null) {
        try { killed = await killMysqlSession(c, run, sessionIds.lockConn); } catch { /* sin confirmar */ }
      }
      return { mine: await run(() => releaseWith(c)), killed };
    } finally {
      hardCancelMysql(c);
    }
  };

  /**
   * Libera la clave o la fila sólo si siguen siendo nuestras y el hijo terminó: primero por el MISMO
   * cliente si sigue vivo (queda en orden detrás de todo lo enviado antes, también de una toma
   * incierta); si no responde, por uno nuevo. Una toma INCIERTA se compensa igual, por token: nunca
   * toca lo ajeno.
   *   liberado | perdido | por_ttl       (tomada)
   *   compensado                         (incierta: confirmado que no queda nada nuestro)
   *   incierto                           (incierta sin confirmar: vence en ttl_provisional_s)
   *   no_tomado                          (nunca se tomó)
   */
  const releaseOne = async (which) => {
    if (!held[which] && !uncertain[which]) return 'no_tomado';
    if (lost[which]) return 'perdido';
    if (closeUnconfirmed) return 'por_ttl';
    const failed = held[which] ? 'por_ttl' : 'incierto';
    const slot = which === 'redis' ? 'redis' : 'lockConn';
    const releaseWith = (c) => (which === 'redis'
      ? createPilotLock({ redis: c, deviceId: opts.deviceId, ttlMs, token: lock.token }).release()
      : createMysqlLock({ conn: c, deviceId: opts.deviceId, ttlS: ttlSecondsFor(opts), token: lock.token, owner: '' }).release());
    if (!dead[slot]) {
      try {
        const mine = await closeOp(slot, () => releaseWith(which === 'redis' ? redis : lockConn));
        // Por el mismo cliente, en orden: si la toma incierta se aplicó, esto la borró.
        return held[which] ? (mine ? 'liberado' : 'perdido') : 'compensado';
      } catch (e) {
        // Una respuesta del servidor (p. ej. sin permiso) no cambia con otro cliente.
        if (!outcomeUncertain(e, kindOf(slot))) return failed;
        cancel[slot]();
      }
    }
    let r;
    try {
      r = await (which === 'redis' ? viaFreshRedis : viaFreshMysql)(which, releaseWith);
    } catch {
      return failed;
    }
    if (held[which]) return r.mine ? 'liberado' : 'perdido';
    // Borrada (se había aplicado: una toma se aplica una sola vez) o sesión vieja muerta antes de mirar.
    return r.mine || r.killed ? 'compensado' : 'incierto';
  };
  /** Redis se cierra SIEMPRE con disconnect(): sin QUIT, sin ida y vuelta que pueda colgarse. */
  const closeRedis = async () => {
    if (!redis) return null;
    if (dead.redis) return 'forzado';
    const how = redis.isOpen ? 'normal' : 'no_conectado';
    try { await redis.disconnect(); } catch { /* ya cerrado */ }
    return how;
  };
  /** end() acotado y, SIEMPRE después, el socket destruido: end() resuelto no garantiza socket cerrado. */
  const closeMysql = async (slot) => {
    if (closed[slot]) return closed[slot];
    const c = slot === 'conn' ? conn : lockConn;
    if (!c) return null;
    let how = 'forzado';
    // (Tras la gracia, un cliente con algo todavía en vuelo ya quedó cancelado: `dead`.)
    if (!dead[slot] && closeLeft() > 0) {
      try { await closeOp(slot, () => c.end()); how = 'normal'; } catch { /* forzado */ }
    }
    hardCancelMysql(c);
    closed[slot] = how;
    return how;
  };

  // Cuerpo en una función propia: cualquier salida temprana pasa por `finally`
  // (liberación ordenada) y después se arma el resultado.
  await (async () => {
    try {
      // 0) Corte común: un instante ya pasado (hora de pared de Paraguay) y con margen respecto de ahora.
      if (opts.cutoff) {
        const nowPy = pyDateTimeStr(new Date());
        if (opts.cutoff > nowPy) { resultado = 'corte_futuro'; return; }
        if (opts.cutoff > addMinutesWall(nowPy, -CUTOFF_MARGIN_MIN)) { resultado = 'corte_reciente'; return; }
      }

      // 1) MySQL: sesión de sólo lectura para el reloj (se cierra apenas se lee).
      try {
        conn = await connectMysql((f) => op('conn', f));
        await op('conn', () => conn.query('SET SESSION TRANSACTION READ ONLY'));
      } catch (e) { resultado = failure(e, 'base_no_disponible'); return; }
      if (state.abort) { resultado = state.abort; return; }

      let rows;
      try {
        [rows] = await op('conn', () => conn.query(
          'SELECT id, ip_address, port, connection_mode, timeout_ms FROM devices WHERE id = ? LIMIT 1', [opts.deviceId],
        ));
      } catch (e) { resultado = failure(e, 'base_no_disponible'); return; }
      await closeMysql('conn');
      if (!rows.length) { resultado = 'reloj_inexistente'; return; }
      const device = rows[0];
      json.reloj.modo_conexion = device.connection_mode || 'auto';
      if (!device.ip_address || !String(device.ip_address).trim()) { resultado = 'reloj_sin_direccion'; return; }
      if (state.abort) { resultado = state.abort; return; }
      // Si ya no cabe ni un intento, no se toman los locks para nada.
      if (deadline - Date.now() < attemptMs) { resultado = 'limite_total'; return; }

      // 2) Exclusión: clave en Redis (sin auditoría, sin DDL)…
      try {
        redis = createRedisClient(env.REDIS_URL || 'redis://localhost:6379', {
          onError: () => { if (held.redis) abort('redis_no_disponible'); },
        });
        await op('redis', () => redis.connect());
      } catch (e) { resultado = failure(e, 'redis_no_disponible'); return; }
      try {
        sessionIds.redis = await op('redis', () => redis.clientId());
      } catch (e) {
        if (outcomeUncertain(e, 'redis')) { resultado = failure(e, 'redis_no_disponible'); return; }
        // Sin permiso para CLIENT ID: una toma incierta no podrá anularse (se informará 'incierto').
      }
      lock = createPilotLock({ redis, deviceId: opts.deviceId, ttlMs });
      let acquired;
      try {
        // TTL provisional: la verificación previa al primer intento lo lleva al completo.
        acquired = await op('redis', () => lock.acquire(PROVISIONAL_TTL_S * 1000));
      } catch (e) {
        uncertain.redis = outcomeUncertain(e, 'redis');
        resultado = failure(e, 'redis_no_disponible');
        return;
      }
      if (!acquired) { resultado = 'reloj_ocupado'; return; }
      held.redis = true;
      if (state.abort) { resultado = state.abort; return; }

      // …y la fila propia en device_locks, con una conexión aparte que NO es de sólo lectura.
      try {
        lockConn = await connectMysql((f) => op('lockConn', f));
        sessionIds.lockConn = Number.isInteger(lockConn.threadId) ? lockConn.threadId : null;
        if (!(await prepareLockSession(lockConn, (f) => op('lockConn', f)))) {
          json.exclusion.mysql.estado = 'sesion_invalida';
          resultado = 'exclusion_no_garantizada';
          return;
        }
      } catch (e) {
        json.exclusion.mysql.estado = 'sin_conexion';
        resultado = failure(e, 'exclusion_no_garantizada');
        return;
      }
      mysqlLock = createMysqlLock({
        conn: lockConn, deviceId: opts.deviceId, ttlS: ttlSecondsFor(opts), token: lock.token,
        owner: `piloto:${os.hostname()}:${process.pid}`,
      });
      try {
        const st = await op('lockConn', () => mysqlLock.acquire(() => stop.fired, PROVISIONAL_TTL_S));
        json.exclusion.mysql.estado = st;
        if (st !== 'tomado') { resultado = 'lock_mysql_vigente'; return; }
        held.mysql = true;
      } catch (e) {
        uncertain.mysql = outcomeUncertain(e, 'mysql');
        if (!(e instanceof BoundedError) || e.motivo === 'error') json.exclusion.mysql.estado = mysqlLockError(e && e.cause);
        else json.exclusion.mysql.estado = e.motivo === 'detenido' ? 'detenido' : 'sin_respuesta';
        resultado = failure(e, 'exclusion_no_garantizada');
        return;
      }
      if (state.abort) { resultado = state.abort; return; }
      scheduleRenew();

      // 3) Intentos, cada uno en su proceso.
      let selected = null;
      let captureFailed = false;
      let stoppedByLimit = false;
      for (let n = 1; n <= opts.attempts; n += 1) {
        if (state.abort) break;
        if (deadline - Date.now() < attemptMs) { stoppedByLimit = true; break; }
        if (renewing) await renewing;            // acotada: termina o deja de esperarse
        if (state.abort) break;
        const sentAt = Date.now();          // ANTES de enviar: la clave y la fila vencen después de sentAt + TTL
        if (!(await verifySerial())) break;
        // Renovación lenta: a la clave/fila podría quedarles menos vida que al hijo.
        if (Date.now() - sentAt > FRESH_RENEW_MS) { abort('exclusion_no_garantizada'); break; }
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
        // El bloque del corte va arriba; `lectura` conserva la forma del agregado completo.
        const { corte, ...lectura } = selected;
        if (corte) json.corte = corte;
        json.lectura = lectura;
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
      clearTimeout(renewTimer);
      stop.fire();
      closeDeadline = Date.now() + CLOSE_BUDGET_MS;
      // Lo que siga en vuelo (p. ej. una renovación sobre una conexión colgada) tiene una gracia
      // corta; si no termina, ese cliente se cancela y se libera por uno nuevo.
      await Promise.all(SLOTS.map(async (slot) => {
        if (!pending[slot].size) return;
        await waitAtMost(Promise.all([...pending[slot]]), Math.min(STOP_GRACE_MS, closeLeft()));
        if (pending[slot].size) cancel[slot]();
      }));
      // La clave y la fila se liberan sólo con el hijo terminado, si siguen siendo nuestras;
      // primero las dos liberaciones y después TODOS los cierres, dentro del presupuesto.
      [json.liberacion.redis, json.liberacion.mysql] = await Promise.all([releaseOne('redis'), releaseOne('mysql')]);
      const [redisClose, mysqlLockClose, mysqlClose] = await Promise.all([closeRedis(), closeMysql('lockConn'), closeMysql('conn')]);
      json.cierre_clientes = { redis: redisClose, mysql: mysqlClose, mysql_lock: mysqlLockClose };
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

module.exports = {
  runPilot, skeletonFor, ttlSecondsFor, childEnv, EXIT_CODES, SIGNALS, FORMAT, CHILD,
  OP_TIMEOUT_MS, CLOSE_OP_MS, CLOSE_MAX_S, CLOSE_BUDGET_MS, STOP_GRACE_MS, FRESH_RENEW_MS, CUTOFF_MARGIN_MIN,
};
