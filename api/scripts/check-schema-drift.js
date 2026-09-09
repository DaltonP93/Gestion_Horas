#!/usr/bin/env node
/**
 * check-schema-drift.js — detecta deriva entre lo que las migraciones dicen
 * haber creado y lo que la base tiene de verdad: tablas ausentes y, para un
 * conjunto curado, columnas ausentes.
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
 * ── Por qué además mira columnas ─────────────────────────────────────
 *
 * Este check informaba "✅ Sin deriva" mientras el cron
 * `capacitaciones_vencimiento` fallaba todas las mañanas con
 * ER_BAD_FIELD_ERROR / 42S22. No era una contradicción: sólo comparaba
 * nombres de TABLA contra information_schema.TABLES y jamás miraba una
 * columna. Una tabla presente con la forma equivocada le resultaba invisible.
 *
 * La extensión es deliberadamente angosta. NO compara la estructura completa
 * de cada tabla contra el DDL —eso exige interpretar toda la cadena de ALTER,
 * los tipos y las columnas que producción agregó a mano, y produce ruido que
 * termina en que nadie lo corre—. Verifica una lista CURADA de columnas de las
 * que depende SQL de runtime, cada una con el consumidor anotado. La lista se
 * amplía a mano cuando una consulta nueva pasa a depender de una columna, y su
 * valor está justamente en ser corta y cierta.
 *
 * Uso:
 *   node api/scripts/check-schema-drift.js            # informe legible
 *   node api/scripts/check-schema-drift.js --json     # salida para scripts
 *
 * Salida: 0 si no hay deriva, 1 si falta alguna tabla o columna crítica.
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

/**
 * Columnas de las que depende SQL de runtime, con su consumidor.
 *
 * Lista CURADA a mano, no derivada del DDL: su utilidad depende de que sea
 * corta y de que cada entrada sea verdad. Agregar una columna acá vale la pena
 * cuando una consulta de runtime se rompe entera si falta —como pasó con el
 * cron de capacitaciones—, no por completitud.
 *
 * `columna` es la que la consulta pide. Que exista una columna con ese nombre
 * en OTRA tabla no sirve de nada: la consulta rota nombraba `status`, que
 * existe en `employees` (ENUM active/inactive/suspended) y en varias tablas
 * más, pero no en `course_assignments`, que es donde se la pedía. Por eso el
 * par (tabla, columna) se verifica junto y nunca por nombre suelto.
 */
const COLUMNAS_CRITICAS = [
  { tabla: 'course_assignments', columna: 'completed_at',
    usadaPor: 'cron capacitaciones_vencimiento + GET /courses/my + /courses/:id/progress' },
  { tabla: 'course_assignments', columna: 'due_date',
    usadaPor: 'cron capacitaciones_vencimiento (ventana de vencimiento)' },
  { tabla: 'courses',            columna: 'active',
    usadaPor: 'cron capacitaciones_vencimiento + borrado lógico DELETE /courses/:id' },
  { tabla: 'users',              columna: 'employee_id',
    usadaPor: 'cron capacitaciones_vencimiento (destinatario) + GET /courses/my' },
  { tabla: 'external_hr_sources', columna: 'schedule_cron',
    usadaPor: 'loadHrSchedules (arranque de la API)' },
  // FASE C / motor de jornada: columnas del perfil 073 que loadScheduleHistory
  // SIEMPRE selecciona. Si la tabla existe (072 aplicada) pero falta alguna de
  // estas (073 a medias), la consulta se rompe entera con ER_BAD_FIELD_ERROR
  // (42S22) en runtime. El chequeo de tabla no lo ve —la tabla existe—; sólo el
  // par (tabla, columna) detecta el esquema parcial peligroso del rollout.
  { tabla: 'employee_schedule_history', columna: 'work_regime',
    usadaPor: 'workdayConfig.loadScheduleHistory (perfil 073)' },
  { tabla: 'employee_schedule_history', columna: 'daily_target_minutes',
    usadaPor: 'workdayConfig.loadScheduleHistory (objetivo diario 073)' },
  { tabla: 'employee_schedule_history', columna: 'weekly_target_minutes',
    usadaPor: 'workdayConfig.loadScheduleHistory (objetivo semanal 073)' },
  { tabla: 'employee_schedule_history', columna: 'overtime_policy',
    usadaPor: 'workdayConfig.loadScheduleHistory (política de horas extra 073)' },
  { tabla: 'employee_schedule_history', columna: 'rounding_policy',
    usadaPor: 'workdayConfig.loadScheduleHistory (política de redondeo 073)' },
  { tabla: 'employee_schedule_history', columna: 'night_start',
    usadaPor: 'workdayConfig.loadScheduleHistory (ventana nocturna 073)' },
  { tabla: 'employee_schedule_history', columna: 'night_end',
    usadaPor: 'workdayConfig.loadScheduleHistory (ventana nocturna 073)' },
  { tabla: 'employee_schedule_history', columna: 'work_days',
    usadaPor: 'workdayConfig.loadScheduleHistory (días laborables 073)' },
];

/**
 * Columnas críticas ausentes.
 *
 * Se saltean las tablas que directamente no están: ya las reporta el chequeo
 * de tablas, y volver a listarlas columna por columna sólo agrega ruido sobre
 * un problema que ya tiene su línea en el informe.
 */
async function columnasFaltantes(conn, existentes) {
  const porTabla = new Map();
  for (const c of COLUMNAS_CRITICAS) {
    if (!existentes.has(c.tabla.toLowerCase())) continue;
    if (!porTabla.has(c.tabla)) porTabla.set(c.tabla, []);
    porTabla.get(c.tabla).push(c);
  }
  if (!porTabla.size) return [];

  const [filas] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)`,
    [DB.database, [...porTabla.keys()]]);

  const presentes = new Set(
    filas.map(f => `${String(f.TABLE_NAME).toLowerCase()}.${String(f.COLUMN_NAME).toLowerCase()}`));

  const faltantes = [];
  for (const lista of porTabla.values()) {
    for (const c of lista) {
      if (presentes.has(`${c.tabla.toLowerCase()}.${c.columna.toLowerCase()}`)) continue;
      faltantes.push(c);
    }
  }
  return faltantes;
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

    const columnas = await columnasFaltantes(conn, existentes);

    if (comoJson) {
      console.log(JSON.stringify({
        database: DB.database,
        control_table_present: hayTablaDeControl,
        expected: esperadas.size,
        present: existentes.size,
        missing: faltantes,
        critical_columns_checked: COLUMNAS_CRITICAS.length,
        missing_columns: columnas.map(c => ({
          table: c.tabla, column: c.columna, used_by: c.usadaPor,
        })),
      }, null, 2));
    } else {
      console.log(`\nBase: ${DB.database}`);
      if (!hayTablaDeControl) {
        console.log('⚠️  No existe `schema_migrations`: el runner nunca se adoptó en esta base,');
        console.log('    así que no se puede saber qué migraciones figuran como aplicadas.\n');
      }
      console.log(`Tablas esperadas: ${esperadas.size}   presentes: ${existentes.size}`);
      console.log(`Columnas críticas verificadas: ${COLUMNAS_CRITICAS.length}\n`);
      if (!faltantes.length && !columnas.length) {
        console.log('✅ Sin deriva: todas las tablas declaradas existen y las');
        console.log('   columnas críticas verificadas están presentes.\n');
      } else if (!faltantes.length) {
        console.log('✅ Todas las tablas declaradas existen.\n');
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

      if (columnas.length) {
        console.log(`❌ Faltan ${columnas.length} columna(s) crítica(s) en tablas que SÍ existen:\n`);
        for (const c of columnas) {
          console.log(`   ${`${c.tabla}.${c.columna}`.padEnd(40)}`);
          console.log(`   ${''.padEnd(40)} la usa: ${c.usadaPor}`);
        }
        console.log('\nUna tabla presente con la forma equivocada da ER_BAD_FIELD_ERROR (42S22)');
        console.log('en runtime, no ER_NO_SUCH_TABLE. Antes de agregar la columna, confirmá');
        console.log('contra las migraciones si el que está mal es el esquema o la consulta:');
        console.log('crear una columna para que una consulta deje de fallar, cuando el esquema');
        console.log('siempre fue el correcto, deja el error real intacto y suma esquema muerto.\n');
      }
    }
    process.exitCode = (faltantes.length || columnas.length) ? 1 : 0;
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(2);
});
