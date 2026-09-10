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
 *   node api/scripts/migrate.js --upto=<archivo>
 *          # aplica (ejecuta de verdad) SÓLO las pendientes con nombre <= ese
 *          # archivo, en orden. Las más nuevas quedan sin tocar. Lo usa la
 *          # consola de FASE E para aplicar el conjunto del motor hasta 075 sin
 *          # arrastrar migraciones posteriores (p. ej. 083).
 *          # Ej: --upto=075_workday_configuration_phase_c.sql
 *
 * Gate raíz (integridad de numeración): antes de aplicar, el runner rechaza
 * (exit 1) si hay números de migración DUPLICADOS en disco, o si una migración
 * PENDIENTE tiene número MENOR que el máximo ya aplicado (aplicarla la correría
 * fuera de secuencia). `--status` sólo lo REPORTA (read-only). El desorden se
 * puede forzar con `--allow-out-of-order` cuando el orden fue una decisión
 * explícita y verificada; los duplicados no tienen override.
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

/** Extrae el número de migración (prefijo NNN) del nombre de archivo, o null. */
function parseMigrationNumber(file) {
  const m = /^(\d+)/.exec(file);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Detecta números de migración DUPLICADOS entre los archivos en disco.
 * El runner llavea por NOMBRE de archivo en `schema_migrations`, así que dos
 * archivos con el mismo prefijo NNN pero contenido distinto harían que el
 * segundo se considere "ya aplicado" y se SALTEE en silencio. Con muchos PRs
 * abiertos que agregan migraciones, garantizar unicidad de número es un gate.
 * Devuelve [{ number, files:[...] }, ...] (vacío si no hay duplicados).
 */
function findDuplicateNumbers(files) {
  const byNum = new Map();
  for (const f of files) {
    const n = parseMigrationNumber(f);
    if (n === null) continue;
    if (!byNum.has(n)) byNum.set(n, []);
    byNum.get(n).push(f);
  }
  return [...byNum.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([number, group]) => ({ number, files: group.slice().sort() }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Guardia de MONOTONICIDAD: detecta migraciones PENDIENTES cuyo número es
 * MENOR que el máximo ya aplicado. Aplicarlas ahora las correría FUERA DE
 * SECUENCIA (una migración de número menor ejecutándose DESPUÉS de una mayor),
 * que es exactamente el riesgo 081/082/083-antes-de-076-080. `migrate.js` no
 * tenía esta guardia. Devuelve la lista ordenada de pendientes fuera de orden.
 */
function outOfOrderPending(pendingFiles, doneFiles) {
  let maxApplied = -1;
  for (const f of doneFiles) {
    const n = parseMigrationNumber(f);
    if (n !== null && n > maxApplied) maxApplied = n;
  }
  if (maxApplied < 0) return []; // nada aplicado todavía → no puede haber desorden
  return pendingFiles
    .filter(f => {
      const n = parseMigrationNumber(f);
      return n !== null && n < maxApplied;
    })
    .slice()
    .sort();
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

    // ── Gate raíz: integridad de numeración de migraciones ───────────────
    // Se evalúa SIEMPRE (también en --status) y se REPORTA; el corte fail-closed
    // se aplica sólo en los modos que escriben (migrate/baseline), ya que
    // --status es estrictamente read-only.
    const duplicates = findDuplicateNumbers(files);
    const outOfOrder = outOfOrderPending(pending, [...done]);
    const allowOutOfOrder = process.argv.includes('--allow-out-of-order');

    if (duplicates.length) {
      console.error('❌ Números de migración DUPLICADOS en database/migrations/ (el runner llavea por nombre → el 2° se saltearía en silencio):');
      duplicates.forEach(d => console.error(`   ${String(d.number).padStart(3, '0')} → ${d.files.join(', ')}`));
      console.error('   Acción: renumerá para que cada migración tenga un número único.');
    }
    if (outOfOrder.length) {
      const maxApplied = Math.max(...[...done].map(parseMigrationNumber).filter(n => n !== null));
      console.error(`❌ Migraciones PENDIENTES fuera de secuencia (número menor que ${maxApplied}, ya aplicado):`);
      outOfOrder.forEach(f => console.error(`   ${f}`));
      console.error('   Aplicarlas ahora las correría fuera de orden. Acción: renumerálas por encima del máximo');
      console.error('   aplicado, o —si el orden fue una decisión explícita y verificada— reejecutá con --allow-out-of-order.');
    }

    if (statusOnly) {
      if (!schemaMigrationsExists) {
        console.log('  schema_migrations no existe; --status no la crea (modo read-only).');
      }
      pending.forEach(f => console.log(`  pendiente: ${f}`));
      // --status es read-only: informa los problemas pero NO cambia el exit code.
      return;
    }

    // Modos que ESCRIBEN (migrate/baseline): fallar-cerrado ante integridad rota.
    // Los duplicados abortan siempre (no hay override: rompen la identidad por
    // nombre). El desorden aborta salvo override explícito.
    if (duplicates.length) process.exit(1);
    if (outOfOrder.length && !allowOutOfOrder) process.exit(1);

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
    // --upto=<archivo>: ejecuta SÓLO las pendientes con nombre <= target (orden
    // lexicográfico = orden por prefijo numérico), dejando fuera las más nuevas.
    // A diferencia de --baseline (que sólo marca sin ejecutar), --upto SÍ aplica.
    const uptoArg = process.argv.find(a => a === '--upto' || a.startsWith('--upto='));
    let toApply = pending;
    if (uptoArg) {
      const target = uptoArg.includes('=') ? uptoArg.split('=')[1].trim() : '';
      if (!target) {
        console.error('❌ --upto requiere un archivo objetivo, p. ej.:');
        console.error('   node scripts/migrate.js --upto=075_workday_configuration_phase_c.sql');
        process.exit(1);
      }
      if (!files.includes(target)) {
        console.error(`❌ El archivo objetivo de --upto "${target}" no existe en database/migrations/.`);
        process.exit(1);
      }
      const skipped = pending.filter(f => f > target);
      toApply = pending.filter(f => f <= target);
      if (skipped.length) {
        console.log(`   --upto=${target}: ${skipped.length} migración(es) más nueva(s) NO se aplican en esta corrida:`);
        skipped.forEach(f => console.log(`     - ${f}`));
      }
    }

    if (toApply.length === 0) { console.log('✅ Nada por aplicar.'); return; }

    for (const file of toApply) {
      process.stdout.write(`→ Aplicando ${file} ... `);
      applyWithMysqlClient(file);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log('OK');
    }
    console.log(`✅ ${toApply.length} migración(es) aplicada(s).`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Error en migración:', err.message);
    process.exit(1);
  });
}

// Helpers puros exportados para test (sin base de datos).
module.exports = { parseMigrationNumber, findDuplicateNumbers, outOfOrderPending };
