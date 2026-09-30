'use strict';

/**
 * scopeGrant.js — emisión y verificación del alcance GLOBAL.
 *
 * El acceso sin restricción no se deduce de un objeto con `unrestricted: true`:
 * sólo cuenta el alcance que el servidor emite al resolver la identidad
 * (departmentScope.getVisibleDepartmentIds / orgScope.getOrgScope para un rol
 * global). Un literal `{ unrestricted: true }`, un alcance ausente, `null` o
 * mal formado NO es global: los consumidores lo tratan como vacío (listados
 * sin filas, predicados en false) o rechazan la operación.
 *
 * `issueGlobal` sólo debe llamarse desde los resolutores de alcance; una prueba
 * estática (scopeMandatory.test.js) verifica que ningún otro módulo lo use.
 */

const GLOBAL_GRANTS = new WeakSet();

/** Emite un alcance global (objeto congelado registrado). */
function issueGlobal() {
  const scope = Object.freeze({ unrestricted: true });
  GLOBAL_GRANTS.add(scope);
  return scope;
}

/** ¿Es un alcance global emitido por el servidor? */
function isGlobal(scope) {
  return scope !== null && typeof scope === 'object' && GLOBAL_GRANTS.has(scope);
}

const isIdList = (v) => Array.isArray(v) && v.every((x) => Number.isSafeInteger(x) && x > 0);

/**
 * ¿Es un alcance RESTRINGIDO bien formado? `unrestricted === false` y cada
 * clave pedida es una lista de ids enteros positivos (puede estar vacía).
 * `optional` se valida sólo si viene.
 */
function isRestricted(scope, required = [], optional = []) {
  if (scope === null || typeof scope !== 'object' || scope.unrestricted !== false) return false;
  if (!required.every((k) => isIdList(scope[k]))) return false;
  return optional.every((k) => scope[k] === undefined || isIdList(scope[k]));
}

module.exports = { issueGlobal, isGlobal, isRestricted };
