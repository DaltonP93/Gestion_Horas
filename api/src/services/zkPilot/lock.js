'use strict';

/**
 * lock.js — exclusión del piloto de estados con el resto de las lecturas.
 *
 * Usa la MISMA clave de Redis que el helper habitual (deviceLockKeys.js), con
 * SET NX PX y renovación/liberación por token (Lua). A diferencia del helper
 * habitual (deviceLock.js) NO audita en MySQL, NO cae a la tabla device_locks
 * y NO crea tablas: si Redis no está, el piloto no lee.
 *
 * Redis libre no prueba que no haya un lock MySQL: un proceso que no alcanzó
 * Redis toma el fallback device_locks. Por eso el piloto, además, CONSULTA
 * (sólo SELECT) esa tabla al tomar el lock, antes de cada intento y en cada
 * renovación, y aborta si hay un lock vigente o si no puede consultarla.
 */
const crypto = require('crypto');
const { keyFor, RENEW_LUA, RELEASE_LUA } = require('../deviceLockKeys');

/** Cliente Redis sin reconexión automática: una caída es un error, no una espera. */
async function connectRedis(url, { connectTimeoutMs = 3000, onError = () => {} } = {}) {
  const { createClient } = require('redis');
  const client = createClient({ url, socket: { connectTimeout: connectTimeoutMs, reconnectStrategy: false } });
  client.on('error', onError);
  await client.connect();
  return client;
}

/**
 * @param {{ redis:object, deviceId:number, ttlMs:number }} p
 * acquire() → true si se tomó; false si otro lo tiene. renew()/release() → true
 * sólo si la clave seguía siendo nuestra. Los errores de Redis se propagan.
 */
function createPilotLock({ redis, deviceId, ttlMs }) {
  const key = keyFor(deviceId);
  const token = `pilot:${crypto.randomBytes(16).toString('hex')}`;
  return {
    key,
    token,
    ttlMs,
    async acquire() {
      return (await redis.set(key, token, { NX: true, PX: ttlMs })) === 'OK';
    },
    async renew() {
      return Number(await redis.eval(RENEW_LUA, { keys: [key], arguments: [token, String(ttlMs)] })) === 1;
    },
    async release() {
      return Number(await redis.eval(RELEASE_LUA, { keys: [key], arguments: [token] })) === 1;
    },
  };
}

/**
 * Consulta de SOLO LECTURA del fallback MySQL del lock habitual.
 * @returns {'sin_tabla'|'sin_lock_vigente'|'lock_vigente'}  (lanza si no puede consultar)
 */
async function checkMysqlLock(conn, deviceId) {
  const [[t]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_locks'",
  );
  if (Number(t.n) === 0) return 'sin_tabla';
  const [[l]] = await conn.query('SELECT COUNT(*) AS n FROM device_locks WHERE device_id = ? AND expires_at > NOW()', [deviceId]);
  return Number(l.n) > 0 ? 'lock_vigente' : 'sin_lock_vigente';
}

module.exports = { connectRedis, createPilotLock, checkMysqlLock };
