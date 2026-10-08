'use strict';

/**
 * deviceLockKeys.js — clave y scripts Lua del lock por reloj en Redis.
 *
 * Única definición, compartida por el helper habitual (deviceLock.js: worker,
 * rutas y scripts de importación) y por el piloto aislado de estados
 * (zkPilot/lock.js). Si ambos no usaran exactamente la misma clave, el lock no
 * los excluiría entre sí.
 */
const keyFor = (id) => `zk:lock:dev:${id}`;

/** Renueva el TTL sólo si el valor sigue siendo el token del dueño. */
const RENEW_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";

/** Borra la clave sólo si el valor sigue siendo el token del dueño. */
const RELEASE_LUA = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

module.exports = { keyFor, RENEW_LUA, RELEASE_LUA };
