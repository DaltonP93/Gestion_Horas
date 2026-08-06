/**
 * schemaState.js — distinguir "la tabla no existe" de "la base falló".
 *
 * Nace del error de producción:
 *
 *   ER_NO_SUCH_TABLE  stage: load_schedules  sqlState: 42S02
 *
 * Tratar toda excepción de base como un error genérico obliga a leer un stack
 * para saber si falta una migración o si se cayó MySQL, que son dos problemas
 * con dos respuestas distintas. Y tratarlas todas como "falta una tabla" es
 * peor: escondería una caída real detrás de un mensaje tranquilizador.
 */

'use strict';

/** MySQL: 42S02 = base table or view not found. */
const MISSING_TABLE_SQLSTATE = '42S02';
const MISSING_TABLE_CODE = 'ER_NO_SUCH_TABLE';

/**
 * Sequelize envuelve el error del driver. Según la versión y el camino, el
 * original aparece en `.parent` o en `.original`, y a veces el envoltorio ya
 * copió `code`/`sqlState` a la raíz. Se miran los tres.
 */
function capasDeError(err) {
  const capas = [];
  let actual = err;
  for (let i = 0; actual && i < 4; i++) {
    capas.push(actual);
    actual = actual.parent || actual.original || actual.cause;
  }
  return capas;
}

/** ¿El error dice que la tabla no existe? */
function isMissingTableError(err) {
  if (!err) return false;
  return capasDeError(err).some(
    (e) => e && (e.code === MISSING_TABLE_CODE || e.sqlState === MISSING_TABLE_SQLSTATE),
  );
}

/**
 * Nombre de la tabla ausente, si el mensaje lo trae.
 *
 * MySQL dice: Table 'asistencia.external_hr_sources' doesn't exist
 * Se devuelve sólo la parte de la tabla: el nombre de la base no aporta al
 * diagnóstico y es información del entorno.
 */
function missingTableName(err) {
  for (const e of capasDeError(err)) {
    const texto = e && (e.sqlMessage || e.message);
    if (typeof texto !== 'string') continue;
    const m = texto.match(/Table\s+'(?:[^'.]+\.)?([^']+)'\s+doesn't exist/i);
    if (m) return m[1];
  }
  return null;
}

module.exports = {
  isMissingTableError,
  missingTableName,
  MISSING_TABLE_CODE,
  MISSING_TABLE_SQLSTATE,
};
