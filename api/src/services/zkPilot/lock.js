'use strict';

/**
 * lock.js — exclusión del piloto de estados con el resto de las lecturas.
 *
 * El helper habitual (deviceLock.js) usa Redis si ESE proceso lo alcanza y, si
 * no, la tabla device_locks; su fallback nunca mira Redis. Consultar la tabla
 * de vez en cuando no impide que un proceso habitual en fallback la tome entre
 * dos consultas. Por eso el piloto toma los DOS backends del mismo protocolo, y
 * sólo lee con ambos tomados:
 *
 *   - Redis: la MISMA clave que el helper habitual (deviceLockKeys.js), SET NX PX,
 *     renovación y liberación por token (Lua).
 *   - MySQL: SU PROPIA fila de device_locks (PK device_id), con las mismas
 *     sentencias que el fallback habitual: borrar la fila VENCIDA de ese reloj,
 *     INSERT (duplicado ⇒ ocupado), renovar y borrar por token. Sólo esa tabla y
 *     sólo ese device_id; nunca CREATE TABLE ni auditoría.
 *
 * Así un proceso habitual por Redis choca con la clave y uno en fallback con la
 * fila. Lo que sigue sin excluirse son dos procesos HABITUALES en backends
 * distintos: corregirlo exige cambiar el helper habitual (ver el diseño).
 *
 * La fila guarda expires_at como DATETIME SIN zona, y el helper habitual lo
 * escribe y compara con NOW() en la zona de sesión de la app (Sequelize:
 * DB_TIMEZONE). La conexión del lock fija esa MISMA zona y la verifica: con la
 * zona del servidor (UTC en CI) la fila viva del worker parecería vencida.
 * También fija autocommit (una sentencia = una transacción: nunca retiene
 * bloqueos de hueco sobre otros relojes) y esperas de bloqueo del SERVIDOR por
 * debajo del tope del cliente (el servidor abandona antes: sin escrituras
 * fantasma), y exige una base escribible (no una réplica).
 */
const crypto = require('crypto');
const { keyFor, RENEW_LUA, RELEASE_LUA } = require('../deviceLockKeys');

/**
 * Cliente Redis SIN conectar y sin reconexión automática: un cierre es un error,
 * no una espera. `connectTimeout` sólo cubre el TCP; un servidor mudo no lo es,
 * así que quien lo usa conecta con tope (bounded.js) y puede cancelarlo
 * (disconnect) aunque la conexión no haya terminado. Sin CLIENT SETINFO al
 * conectar (una ida y vuelta menos que pueda colgarse) y sin cola offline (un
 * comando con el socket no listo falla al instante, no espera).
 * Cancelar es SIEMPRE `disconnect()`: nunca `quit()` (deja el socket abierto si
 * no responde) ni AbortSignal (no retira un comando ya enviado).
 */
function createRedisClient(url, { connectTimeoutMs = 3000, onError = () => {} } = {}) {
  const { createClient } = require('redis');
  const client = createClient({
    url,
    socket: { connectTimeout: connectTimeoutMs, reconnectStrategy: false },
    disableOfflineQueue: true,
    disableClientInfo: true,
  });
  client.on('error', onError);
  return client;
}

/**
 * TTL PROVISIONAL de la toma (clave y fila). La verificación previa a cada intento las renueva al TTL
 * completo justo antes de lanzar la lectura; si la toma quedó en vuelo y se aplicó tarde (incierta),
 * lo huérfano vence en este plazo y no en el TTL completo.
 */
const PROVISIONAL_TTL_S = 30;

/**
 * @param {{ redis:object, deviceId:number, ttlMs:number, token?:string }} p
 * `token`: el de una toma anterior (para liberar por otro cliente); si falta, uno nuevo.
 * acquire(pxMs) → true si se tomó (con ese TTL; por omisión el completo); false si otro lo tiene.
 * renew()/release() → true sólo si la clave seguía siendo nuestra. Los errores de Redis se propagan.
 */
function createPilotLock({ redis, deviceId, ttlMs, token = `pilot:${crypto.randomBytes(16).toString('hex')}` }) {
  const key = keyFor(deviceId);
  return {
    key,
    token,
    ttlMs,
    async acquire(pxMs = ttlMs) {
      return (await redis.set(key, token, { NX: true, PX: pxMs })) === 'OK';
    },
    async renew() {
      return Number(await redis.eval(RENEW_LUA, { keys: [key], arguments: [token, String(ttlMs)] })) === 1;
    },
    async release() {
      return Number(await redis.eval(RELEASE_LUA, { keys: [key], arguments: [token] })) === 1;
    },
  };
}

/** La MISMA zona de sesión que usa la app (config/database.js DB_TIMEZONE); una prueba exige la igualdad. */
const DB_TIMEZONE = '-03:00';
/** Espera máxima de bloqueos en el servidor para la conexión del lock (menor que el tope del cliente). */
const SERVER_LOCK_WAIT_S = 2;

const LOCK_SESSION_SQL = Object.freeze({
  set: 'SET SESSION time_zone = ?, SESSION autocommit = 1, '
    + `SESSION innodb_lock_wait_timeout = ${SERVER_LOCK_WAIT_S}, SESSION lock_wait_timeout = ${SERVER_LOCK_WAIT_S}`,
  check: 'SELECT @@session.time_zone AS tz, @@session.autocommit AS ac, @@global.read_only AS ro, @@global.super_read_only AS sro',
});

/** true si la sesión del lock quedó como se pidió: zona de la app, autocommit y base escribible. */
function lockSessionOk(row) {
  return !!row && row.tz === DB_TIMEZONE && Number(row.ac) === 1 && Number(row.ro) === 0 && Number(row.sro) === 0;
}

/**
 * Un error de red sin comando activo (cancelación propia, cierre del servidor) se emite como evento
 * 'error' de la conexión; sin oyente, tiraría el proceso. Se registra uno, una sola vez.
 */
function guardMysqlErrors(conn) {
  const base = conn && conn.connection;
  if (!base || typeof base.on !== 'function' || base.pilotErrorGuard) return;
  base.pilotErrorGuard = true;
  base.on('error', () => {});
}

/**
 * Cancela DE VERDAD una conexión mysql2: destruye el socket con un error fatal, lo que rechaza al
 * instante el comando activo y los encolados. (`conn.destroy()` de mysql2 sólo cierra a medias:
 * deja lo pendiente sin resolver y el socket abierto si el servidor no responde.)
 */
function hardCancelMysql(conn) {
  const base = conn && conn.connection;
  const stream = base && base.stream;
  if (!stream || stream.destroyed) return;
  guardMysqlErrors(conn);
  const err = Object.assign(new Error('cancelado por el piloto'), { code: 'PILOT_CANCELLED', fatal: true });
  try { stream.destroy(err); } catch { /* ya cerrado */ }
}

/**
 * Sesión vieja del lock, en el SERVIDOR. Cancelar el cliente no retira una sentencia ya enviada (los
 * bytes en vuelo llegan igual); antes de compensar una toma incierta por otra conexión, la vieja se
 * mata y se espera a que su hilo desaparezca. El mismo usuario puede matar sus propias conexiones
 * sin privilegios globales, y en PROCESSLIST ve sólo las suyas.
 *
 * Un número de conexión sólo identifica una sesión dentro de UNA vida del servidor: tras un
 * reinicio o un cambio de servidor detrás de la misma dirección, el mismo número puede ser de otro
 * proceso. Por eso la identidad de la sesión es { hilo, HOST (ip:puerto del cliente visto por el
 * servidor), arranque del servidor }, se toma al abrir la conexión del lock y se vuelve a comprobar
 * antes de matar: si algo no coincide, no se mata nada.
 */
const MYSQL_KILL_SQL = Object.freeze({
  kill: 'KILL CONNECTION ?',
  session: 'SELECT HOST AS host FROM information_schema.PROCESSLIST WHERE ID = ?',
  uptime: "SHOW GLOBAL STATUS LIKE 'Uptime'",
});
/** ER_NO_SUCH_THREAD: la conexión ya no existe en el servidor. */
const ER_NO_SUCH_THREAD = 1094;
/** Tolerancia al comparar el instante de arranque del servidor (Uptime entero + ida y vuelta). */
const BOOT_TOLERANCE_MS = 2000;

/** Instante de arranque del servidor MySQL (reloj local) a partir de SHOW GLOBAL STATUS 'Uptime'. */
function mysqlBootMs(rows, now = Date.now()) {
  const row = Array.isArray(rows) ? rows.find((r) => r && /^uptime$/i.test(String(r.Variable_name))) : null;
  const up = row ? Number(row.Value) : NaN;
  return Number.isFinite(up) ? now - up * 1000 : null;
}

/**
 * ¿Respondió el SERVIDOR? Sólo un paquete de error de MySQL (errno positivo con SQLSTATE) prueba
 * que la sentencia no se aplicó. Un error de red de Node (ECONNRESET: errno -104, EPIPE…) también
 * trae errno entero, pero negativo: no prueba nada.
 */
function isMysqlServerError(err) {
  return !!err && Number.isInteger(err.errno) && err.errno > 0 && typeof err.sqlState === 'string';
}

/**
 * Identidad de la sesión Redis del lock: { id, addr, runId }. `CLIENT INFO` (id y dirección del
 * cliente vista por el servidor) e `INFO server` (run_id cambia en cada arranque). null si falta algo.
 */
function parseRedisIdentity(clientInfo, infoServer) {
  const id = /(?:^|\s)id=(\d+)/.exec(String(clientInfo || ''));
  const addr = /(?:^|\s)addr=(\S+)/.exec(String(clientInfo || ''));
  const runId = parseRunId(infoServer);
  return id && addr && runId ? { id: id[1], addr: addr[1], runId } : null;
}
function parseRunId(infoServer) {
  const m = /(?:^|\n)run_id:([0-9a-f]+)/i.exec(String(infoServer || ''));
  return m ? m[1] : null;
}

/** Sentencias del lock MySQL del piloto: las del fallback habitual, sólo sobre su fila. */
const MYSQL_LOCK_SQL = Object.freeze({
  purgeExpired: 'DELETE FROM device_locks WHERE device_id = ? AND expires_at < NOW()',
  insert: 'INSERT INTO device_locks (device_id, token, owner, job_id, origin, acquired_at, expires_at) '
    + 'VALUES (?, ?, ?, NULL, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))',
  renew: 'UPDATE device_locks SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE device_id = ? AND token = ?',
  release: 'DELETE FROM device_locks WHERE device_id = ? AND token = ?',
});
const MYSQL_ORIGIN = 'piloto_estados';

/**
 * Clasifica un error de MySQL del lock por su errno: SÓLO 1062 (duplicado) significa "otro tiene la
 * fila". Para un usuario sin privilegios a nivel de base, MySQL responde 1142 aunque la tabla no
 * exista: tabla ausente y falta de permiso no se distinguen ('sin_acceso').
 */
function mysqlLockError(err) {
  const src = err && (Number.isInteger(err.errno) ? err : err.cause);
  const errno = src && src.errno > 0 ? src.errno : null;
  if (errno === 1062) return 'ocupado';
  if (errno === 1142 || errno === 1044 || errno === 1146) return 'sin_acceso';
  if (errno === 1205 || errno === 1213) return 'espera_de_bloqueo';
  return 'error';
}

/** Filas encontradas por un UPDATE, sin depender del flag FOUND_ROWS del cliente. */
function rowsMatched(result) {
  const m = /Rows matched:\s*(\d+)/.exec((result && result.info) || '');
  return m ? Number(m[1]) : Number(result && result.affectedRows);
}

/**
 * @param {{ conn:object, deviceId:number, ttlS:number, token:string, owner:string }} p
 *   conn: conexión mysql2/promise PROPIA del lock (no la de sólo lectura), con la sesión ya fijada.
 * acquire(isStopped, ttlAcquireS) → 'tomado' | 'ocupado' (otro tiene una fila vigente); lanza ante
 * cualquier otro error, y no envía el INSERT si entre tanto se dejó de esperar (isStopped). La fila
 * nace con ttlAcquireS (por omisión el TTL completo). renew()/release() → true sólo si la fila seguía
 * siendo nuestra; renew() la lleva al TTL completo.
 */
function createMysqlLock({ conn, deviceId, ttlS, token, owner }) {
  const ownerCol = String(owner).slice(0, 64);
  return {
    token,
    async acquire(isStopped = () => false, ttlAcquireS = ttlS) {
      await conn.query(MYSQL_LOCK_SQL.purgeExpired, [deviceId]);
      if (isStopped()) throw Object.assign(new Error('detenido antes del INSERT'), { code: 'PILOT_STOPPED' });
      try {
        await conn.query(MYSQL_LOCK_SQL.insert, [deviceId, token, ownerCol, MYSQL_ORIGIN, ttlAcquireS]);
      } catch (err) {
        if (mysqlLockError(err) === 'ocupado') return 'ocupado';
        throw err;
      }
      return 'tomado';
    },
    async renew() {
      const [r] = await conn.query(MYSQL_LOCK_SQL.renew, [ttlS, deviceId, token]);
      return rowsMatched(r) > 0;
    },
    async release() {
      const [r] = await conn.query(MYSQL_LOCK_SQL.release, [deviceId, token]);
      return Number(r && r.affectedRows) > 0;
    },
  };
}

module.exports = {
  createRedisClient, createPilotLock, createMysqlLock, mysqlLockError, rowsMatched, hardCancelMysql, guardMysqlErrors,
  lockSessionOk, isMysqlServerError, mysqlBootMs, parseRedisIdentity, parseRunId,
  MYSQL_LOCK_SQL, MYSQL_KILL_SQL, ER_NO_SUCH_THREAD, BOOT_TOLERANCE_MS, MYSQL_ORIGIN, LOCK_SESSION_SQL, DB_TIMEZONE,
  SERVER_LOCK_WAIT_S, PROVISIONAL_TTL_S,
};
