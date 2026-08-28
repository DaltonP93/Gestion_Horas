#!/usr/bin/env node
/**
 * workday-engine-audit.js — Contraste entre el armado legacy y el motor.
 *
 * ESTRICTAMENTE DE SÓLO LECTURA. Emite únicamente SELECT. No hay un modo de
 * escritura que se pueda activar con un flag: el script no contiene ningún
 * INSERT, UPDATE ni DELETE, y no toca ATT2000 en absoluto.
 *
 * ¿PARA QUÉ?
 *
 * El motor cambia números que RRHH viene mirando desde hace años. Publicarlo
 * sin poder responder "¿cuánto y dónde cambia?" sería pedir un acto de fe.
 * Este script corre los DOS algoritmos sobre los MISMOS marcajes reales y
 * lista las diferencias, clasificadas por causa:
 *
 *   turno_nocturno     el legacy partió la jornada por el corte de las 05:00
 *   desfase_horario    el legacy formateó con la tzdata histórica (invierno
 *                      previo al 2024-10-06) y corrió la hora, o el día
 *   emparejamiento     el tipo del marcaje contradice el orden posicional
 *   otro               diferencia no explicada por lo anterior — es la
 *                      categoría que hay que mirar a mano
 *
 * USO
 *
 *   node scripts/workday-engine-audit.js --from 2024-12-01 --to 2024-12-31
 *   node scripts/workday-engine-audit.js --from 2025-01-01 --to 2025-12-31 \
 *        --employee 3091 --out ./auditoria
 *
 * Sin `--out` sólo imprime el resumen. Con `--out` escribe además el detalle
 * en un archivo JSON, en el DIRECTORIO QUE SE LE INDIQUE, nunca en el repo ni
 * en la base.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Entorno ──────────────────────────────────────────────────────
// Va ANTES de requerir config/database, que lee process.env al cargarse. Si el
// shell tiene un DB_PASSWORD distinto al de api/.env, sin `override` gana el
// del shell y la conexión falla con un error de autenticación desconcertante.
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
const legacy = require('../src/services/legacyWorkday');

// ─── Argumentos ───────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    from: null, to: null, employee: null, employeeId: null, dept: null,
    out: null, limit: 200, chunk: 50, dailySummary: false,
    json: false, csv: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--from') args.from = next();
    else if (a === '--to') args.to = next();
    else if (a === '--employee' || a === '--employee-code') args.employee = next();
    else if (a === '--employee-id') args.employeeId = Number(next());
    else if (a === '--dept') args.dept = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--chunk') args.chunk = Number(next());
    else if (a === '--daily-summary') args.dailySummary = true;
    else if (a === '--json') args.json = true;
    else if (a === '--csv') args.csv = true;
    else if (a === '--env' || a === '--no-env') { if (a === '--env') next(); }
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) throw new Error(`Argumento desconocido: ${a}`);
  }
  return args;
}

const AYUDA = `
workday-engine-audit — contraste legacy vs motor de jornada (SÓLO LECTURA)

  --from YYYY-MM-DD    inicio del período (obligatorio)
  --to   YYYY-MM-DD    fin del período, inclusive (obligatorio)
  --employee-code C    limitar a un empleado por su código de reloj
  --employee CODIGO    alias de --employee-code
  --employee-id ID     limitar a un empleado por su id interno
  --dept ID            limitar a un departamento
  --json               volcar el detalle en JSON por consola
  --csv                volcar el detalle en CSV por consola
  --out DIR            escribir el detalle en DIR/workday-audit.json
  --limit N            máximo de diferencias a listar en el detalle (200)
  --chunk N            empleados por lote de lectura (50)
  --daily-summary      además, contrastar contra las filas YA GUARDADAS de
                       daily_summary. Sigue siendo sólo lectura: informa qué
                       cambiaría un recálculo, sin recalcular nada.
  --env RUTA           archivo .env a usar (por defecto api/.env)
  --no-env             usar sólo las variables del shell

El script no escribe en la base ni toca ATT2000.
`;

/** Fecha civil estricta: rechaza lo que Date.UTC normalizaría en silencio. */
function esFechaCivil(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && engine.toWall(`${s} 00:00:00`) !== null;
}

/**
 * Clasifica una diferencia por su causa más probable.
 *
 * Es una heurística de TRIAGE, no un veredicto: sirve para saber por dónde
 * empezar a revisar, y por eso existe la categoría 'otro', que es la que
 * obliga a mirar el caso a mano en vez de darlo por explicado.
 */
function clasificar({ jornada, filaLegacy, marcajes }) {
  if (jornada.crosses_midnight) return 'turno_nocturno';

  // Invierno anterior a la última transición horaria de Paraguay: el formateo
  // legacy con tzdata corre una hora hacia atrás.
  const antesDeLaTransicion = jornada.work_date < '2024-10-06';
  if (antesDeLaTransicion && filaLegacy) {
    const e = filaLegacy.pairs[0] && filaLegacy.pairs[0].entrada;
    if (e && e !== jornada.segments[0].in_hhmm) return 'desfase_horario';
  }

  const hayTipos = marcajes.some((m) => engine.effectiveType(m.type) !== 'unknown');
  if (hayTipos) return 'emparejamiento';

  return 'otro';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(AYUDA); return; }

  if (!esFechaCivil(args.from) || !esFechaCivil(args.to)) {
    throw new Error('--from y --to son obligatorios y deben ser fechas YYYY-MM-DD válidas');
  }
  if (args.from > args.to) throw new Error(`Rango invertido: ${args.from} > ${args.to}`);

  console.log('─'.repeat(66));
  console.log('AUDITORÍA DEL MOTOR DE JORNADA — sólo lectura');
  console.log(`Período : ${args.from} .. ${args.to}`);
  console.log(`Entorno : ${ENV.modo === 'archivo' ? ENV.archivo : 'variables del shell'}`);
  if (ENV.faltante) console.log('  aviso: el archivo .env indicado no existe; se usa el shell');
  console.log('─'.repeat(66));

  let where = 'WHERE e.status = "active"';
  const params = [];
  if (args.employee)   { where += ' AND e.code = ?'; params.push(String(args.employee)); }
  if (args.employeeId) { where += ' AND e.id = ?';   params.push(args.employeeId); }
  if (args.dept)     { where += ' AND e.department_id = ?'; params.push(args.dept); }

  const [empleados] = await sequelize.query(`
    SELECT e.id AS employee_id, e.code, CONCAT(e.first_name,' ',e.last_name) AS nombre
    FROM employees e
    ${where}
    ORDER BY e.id
  `, { replacements: params });

  if (!empleados.length) {
    console.log('Ningún empleado coincide con el filtro. Nada que auditar.');
    return;
  }

  const ventana = engine.punchWindow({ from: args.from, to: args.to });
  const resumen = {
    empleados: empleados.length,
    jornadas_motor: 0,
    filas_legacy: 0,
    coinciden: 0,
    difieren: 0,
    solo_motor: 0,
    solo_legacy: 0,
    minutos_motor: 0,
    minutos_legacy: 0,
    por_causa: { turno_nocturno: 0, desfase_horario: 0, emparejamiento: 0, otro: 0 },
  };
  const detalle = [];

  /**
   * Contraste contra lo que YA está guardado en daily_summary.
   *
   * Es una simulación: dice qué cambiaría un recálculo, sin recalcular. La
   * comparación es contra `presence_minutes` —primera entrada a última
   * salida—, que es el concepto que `daily_summary.worked_minutes` viene
   * guardando. Compararlo contra `segment_minutes` daría una diferencia
   * enorme y falsa en todo día con almuerzo marcado, porque son dos números
   * distintos, no dos versiones del mismo.
   */
  const ds = {
    filas_guardadas: 0,
    coinciden: 0,
    difieren: 0,
    sin_fila: 0,
    delta_total_min: 0,
  };

  for (let i = 0; i < empleados.length; i += args.chunk) {
    const lote = empleados.slice(i, i + args.chunk);
    const ids = lote.map((e) => e.employee_id);

    const [logs] = await sequelize.query(`
      SELECT al.employee_id,
             DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
             al.type
      FROM attendance_logs al
      WHERE al.employee_id IN (${ids.map(() => '?').join(',')})
        AND al.timestamp >= ? AND al.timestamp < ?
      ORDER BY al.employee_id, al.timestamp, al.id
    `, { replacements: [...ids, ventana.from, ventana.to] });

    const porEmpleado = new Map();
    for (const l of logs) {
      const lista = porEmpleado.get(l.employee_id);
      if (lista) lista.push(l); else porEmpleado.set(l.employee_id, [l]);
    }

    // daily_summary ya guardado, si se pidió el contraste.
    const guardado = new Map();
    if (args.dailySummary) {
      const [filas] = await sequelize.query(`
        SELECT employee_id,
               DATE_FORMAT(date, '%Y-%m-%d') AS date,
               worked_minutes, late_minutes, status
        FROM daily_summary
        WHERE employee_id IN (${ids.map(() => '?').join(',')})
          AND date >= ? AND date <= ?
      `, { replacements: [...ids, args.from, args.to] });
      for (const f of filas) {
        guardado.set(`${f.employee_id}|${f.date}`, f);
        ds.filas_guardadas++;
      }
    }

    for (const emp of lote) {
      const marcajes = porEmpleado.get(emp.employee_id) || [];
      if (!marcajes.length) continue;

      const { workdays } = engine.buildWorkdays(marcajes);
      const jornadas = engine.clipToPeriod(workdays, { from: args.from, to: args.to });
      const legacyRows = legacy.buildLegacyRows(marcajes, { from: args.from, to: args.to });

      resumen.jornadas_motor += jornadas.length;
      resumen.filas_legacy += legacyRows.length;

      const porFechaLegacy = new Map(legacyRows.map((r) => [r.work_date, r]));
      const vistas = new Set();

      for (const j of jornadas) {
        vistas.add(j.work_date);

        if (args.dailySummary) {
          const fila = guardado.get(`${emp.employee_id}|${j.work_date}`);
          if (!fila) {
            ds.sin_fila++;
          } else if (Number(fila.worked_minutes) === j.presence_minutes) {
            ds.coinciden++;
          } else {
            ds.difieren++;
            ds.delta_total_min += j.presence_minutes - Number(fila.worked_minutes);
            if (detalle.length < args.limit) {
              detalle.push({
                code: emp.code, nombre: emp.nombre, work_date: j.work_date,
                caso: 'daily_summary',
                guardado_min: Number(fila.worked_minutes),
                motor_permanencia_min: j.presence_minutes,
                delta_min: j.presence_minutes - Number(fila.worked_minutes),
                guardado_status: fila.status,
              });
            }
          }
        }

        const l = porFechaLegacy.get(j.work_date);
        resumen.minutos_motor += j.segment_minutes;
        resumen.minutos_legacy += l ? l.minutes : 0;

        if (!l) {
          resumen.solo_motor++;
          resumen.difieren++;
          resumen.por_causa[clasificar({ jornada: j, filaLegacy: null, marcajes })]++;
          if (detalle.length < args.limit) {
            detalle.push({
              code: emp.code, nombre: emp.nombre, work_date: j.work_date,
              caso: 'sólo_motor', motor_min: j.segment_minutes, legacy_min: null,
              motor_pares: j.segments.map((s) => `${s.in_hhmm}-${s.out_hhmm}`),
            });
          }
          continue;
        }

        if (l.minutes === j.segment_minutes) { resumen.coinciden++; continue; }

        resumen.difieren++;
        const causa = clasificar({ jornada: j, filaLegacy: l, marcajes });
        resumen.por_causa[causa]++;
        if (detalle.length < args.limit) {
          detalle.push({
            code: emp.code, nombre: emp.nombre, work_date: j.work_date,
            caso: 'difieren', causa,
            motor_min: j.segment_minutes, legacy_min: l.minutes,
            delta_min: j.segment_minutes - l.minutes,
            motor_pares: j.segments.map((s) => `${s.in_hhmm}-${s.out_hhmm}`),
            legacy_pares: l.pairs.map((p) => `${p.entrada}-${p.salida}`),
            // Trazabilidad: con qué reglas y qué datos se produjo este número.
            calculation_mode: j.calculation_mode,
            calculation_source: j.calculation_source,
            policy_version: j.policy_version,
            anomalies: j.anomalies.map((a) => a.code),
            source_logs: j.segments.flatMap((s) => s.source_logs),
            schedule_id: j.schedule_id,
            shift_schedule_id: j.shift_schedule_id,
          });
        }
      }

      for (const r of legacyRows) {
        if (vistas.has(r.work_date)) continue;
        resumen.solo_legacy++;
        resumen.difieren++;
        resumen.minutos_legacy += r.minutes;
        resumen.por_causa.otro++;
        if (detalle.length < args.limit) {
          detalle.push({
            code: emp.code, nombre: emp.nombre, work_date: r.work_date,
            caso: 'sólo_legacy', motor_min: null, legacy_min: r.minutes,
            legacy_pares: r.pairs.map((p) => `${p.entrada}-${p.salida}`),
          });
        }
      }
    }
  }

  console.log('');
  console.log(`Empleados analizados     : ${resumen.empleados}`);
  console.log(`Jornadas (motor)         : ${resumen.jornadas_motor}`);
  console.log(`Filas (legacy)           : ${resumen.filas_legacy}`);
  console.log(`Coinciden                : ${resumen.coinciden}`);
  console.log(`Difieren                 : ${resumen.difieren}`);
  console.log(`  sólo en el motor       : ${resumen.solo_motor}`);
  console.log(`  sólo en el legacy      : ${resumen.solo_legacy}`);
  console.log('');
  console.log('Diferencias por causa probable:');
  for (const [k, v] of Object.entries(resumen.por_causa)) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
  console.log('');
  console.log(`Minutos totales motor    : ${resumen.minutos_motor} (${engine.minutesToHM(resumen.minutos_motor)})`);
  console.log(`Minutos totales legacy   : ${resumen.minutos_legacy} (${engine.minutesToHM(resumen.minutos_legacy)})`);
  console.log(`Diferencia               : ${resumen.minutos_motor - resumen.minutos_legacy} min`);
  if (args.dailySummary) {
    console.log('');
    console.log('Contraste contra daily_summary YA GUARDADO (simulación):');
    console.log(`  filas guardadas en el período : ${ds.filas_guardadas}`);
    console.log(`  coinciden con la permanencia  : ${ds.coinciden}`);
    console.log(`  difieren                      : ${ds.difieren}`);
    console.log(`  jornadas sin fila guardada    : ${ds.sin_fila}`);
    console.log(`  delta acumulado               : ${ds.delta_total_min} min`);
    console.log('');
    console.log('  Se compara contra `presence_minutes` (primera entrada a última');
    console.log('  salida), que es el concepto que daily_summary.worked_minutes');
    console.log('  viene guardando. Compararlo contra la suma de tramos daría una');
    console.log('  diferencia enorme y falsa en todo día con almuerzo marcado.');
  }

  console.log('');
  console.log('Recordatorio: este script no escribió nada. Los números de');
  console.log('daily_summary en producción siguen siendo los de antes.');

  if (args.json) console.log(`\n${JSON.stringify({ resumen, detalle }, null, 2)}`);

  if (args.csv) {
    // Columnas fijas y en orden: un CSV cuyas columnas cambian según los datos
    // no se puede abrir dos veces con la misma plantilla.
    const cols = [
      'code', 'nombre', 'work_date', 'caso', 'causa',
      'motor_min', 'legacy_min', 'delta_min',
      'calculation_mode', 'anomalies', 'motor_pares', 'legacy_pares',
    ];
    const escapar = (v) => {
      const t = Array.isArray(v) ? v.join(' ') : (v == null ? '' : String(v));
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    console.log('');
    console.log(cols.join(','));
    for (const d of detalle) console.log(cols.map((c) => escapar(d[c])).join(','));
  }

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    const destino = path.join(args.out, 'workday-audit.json');
    fs.writeFileSync(destino, JSON.stringify({
      periodo: { from: args.from, to: args.to },
      generado: new Date().toISOString(),
      resumen,
      daily_summary: args.dailySummary ? ds : null,
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
