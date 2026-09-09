#!/usr/bin/env node
'use strict';

/**
 * preflight-mysql-check.js — verifica `assertNoDefaultAdminCredential` contra una
 * BD MySQL real, para pruebas en una base DESCARTABLE. NUNCA usar contra producción.
 *
 * Conexión por variables de entorno (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME).
 * Imprime sólo el resultado o el código de bloqueo; nunca contraseñas ni hashes.
 *
 * Salida: exit 0 = OK (sin credencial demo); exit 3 = BLOQUEADO (código impreso).
 */

const mysql = require('mysql2/promise');
const { assertNoDefaultAdminCredential } = require('../src/config/securityPreflight');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'asistencia',
    multipleStatements: false,
  });
  // Adaptador mínimo con la firma que usa el preflight: query(sql) -> [rows, meta].
  const sequelize = { query: (sql) => conn.query(sql) };
  try {
    const r = await assertNoDefaultAdminCredential({ sequelize, env: { NODE_ENV: 'production' } });
    console.log('RESULT:', JSON.stringify(r));
    process.exitCode = 0;
  } catch (e) {
    console.log('BLOCKED:', e.code || 'UNKNOWN');
    process.exitCode = 3;
  } finally {
    await conn.end();
  }
})().catch((e) => { console.log('SCRIPT_ERROR:', e.code || e.message); process.exitCode = 2; });
