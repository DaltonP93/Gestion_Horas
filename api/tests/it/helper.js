'use strict';

/**
 * helper.js — utilidades para tests de INTEGRACIÓN contra un MySQL efímero.
 *
 * Se activan sólo con IT_DB=1 y variables DB_* apuntando a una base de PRUEBAS
 * descartable (nunca producción). Sin IT_DB, los `describeIT` se saltan, de modo
 * que la suite normal (pura/mockeada) sigue corriendo sin base.
 */

const mysql = require('mysql2/promise');

const IT_ENABLED = process.env.IT_DB === '1';

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || '3307'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'testpw',
  database: process.env.DB_NAME || 'asistencia',
  multipleStatements: true,
};

const describeIT = IT_ENABLED ? describe : describe.skip;

async function makeConn() {
  return mysql.createConnection(cfg);
}

/** Cierra el pool de sequelize de la app (evita handles abiertos en jest). */
async function closeAppDb() {
  try {
    const { sequelize } = require('../../src/config/database');
    await sequelize.close();
  } catch { /* noop */ }
}

module.exports = { IT_ENABLED, cfg, describeIT, makeConn, closeAppDb };
