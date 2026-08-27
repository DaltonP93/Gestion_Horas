#!/usr/bin/env node
/**
 * daily-summary-dryrun.js — Qué cambiaría un recálculo de `daily_summary`.
 *
 * ESTRICTAMENTE DE SÓLO LECTURA. No contiene ninguna sentencia de escritura y
 * no toca ATT2000. NO recalcula: sólo compara.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PARA QUÉ
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `daily_summary` se venía calculando con su propio algoritmo, distinto del
 * del reporte. Pasarlo al motor cambia números que RRHH mira. Antes de
 * habilitar ese recálculo hay que poder contestar, con datos reales, cuántas
 * filas se mueven y por qué.
 *
 * Este script corre el motor sobre los MISMOS marcajes y contrasta fila por
 * fila contra lo que está guardado, clasificando cada diferencia por campo.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SEMÁNTICA DE worked_minutes
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Por defecto compara en modo `presence` —primera entrada a última salida—,
 * que es lo que la columna viene guardando. Comparar contra el tiempo neto
 * daría una diferencia enorme y FALSA en todo día con almuerzo marcado: son
 * dos conceptos distintos, no dos versiones del mismo número.
 *
 * `--worked-mode worked` compara contra el neto, que es lo que se vería si
 * alguien decidiera cambiar el significado de la columna. Esa es una decisión
 * de negocio y por eso hay que pedirla explícitamente.
 *
 * USO
 *
 *   node scripts/daily-summary-dryrun.js --from 2025-01-01 --to 2025-01-31
 *   node scripts/daily-summary-dryrun.js --from 2024-12-01 --to 2024-12-31 \
 *        --employee 3091 --out ./dryrun --json
 */

'use strict';

const fs = require('fs');
const path = require('path');

function cargarEnv(argv) {
  if (argv.includes('--no-env')) return { modo: 'shell', archivo: null };
  const i = argv.indexOf('--env');
  const archivo = (i >= 0 && argv[i + 1])
    ? path.resolve(argv[i + 1])
    : path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(archivo)) return { modo: 'shell', archivo, faltante: true };
  require('dotenv').config({ path: archivo, override: true });
  return { modo: 'archivo', archivo };
}

const ENV = cargarEnv(process.argv.slice(2));

const { sequelize } = require('../src/config/database');
const engine = require('../src/services/workdayEngine');
const { loadWorkdayConfig } = require('../src/services/workdayConfig');
const ds = require('../src/services/dailySummaryEngine');

function parseArgs(argv) {
  const args = {
    from: null, to: null, employee: null, dept: null, out: null,
    limit: 200, chunk: 50, workedMode: ds.WORKED_PRESENCE, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--from') args.from = next();
    else if (a === '--to') args.to = next();
    else if (a === '--employee') args.employee = next();
    else if (a === '--dept') args.dept = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--chunk') args.chunk = Number(next());
    else if (a === '--worked-mode') args.workedMode = next();
    else if (a === '--json') args.json = true;
    else if (a === '--env') next();
    else if (a === '--no-env') { /* ya procesado */ }
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) throw new Error(`Argumento desconocido: ${a}`);
  }
  return args;
}

const AYUDA = `
daily-summary-dryrun — qué cambiaría un recálculo (SÓLO LECTURA, no recalcula)

  --from YYYY-MM-DD      inicio del período (obligatorio)
  --to   YYYY-MM-DD      fin, inclusive (obligatorio)
  --employee CODIGO      limitar a un empleado por código de reloj
  --dept ID              limitar a un departamento
  --worked-mode MODO     'presence' (por defecto) o 'worked'
  --out DIR              escribir DIR/daily-summary-dryrun.json
  --json                 volcar el detalle por consola
  --limit N              máximo de diferencias en el detalle (200)
  --chunk N              empleados por lote (50)

No escribe en la base ni toca ATT2000.
`;

const esFechaCivil = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
  && engine.toWall(`${s} 00:00:00`) !== null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(AYUDA); return; }

  if (!esFechaCivil(args.from) || !esFechaCivil(args.to)) {
    throw new Error('--from y --to son obligatorios y deben ser fechas YYYY-MM-DD válidas');
  }
  if (args.from > args.to) throw new Error(`Rango invertido: ${args.from} > ${args.to}`);
  if (![ds.WORKED_PRESENCE, ds.WORKED_NET].includes(args.workedMode)) {
    throw new Error(`--worked-mode debe ser '${ds.WORKED_PRESENCE}' o '${ds.WORKED_NET}'`);
  }

  console.log('─'.repeat(72));
  console.log('DRY-RUN DE daily_summary — no se escribe nada');
  console.log(`Período     : ${args.from} .. ${args.to}`);
  console.log(`worked_mode : ${args.workedMode}`);
  console.log(`Entorno     : ${ENV.modo === 'archivo' ? ENV.archivo : 'variables del shell'}`);
  console.log('─'.repeat(72));

  let where = 'WHERE e.status = "active"';
  const params = [];
  if (args.employee) { where += ' AND e.code = ?'; params.push(String(args.employee)); }
  if (args.dept) { where += ' AND e.department_id = ?'; params.push(args.dept); }

  const [empleados] = await sequelize.query(`
    SELECT e.id AS employee_id, e.code, CONCAT(e.first_name,' ',e.last_name) AS nombre
    FROM employees e ${where} ORDER BY e.id
  `, { replacements: params });

  if (!empleados.length) {
    console.log('Ningún empleado coincide con el filtro.');
    return;
  }

  const [feriados] = await sequelize.query(
    "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM holidays WHERE active = 1 AND date >= ? AND date <= ?",
    { replacements: [args.from, args.to] },
  );
  const holidays = new Set(feriados.map((f) => f.d));

  const ventana = engine.punchWindow({ from: args.from, to: args.to });
  const resumen = {
    empleados: empleados.length,
    filas_guardadas: 0,
    jornadas_calculadas: 0,
    iguales: 0,
    difieren: 0,
    sin_fila_guardada: 0,
    sin_jornada_calculada: 0,
    // Días sin configuración histórica y sin marcajes: NO sabemos si la persona
    // debía trabajar. Se cuentan aparte y NO como diferencia funcional, para no
    // convertir la falta de configuración de 2022-2025 en miles de ausencias
    // falsas contra daily_summary.
    unconfigured_no_punches: 0,
    por_campo: {},
  };
  const detalle = [];

  for (let i = 0; i < empleados.length; i += args.chunk) {
    const lote = empleados.slice(i, i + args.chunk);
    const ids = lote.map((e) => e.employee_id);

    const [logs] = await sequelize.query(`
      SELECT al.id, al.employee_id,
             DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp, al.type
      FROM attendance_logs al
      WHERE al.employee_id IN (${ids.map(() => '?').join(',')})
        AND al.timestamp >= ? AND al.timestamp < ?
      ORDER BY al.employee_id, al.timestamp, al.id
    `, { replacements: [...ids, ventana.from, ventana.to] });

    const [guardadas] = await sequelize.query(`
      SELECT employee_id, DATE_FORMAT(date, '%Y-%m-%d') AS date,
             DATE_FORMAT(first_in, '%Y-%m-%d %H:%i:%s') AS first_in,
             DATE_FORMAT(last_out, '%Y-%m-%d %H:%i:%s') AS last_out,
             worked_minutes, late_minutes, break_minutes, status
      FROM daily_summary
      WHERE employee_id IN (${ids.map(() => '?').join(',')})
        AND date >= ? AND date <= ?
    `, { replacements: [...ids, args.from, args.to] });

    const porEmpleado = new Map();
    for (const l of logs) {
      const x = porEmpleado.get(l.employee_id);
      if (x) x.push(l); else porEmpleado.set(l.employee_id, [l]);
    }
    const guardadaDe = new Map(guardadas.map((g) => [`${g.employee_id}|${g.date}`, g]));
    resumen.filas_guardadas += guardadas.length;

    const config = await loadWorkdayConfig(ids, { from: args.from, to: args.to });

    for (const emp of lote) {
      const marcajes = porEmpleado.get(emp.employee_id) || [];
      const filas = ds.buildDailySummaryRows(marcajes, {
        from: args.from,
        to: args.to,
        holidays,
        workedMinutesMode: args.workedMode,
        resolveConfig: (workDate) => config.forDate(emp.employee_id, workDate),
      });
      resumen.jornadas_calculadas += filas.length;

      const vistas = new Set();
      for (const fila of filas) {
        const g = guardadaDe.get(`${emp.employee_id}|${fila.date}`);
        const diaVacio = fila.calculation_mode === null;

        // Día vacío sin configuración: se cuenta en su bucket propio y NO como
        // diferencia. Es el caso central de 2022-2025 —sin horario cargado no
        // sabemos si hubo ausencia— y contarlo como diff fabricaría ausencias.
        if (diaVacio && fila.status === ds.STATUS.UNCONFIGURED && !g) {
          resumen.unconfigured_no_punches++;
          continue;
        }

        // Otros días vacíos SIN fila guardada: qué recálculo materializa
        // ausentes/descansos puros es una decisión aparte, y contarlos acá
        // ahogaría las diferencias reales. Los días vacíos que SÍ tienen fila
        // guardada sí se comparan: valida que un absent/holiday/weekend/permission
        // guardado coincide con lo que el motor produciría.
        if (diaVacio && !g) continue;
        vistas.add(fila.date);

        const cmp = ds.compararFila(g, fila);

        if (cmp.iguales) { resumen.iguales++; continue; }
        resumen.difieren++;
        if (!g) resumen.sin_fila_guardada++;
        for (const campo of cmp.difieren) {
          resumen.por_campo[campo] = (resumen.por_campo[campo] || 0) + 1;
        }
        if (detalle.length < args.limit) {
          detalle.push({
            code: emp.code, nombre: emp.nombre, date: fila.date,
            difieren: cmp.difieren,
            guardado: g ? {
              worked_minutes: Number(g.worked_minutes),
              late_minutes: Number(g.late_minutes),
              status: g.status, first_in: g.first_in, last_out: g.last_out,
            } : null,
            calculado: {
              worked_minutes: fila.worked_minutes,
              presence_minutes: fila.presence_minutes,
              net_worked_minutes: fila.net_worked_minutes,
              late_minutes: fila.late_minutes,
              status: fila.status, first_in: fila.first_in, last_out: fila.last_out,
              calculation_mode: fila.calculation_mode,
              anomalies: fila.anomalies,
            },
          });
        }
      }

      // Filas guardadas que el motor ya no produce: típicamente el turno
      // nocturno que el algoritmo anterior partía en dos días.
      for (const g of guardadas) {
        if (g.employee_id !== emp.employee_id || vistas.has(g.date)) continue;
        resumen.difieren++;
        resumen.sin_jornada_calculada++;
        resumen.por_campo.sin_jornada_calculada = (resumen.por_campo.sin_jornada_calculada || 0) + 1;
        if (detalle.length < args.limit) {
          detalle.push({
            code: emp.code, nombre: emp.nombre, date: g.date,
            difieren: ['sin_jornada_calculada'],
            guardado: { worked_minutes: Number(g.worked_minutes), status: g.status },
            calculado: null,
          });
        }
      }
    }
  }

  console.log('');
  console.log(`Empleados analizados      : ${resumen.empleados}`);
  console.log(`Filas guardadas           : ${resumen.filas_guardadas}`);
  console.log(`Jornadas del motor        : ${resumen.jornadas_calculadas}`);
  console.log(`Iguales                   : ${resumen.iguales}`);
  console.log(`Difieren                  : ${resumen.difieren}`);
  console.log(`  sin fila guardada       : ${resumen.sin_fila_guardada}`);
  console.log(`  sin jornada calculada   : ${resumen.sin_jornada_calculada}`);
  console.log(`Sin config y sin marcas   : ${resumen.unconfigured_no_punches}  (no es diferencia)`);
  console.log('');
  console.log('Diferencias por campo:');
  const campos = Object.entries(resumen.por_campo).sort((a, b) => b[1] - a[1]);
  if (!campos.length) console.log('  (ninguna)');
  for (const [k, v] of campos) console.log(`  ${k.padEnd(24)} ${v}`);

  console.log('');
  console.log('Este script NO escribió nada. daily_summary sigue igual.');

  if (args.json) console.log(`\n${JSON.stringify(detalle, null, 2)}`);

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    const destino = path.join(args.out, 'daily-summary-dryrun.json');
    fs.writeFileSync(destino, JSON.stringify({
      periodo: { from: args.from, to: args.to },
      worked_mode: args.workedMode,
      generado: new Date().toISOString(),
      resumen,
      detalle,
      detalle_truncado: detalle.length >= args.limit,
    }, null, 2));
    console.log(`\nDetalle escrito en ${destino}`);
  }
}

main()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error(`\n✖ ${err.message}`);
    try { await sequelize.close(); } catch { /* la conexión ya podía estar caída */ }
    process.exitCode = 1;
  });
