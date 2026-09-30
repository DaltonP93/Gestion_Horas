'use strict';

/**
 * scopes.js — alcances para pruebas, obtenidos del emisor REAL.
 *
 * Desde que el alcance global sólo cuenta si lo emitió el servidor
 * (services/scopeGrant.js), las pruebas que simulan un rol global deben usar
 * `issuedGlobal()` en vez del literal `{ unrestricted: true }`, que la app
 * rechaza (fail-closed).
 */
const scopeGrant = require('../../src/services/scopeGrant');

/** Alcance global emitido, equivalente al que recibe un rol global resuelto. */
function issuedGlobal() {
  return scopeGrant.issueGlobal();
}

module.exports = { issuedGlobal };
