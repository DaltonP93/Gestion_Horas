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
const { isMissingTableError } = require('../src/utils/schemaState');

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
 * Neutraliza comentarios y literales en UNA sola pasada léxica.
 *
 * Una cadena de `.replace()` encadenados no sirve, y el intento anterior lo
 * demostró de la peor manera: borraba los comentarios `#` ANTES que los
 * literales, así que el color `'#0ea5e9'` de la migración 042 se comía como
 * comentario, dejaba una comilla desbalanceada, y el reemplazo siguiente se
 * tragaba las sentencias posteriores. El parser detectaba `shift_templates` y
 * PERDÍA `shift_schedules` y `shift_assignments`.
 *
 * Eso es peor que el bug que vino a corregir. El original sobre-informaba
 * (siempre había deriva, molesto pero visible); éste sub-informaba: el check
 * salía con código 0 mientras faltaban tablas de verdad. Un detector que dice
 * "todo bien" cuando falta algo es peor que no tenerlo.
 *
 * Un solo recorrido decide en cada carácter en qué estado está, que es la
 * única forma de que un `#` dentro de una cadena no se confunda con el inicio
 * de un comentario. Todo lo neutralizado se reemplaza por espacios para no
 * pegar tokens de líneas distintas.
 */
function neutralizar(sql) {
  const salida = Buffer.from(sql, 'utf8').toString('utf8').split('');
  const blanquear = (desde, hasta) => {
    for (let i = desde; i < hasta && i < salida.length; i++) {
      if (salida[i] !== '\n') salida[i] = ' ';   // conservar los saltos de línea
    }
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const siguiente = sql[i + 1];

    // Comentario de bloque
    if (c === '/' && siguiente === '*') {
      const fin = sql.indexOf('*/', i + 2);
      const hasta = fin === -1 ? sql.length : fin + 2;
      blanquear(i, hasta); i = hasta; continue;
    }
    // Comentario de línea: `-- ` o `#`
    if ((c === '-' && siguiente === '-') || c === '#') {
      const fin = sql.indexOf('\n', i);
      const hasta = fin === -1 ? sql.length : fin;
      blanquear(i, hasta); i = hasta; continue;
    }
    // Literal entre comillas simples o dobles. Soporta escape con `\` y la
    // duplicación de la comilla ('' o "").
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }   // comilla duplicada
          j++; break;
        }
        j++;
      }
      blanquear(i, j); i = j; continue;
    }
    // Identificador entre backticks: NO se neutraliza — puede ser el nombre de
    // la tabla que estamos buscando.
    if (c === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '`') j++;
      i = j + 1; continue;
    }
    i++;
  }
  return salida.join('');
}

/** Palabras que nunca son un nombre de tabla, por si el regex se relaja. */
const NO_ES_TABLA = new Set(['if', 'not', 'exists', 'table', 'temporary']);

/** Tablas que un archivo SQL dice crear. */
function tablasDe(sql) {
  const encontradas = new Set();
  const limpio = neutralizar(sql);
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
    //
    // Sólo se tolera que la tabla de control NO EXISTA (el runner nunca se
    // adoptó acá). Cualquier otro fallo —permisos, conexión caída— se propaga:
    // tragárselo hacía que las migraciones aparecieran como pendientes y que
    // el informe recomendara `npm run migrate`, cuando en realidad figuran
    // como aplicadas y ese comando no las va a reparar. Es exactamente el
    // error que este mismo PR corrige en loadHrSchedules, cometido acá.
    let aplicadas = new Set();
    let hayTablaDeControl = true;
    try {
      const [regs] = await conn.query('SELECT filename FROM schema_migrations');
      aplicadas = new Set(regs.map(r => r.filename));
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      hayTablaDeControl = false;
    }

    const faltantes = [];
    for (const [tabla, info] of esperadas) {
      if (existentes.has(tabla)) continue;
      faltantes.push({
        tabla,
        declarada_en: info.origen,
        // El caso peligroso: la migración figura como aplicada y la tabla no
        // está. El runner no la va a volver a ejecutar nunca.
        // null = no se sabe (no hay tabla de control), no "no aplicada".
        migracion_marcada_aplicada: !hayTablaDeControl || !info.migracion
          ? null
          : aplicadas.has(info.migracion),
      });
    }

    if (comoJson) {
      console.log(JSON.stringify({
        database: DB.database,
        control_table_present: hayTablaDeControl,
        expected: esperadas.size,
        present: existentes.size,
        missing: faltantes,
      }, null, 2));
    } else {
      console.log(`\nBase: ${DB.database}`);
      if (!hayTablaDeControl) {
        console.log('⚠️  No existe `schema_migrations`: el runner nunca se adoptó en esta base,');
        console.log('    así que no se puede saber qué migraciones figuran como aplicadas.\n');
      }
      console.log(`Tablas esperadas: ${esperadas.size}   presentes: ${existentes.size}\n`);
      if (!faltantes.length) {
        console.log('✅ Sin deriva: todas las tablas declaradas existen.\n');
      } else {
        console.log(`❌ Faltan ${faltantes.length} tabla(s):\n`);
        for (const f of faltantes) {
          const marca = f.migracion_marcada_aplicada === true
            ? '⚠️  migración MARCADA como aplicada — el runner no la reejecutará'
            : f.migracion_marcada_aplicada === null
              ? '   estado desconocido (sin tabla de control)'
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
