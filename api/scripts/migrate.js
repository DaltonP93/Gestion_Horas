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
 *   node api/scripts/migrate.js                    # aplica pendientes
 *   node api/scripts/migrate.js --status           # lista estado, no aplica
 *   node api/scripts/migrate.js --baseline=<archivo>
 *          # marca como aplicadas (sin ejecutar) las migraciones HASTA e
 *          # incluyendo <archivo>, para adoptar el runner en una BD que ya
 *          # las tiene aplicadas a mano. Las migraciones MÁS NUEVAS que
 *          # <archivo> quedan pendientes y se ejecutan con `migrate`.
 *          # Ej: --baseline=039_fix_attendance_source_selfcheckin.sql
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
    const files = listMigrationFiles();

    // --status debe ser ESTRICTAMENTE READ-ONLY. Antes este comando ejecutaba
    // CREATE TABLE IF NOT EXISTS schema_migrations, lo que violaba el contrato
    // de preflight en producción. Primero se inspecciona INFORMATION_SCHEMA;
    // si la tabla de control todavía no existe, se reportan todas las
    // migraciones como pendientes sin crear absolutamente nada.
    const [schemaRows] = await conn.query(
      `SELECT 1 AS ok
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'schema_migrations'
        LIMIT 1`,
    );
    const schemaMigrationsExists = Boolean(schemaRows[0]);

    let done = new Set();
    if (schemaMigrationsExists) {
      const [applied] = await conn.query('SELECT filename FROM schema_migrations');
      done = new Set(applied.map(r => r.filename));
    }

    const pending = files.filter(f => !done.has(f));
    console.log(`Migraciones: ${files.length} totales, ${done.size} aplicadas, ${pending.length} pendientes.`);

    if (statusOnly) {
      if (!schemaMigrationsExists) {
        console.log('  schema_migrations no existe; --status no la crea (modo read-only).');
      }
      pending.forEach(f => console.log(`  pendiente: ${f}`));
      return;
    }

    // Los modos que sí modifican estado (migrate/baseline) crean la tabla de
    // control si todavía no existe.
    if (!schemaMigrationsExists) {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename   VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }
    const baselineArg = process.argv.find(a => a === '--baseline' || a.startsWith('--baseline='));
    if (baselineArg) {
      const target = baselineArg.includes('=') ? baselineArg.split('=')[1].trim() : '';
      if (!target) {
        console.error('❌ --baseline requiere un archivo objetivo, p. ej.:');
        console.error('   node scripts/migrate.js --baseline=039_fix_attendance_source_selfcheckin.sql');
        console.error('   (marca como aplicadas SOLO las migraciones hasta e incluyendo ese archivo).');
        process.exit(1);
      }
      if (!files.includes(target)) {
        console.error(`❌ El archivo de baseline "${target}" no existe en database/migrations/.`);
        process.exit(1);
      }
      // Marcar como aplicadas solo las pendientes con nombre <= target (orden
      // lexicográfico = orden por prefijo numérico). Las nuevas quedan fuera.
      const toBaseline = pending.filter(f => f <= target);
      const skipped = pending.filter(f => f > target);
      for (const file of toBaseline) {
        await conn.query('INSERT IGNORE INTO schema_migrations (filename) VALUES (?)', [file]);
      }
      console.log(`✅ Baseline hasta ${target}: ${toBaseline.length} marcada(s) como aplicada(s) sin ejecutar.`);
      if (skipped.length) {
        console.log(`   ${skipped.length} migración(es) más nueva(s) quedan PENDIENTES (ejecutá "npm run migrate"):`);
        skipped.forEach(f => console.log(`     - ${f}`));
      }
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
