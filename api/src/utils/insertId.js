'use strict';

/**
 * insertId.js — contrato del id generado por un INSERT crudo de Sequelize.
 *
 * `sequelize.query('INSERT INTO ...')` SIN `type` corre como RAW y, en
 * Sequelize 6 con el dialecto mysql, resuelve a `[insertId, affectedRows]`
 * donde `insertId` es un NÚMERO, no un `OkPacket`. Por eso el patrón
 * `const [r] = await sequelize.query('INSERT ...'); r.insertId` devuelve
 * `undefined`: se estaba leyendo `.insertId` de un número.
 *
 * (Verificado en `sequelize/lib/dialects/mysql/query.js`: para una query RAW
 * cuyo SQL empieza con `insert into`, `formatResults` devuelve
 * `[data[getInsertIdField()], data.affectedRows]`.)
 *
 * Esta función normaliza ambas formas: si recibe el número, lo devuelve; si
 * algún camino entregara un objeto con `.insertId` (p. ej. un `OkPacket`),
 * también lo resuelve. Es el único lugar donde vive esa ambigüedad.
 *
 * Uso:
 *   const [r] = await sequelize.query('INSERT INTO t (...) VALUES (...)', {...});
 *   const id = insertId(r);
 */
function insertId(result) {
  if (result == null) return null;
  if (typeof result === 'object') {
    return result.insertId != null ? result.insertId : null;
  }
  return result;
}

module.exports = { insertId };
