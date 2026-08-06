#!/usr/bin/env node
/**
 * check-schema-drift.js — detecta tablas que las migraciones dicen haber
 * creado pero que no existen en la base.
 *
 * SOLO LECTURA. No crea, no altera y no borra nada. Se puede correr en
 * producción sin riesgo.
 *
 * ── Por qué existe ───────────────────────────────────────────────────
 *
 * El runner de migraciones tiene `--baseline=<archivo>`, que marca las
 * migraciones como aplicadas SIN ejecutarlas, para adoptar el runner en una
 * base que ya las tenía a mano. Si el baseline se puso más adelante de lo que
 * la base realmente tenía, `schema_migrations` afirma que esas migraciones
 * corrieron y el runner nunca las va a volver a ejecutar — pero las tablas no
 * están.
 *
 * El síntoma es un ER_NO_SUCH_TABLE en tiempo de ejecución, meses después,
 * en el módulo que primero toque una de esas tablas. Producción mostró dos:
 *
 *     ER_NO_SUCH_TABLE  stage: load_schedules   → external_hr_sources (007)
 *     Error cron courses due                    → courses (028)
 *
 * Este script contesta la pregunta completa —cuáles faltan— en vez de
 * descubrirlas de a una por los logs.
 *
 * Uso:
 *   node api/scripts/check-schema-drift.js            # informe legible
 *   node api/scripts/check-schema-drift.js --json     # salida para scripts
 *
 * Salida: 0 si no hay deriva, 1 si faltan tablas.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'asistencia',
};

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'database', 'migrations');
const INIT_SQL = path.resolve(__dirname, '..', '..', 'database', 'init.sql');

/**
 * Exige el paréntesis de apertura de la definición.
 *
 * Sin él, el grupo opcional `IF NOT EXISTS` retrocede ante un texto como
 * `CREATE TABLE IF NOT EXISTS).` —que aparece dentro de comentarios en las
 * migraciones 056, 057, 064 y 071— y captura `IF` como nombre de tabla. El
 * resultado era una tabla fantasma `if` que nunca existe: el informe daba
 * deriva siempre y el script salía con código 1 en una base sana, que es peor
 * que no tenerlo.
 */
const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/gi;

/**
 * Quita comentarios y literales antes de buscar sentencias.
 *
 * Un `CREATE TABLE` mencionado en un comentario no crea nada. Se reemplaza por
 * espacios en vez de borrarse para no pegar tokens de líneas distintas.
 */
function sinComentarios(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))   // /* ... */
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))           // -- ...
    .replace(/#[^\n]*/g, (m) => ' '.repeat(m.length))            // # ... (MySQL)
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length)); // 'literal'
}

/** Palabras que nunca son un nombre de tabla, por si el regex se relaja. */
const NO_ES_TABLA = new Set(['if', 'not', 'exists', 'table', 'temporary']);

/** Tablas que un archivo SQL dice crear. */
function tablasDe(sql) {
  const encontradas = new Set();
  const limpio = sinComentarios(sql);
  let m;
  CREATE_TABLE.lastIndex = 0;
  while ((m = CREATE_TABLE.exec(limpio)) !== null) {
    const nombre = m[1].toLowerCase();
    if (!NO_ES_TABLA.has(nombre)) encontradas.add(nombre);
  }
  return encontradas;
}

/** Qué archivo declara cada tabla, en orden de migración. */
function tablasEsperadas() {
  const porTabla = new Map();

  if (fs.existsSync(INIT_SQL)) {
    for (const t of tablasDe(fs.readFileSync(INIT_SQL, 'utf8'))) {
      porTabla.set(t, { origen: 'init.sql', migracion: null });
    }
  }
  for (const archivo of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), 'utf8');
    for (const t of tablasDe(sql)) {
      if (!porTabla.has(t)) porTabla.set(t, { origen: archivo, migracion: archivo });
    }
  }
  return porTabla;
}

async function main() {
  const comoJson = process.argv.includes('--json');
  const esperadas = tablasEsperadas();

  const conn = await mysql.createConnection(DB);
  try {
    const [filas] = await conn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [DB.database]);
    const existentes = new Set(filas.map(f => String(f.TABLE_NAME).toLowerCase()));

    // Migraciones que el runner considera aplicadas.
    let aplicadas = new Set();
    try {
      const [regs] = await conn.query('SELECT filename FROM schema_migrations');
      aplicadas = new Set(regs.map(r => r.filename));
    } catch {
      // Sin tabla de control: el runner nunca se adoptó acá.
    }

    const faltantes = [];
    for (const [tabla, info] of esperadas) {
      if (existentes.has(tabla)) continue;
      faltantes.push({
        tabla,
        declarada_en: info.origen,
        // El caso peligroso: la migración figura como aplicada y la tabla no
        // está. El runner no la va a volver a ejecutar nunca.
        migracion_marcada_aplicada: info.migracion ? aplicadas.has(info.migracion) : null,
      });
    }

    if (comoJson) {
      console.log(JSON.stringify({
        database: DB.database,
        expected: esperadas.size,
        present: existentes.size,
        missing: faltantes,
      }, null, 2));
    } else {
      console.log(`\nBase: ${DB.database}`);
      console.log(`Tablas esperadas: ${esperadas.size}   presentes: ${existentes.size}\n`);
      if (!faltantes.length) {
        console.log('✅ Sin deriva: todas las tablas declaradas existen.\n');
      } else {
        console.log(`❌ Faltan ${faltantes.length} tabla(s):\n`);
        for (const f of faltantes) {
          const marca = f.migracion_marcada_aplicada
            ? '⚠️  migración MARCADA como aplicada — el runner no la reejecutará'
            : '   pendiente: `npm run migrate` la crearía';
          console.log(`   ${f.tabla.padEnd(34)} ${String(f.declarada_en).padEnd(42)}`);
          console.log(`   ${''.padEnd(34)} ${marca}`);
        }
        console.log('\nPara las marcadas como aplicadas hace falta una migración NUEVA');
        console.log('con CREATE TABLE IF NOT EXISTS — es la única que el runner ejecutará.');
        console.log('Ver database/migrations/071_repair_external_hr_sources.sql como modelo.\n');
      }
    }
    process.exitCode = faltantes.length ? 1 : 0;
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(2);
});
