#!/usr/bin/env node
/**
 * migrate.js — Runner de migraciones SQL con tabla de control.
 *
 * Aplica en orden los archivos database/migrations/*.sql que aún no se hayan
 * ejecutado y registra cada uno en `schema_migrations`. Idempotente: correrlo
 * de nuevo no reaplica lo ya hecho.
 *
 * Las migraciones usan `DELIMITER` (procedimientos almacenados), que es una
 * directiva del cliente `mysql`, no SQL — por eso cada archivo se aplica con
 * el cliente `mysql` (igual que la operación manual documentada), mientras que
 * el control de estado se lleva con mysql2.
 *
 * Uso:
 *   node api/scripts/migrate.js            # aplica pendientes
 *   node api/scripts/migrate.js --status   # solo lista estado, no aplica
 *   node api/scripts/migrate.js --baseline # marca TODAS como aplicadas sin
 *                                          # ejecutarlas (adopción del runner
 *                                          # en una BD que ya las tiene)
 *
 * Requiere: cliente `mysql` en el PATH y las variables DB_* del entorno.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'asistencia',
};

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'database', 'migrations');

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // 001_, 002_, ... — orden lexicográfico correcto por el prefijo numérico
}

function applyWithMysqlClient(file) {
  const full = path.join(MIGRATIONS_DIR, file);
  const args = ['-h', DB.host, '-P', String(DB.port), '-u', DB.user, DB.database];
  const res = spawnSync('mysql', args, {
    input: fs.readFileSync(full),
    env: { ...process.env, MYSQL_PWD: DB.password }, // evita exponer la clave en argv
    encoding: 'utf8',
  });
  if (res.error) throw new Error(`No se pudo ejecutar el cliente mysql: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`mysql salió con código ${res.status}: ${res.stderr || res.stdout}`);
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  const conn = await mysql.createConnection(DB);
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [applied] = await conn.query('SELECT filename FROM schema_migrations');
    const done = new Set(applied.map(r => r.filename));
    const files = listMigrationFiles();
    const pending = files.filter(f => !done.has(f));

    console.log(`Migraciones: ${files.length} totales, ${done.size} aplicadas, ${pending.length} pendientes.`);
    if (statusOnly) {
      pending.forEach(f => console.log(`  pendiente: ${f}`));
      return;
    }
    if (process.argv.includes('--baseline')) {
      for (const file of pending) {
        await conn.query('INSERT IGNORE INTO schema_migrations (filename) VALUES (?)', [file]);
      }
      console.log(`✅ Baseline: ${pending.length} migración(es) marcada(s) como aplicada(s) sin ejecutar.`);
      return;
    }
    if (pending.length === 0) { console.log('✅ Nada por aplicar.'); return; }

    for (const file of pending) {
      process.stdout.write(`→ Aplicando ${file} ... `);
      applyWithMysqlClient(file);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log('OK');
    }
    console.log(`✅ ${pending.length} migración(es) aplicada(s).`);
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('❌ Error en migración:', err.message);
  process.exit(1);
});
