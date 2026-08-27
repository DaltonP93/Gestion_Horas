/**
 * scheduler.js
 * Gestión de reportes automáticos programados con node-cron.
 * Los schedules se guardan en la tabla report_schedules de MySQL.
 */

const cron = require('node-cron');
const { cronCallback, runJob } = require('../utils/cronRunner');
const { serializeError, safeErrorCode } = require('../utils/errorInfo');
const { sequelize } = require('../config/database');
const { sendMail, buildReportEmailHtml } = require('./emailService');
const logger = require('../config/logger');
const { withDayRecalcLock, dayBounds } = require('./recalcLock');
const engine = require('./workdayEngine');
const { loadWorkdayConfig } = require('./workdayConfig');

const _jobs = new Map(); // scheduleId → tarea cron activa

// ─── Helpers de timezone Paraguay ────────────────────────────────
//
// ALCANCE, que acá es todo: estos helpers convierten un INSTANTE REAL —el
// `new Date()` de ahora— a la fecha civil paraguaya. Para eso la tzdata es la
// herramienta correcta y hay que usarla: "qué día es hoy en Asunción" depende
// de la zona.
//
// Lo que NO se puede hacer con ellos —y era lo que se hacía— es aplicarlos a
// un DATETIME leído de la base. Esa columna no guarda un instante sino una
// hora de pared; convertirla arrastra la tzdata histórica (Paraguay estuvo en
// UTC-4 hasta el 2024-10-06) y corre una hora todo el histórico de invierno.
// Ese camino ahora pasa por `workdayEngine`, que trabaja en hora de pared.
const TZ_PY = 'America/Asuncion';
const _dtfDate = new Intl.DateTimeFormat('es-PY', { timeZone: TZ_PY, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "YYYY-MM-DD" de un Date en Paraguay. Sólo para instantes reales. */
function pyDateStr(d) {
  const parts = _dtfDate.formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Parsea un valor (Date o string MySQL "YYYY-MM-DD HH:mm:ss") a JS Date UTC correcto */
function toDate(v) {
  if (v instanceof Date) return v;
  // String MySQL sin timezone → tratar como hora local Paraguay (UTC-3 permanente)
  const s = String(v);
  if (!s.includes('T') && !s.endsWith('Z') && !s.includes('+')) {
    return new Date(s.replace(' ', 'T') + '-03:00');
  }
  return new Date(s);
}

// ─── Generar reporte de marcadas (igual al PDF de SisHoras) ───────
//
// La jornada NO se arma acá: la arma `workdayEngine`, que es la única
// definición de jornada del sistema. Esta función se ocupa de qué empleados
// entran (RBAC, filtros), de leer los marcajes con una consulta acotada, y de
// darle a la vista la forma que ya esperaba.
//
// Lo que se fue de acá, y por qué:
//
//   - El agrupamiento por "fecha laboral" con corte fijo a las 05:00. Partía
//     en dos un turno 18:30 → 07:04 y le daba día propio a una salida de
//     05:29.
//   - El emparejamiento por posición (par = entrada, impar = salida), que
//     ignora `attendance_logs.type` y corre todos los pares del día ante un
//     marcaje espurio.
//   - `toDate()` + `pyHour()` + `pyDateStr()` + `fmtTime()`, que fijaban
//     -03:00 sobre el DATETIME guardado y después lo formateaban con la tzdata
//     histórica de America/Asuncion. Toda marca de invierno anterior al
//     2024-10-06 salía una hora antes, y las de la primera hora del día
//     cambiaban de fecha.
//
// `scope` es opcional: cuando el caller lo pasa (rutas HTTP), acota por los
// departamentos visibles al usuario (RBAC jerárquico). Los callers internos
// —el cron mail scheduler y demás— lo omiten y ven todo (comportamiento previo).

/**
 * Empleados procesados por lote.
 *
 * El reporte cargaba TODOS los marcajes del período en un array y recién
 * después agrupaba. Con un rango largo sobre varios cientos de empleados eso
 * es un pico de memoria proporcional al período completo, y es la causa
 * directa de los reinicios por `max_memory_restart` (RSS observado de hasta
 * 1,28 GB contra un tope de 512 MB) y de los 502 que los acompañan.
 *
 * Procesando por lotes, el pico pasa a depender del LOTE y no del período: los
 * marcajes de cada lote se sueltan antes de leer el siguiente, y lo que queda
 * vivo son las filas ya resumidas, que son órdenes de magnitud más chicas.
 */
const MARCADAS_EMPLOYEE_CHUNK = 50;

/**
 * Tope duro de marcajes por lote.
 *
 * Preferimos fallar con un mensaje que diga qué achicar antes que que el
 * proceso muera por OOM y se lleve puestas todas las peticiones en vuelo. Un
 * 502 sin explicación es peor que un error explícito.
 */
const MARCADAS_MAX_PUNCHES_PER_CHUNK = 400000;

async function generateMarcadasReport({ dateFrom, dateTo, employeeId, deptId, scope } = {}) {
  // "Hoy" sí es un instante real, y por eso acá la tzdata corresponde.
  const hoy = pyDateStr(new Date());
  const from = dateFrom || hoy;
  const to   = dateTo   || hoy;

  // Los placeholders de `empFilter` aparecen en el SQL ANTES del rango, así que
  // sus valores tienen que ir antes en `replacements`: el enlace es posicional.
  // Antes se inicializaba `params` con [from, to] y se hacía push encima, de
  // modo que en cuanto había un filtro el orden se desalineaba y el reporte
  // devolvía cero filas.
  let empFilter = 'WHERE e.status = "active"';
  const empParams = [];
  if (employeeId) { empFilter += ' AND e.id = ?'; empParams.push(employeeId); }
  if (deptId)     { empFilter += ' AND e.department_id = ?'; empParams.push(deptId); }

  if (scope && !scope.unrestricted) {
    const ids = scope.ids || [];
    if (!ids.length) {
      // rol scoped sin depto vinculado → resultado vacío coherente
      return { data: [], period: { from, to } };
    }
    empFilter += ` AND e.department_id IN (${ids.map(() => '?').join(',')})`;
    empParams.push(...ids);
  }

  // 1) Padrón primero. Es una lista acotada por el filtro y cabe en memoria
  //    sin problema; los marcajes, que no, se leen después y por lotes.
  const [empleados] = await sequelize.query(`
    SELECT
      e.id AS employee_id,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      e.code,
      d.name AS department
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    ${empFilter}
    ORDER BY e.last_name, e.first_name, e.id
  `, { replacements: empParams });

  if (!empleados.length) return { data: [], period: { from, to } };

  // 2) Ventana de marcajes. Se extiende más allá del período pedido para que
  //    la jornada del primer y del último día estén COMPLETAS: un turno que
  //    entra el último día a las 22:00 cierra al día siguiente, y cortarlo por
  //    fecha de marca perdería esas horas.
  const ventana = engine.punchWindow({ from, to });

  const result = [];
  for (let i = 0; i < empleados.length; i += MARCADAS_EMPLOYEE_CHUNK) {
    const lote = empleados.slice(i, i + MARCADAS_EMPLOYEE_CHUNK);
    const ids = lote.map((e) => e.employee_id);

    // `timestamp >= ? AND < ?` es sargable sobre idx_emp_ts; el
    // `DATE(al.timestamp) BETWEEN ? AND ?` anterior no lo era y forzaba a
    // evaluar la función sobre cada fila del rango.
    //
    // El LIMIT acota la MATERIALIZACIÓN, no sólo el chequeo: sin él, mysql2
    // traía TODAS las filas que matchean —millones en un rango largo— antes de
    // que el `if` de abajo pudiera reaccionar, y el pico de esa asignación es
    // justamente lo que hacía saltar a PM2 por memoria. Con `LIMIT max+1`, el
    // driver nunca materializa más que eso: si vuelven `max+1` filas sabemos
    // que se superó el tope, sin haber cargado el dataset entero.
    const [logs] = await sequelize.query(`
      SELECT
        al.id,
        al.employee_id,
        DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
        al.type
      FROM attendance_logs al
      WHERE al.employee_id IN (${ids.map(() => '?').join(',')})
        AND al.timestamp >= ? AND al.timestamp < ?
      ORDER BY al.employee_id, al.timestamp, al.id
      LIMIT ${MARCADAS_MAX_PUNCHES_PER_CHUNK + 1}
    `, { replacements: [...ids, ventana.from, ventana.to] });

    if (logs.length > MARCADAS_MAX_PUNCHES_PER_CHUNK) {
      throw new Error(
        `El período ${from}..${to} devuelve demasiados marcajes para procesar de una vez `
        + `(más de ${MARCADAS_MAX_PUNCHES_PER_CHUNK} en un lote de ${ids.length} empleados). `
        + 'Acotar el rango de fechas o filtrar por departamento.',
      );
    }

    const porEmpleado = new Map();
    for (const log of logs) {
      const lista = porEmpleado.get(log.employee_id);
      if (lista) lista.push(log); else porEmpleado.set(log.employee_id, [log]);
    }

    // Configuración del lote en TRES consultas acotadas al rango, no una por
    // empleado y día: 500 empleados por 30 días serían 15.000 viajes a la base
    // para un solo reporte.
    const config = await loadWorkdayConfig(ids, { from, to });

    for (const emp of lote) {
      const marcajes = porEmpleado.get(emp.employee_id) || [];
      const item = armarFilasEmpleado(emp, marcajes, config, { from, to });
      // Un empleado activo SIN ninguna jornada dentro del período no aparece en
      // el reporte. Antes se agregaba con rows:[] y total 0, y en el PDF eso
      // producía bloques/páginas vacías. La condición se evalúa DESPUÉS del
      // recorte al período: puede haber logs en la ventana ampliada que sólo
      // son contexto del día anterior/siguiente y no una jornada del período.
      if (item.rows.length > 0) result.push(item);
    }
  }

  return { data: result, period: { from, to } };
}

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/**
 * Filas del reporte para un empleado, ya con la forma que espera la vista.
 *
 * El total del día es `segment_minutes` —la suma de los tramos entrada/salida—,
 * que es lo que la columna "Total Permanencia" venía sumando: excluye la pausa
 * entre pares. NO es `presence_minutes` (primera entrada → última salida), que
 * es el concepto que guarda `daily_summary.worked_minutes`. Son dos números
 * distintos y mezclarlos es por qué los dos reportes nunca cerraron entre sí.
 */
function armarFilasEmpleado(emp, marcajes, config, periodo) {
  const { workdays } = engine.buildWorkdays(marcajes, {
    resolveConfig: (workDate) => config.forDate(emp.employee_id, workDate),
  });
  const delPeriodo = engine.clipToPeriod(workdays, periodo);

  let totalMinutes = 0;
  const rows = delPeriodo.map((j) => {
    totalMinutes += j.segment_minutes;
    const [y, m, d] = j.work_date.split('-');
    return {
      dayName: DAY_NAMES[engine.dayOfWeekISO(j.work_date)],
      date: `${d}/${m}/${y}`,
      pairs: j.segments.map((s) => ({ entrada: s.in_hhmm, salida: s.out_hhmm })),
      total: engine.minutesToHM(j.segment_minutes),
      crosses_midnight: j.crosses_midnight,
      open: j.open,
      // Se exponen para que la vista pueda marcar la fila como revisable en
      // vez de mostrar un cero indistinguible de un día sin trabajar.
      anomalies: j.anomalies.map((a) => a.code),
      calculation_mode: j.calculation_mode,
      non_working_kind: j.non_working_kind,
    };
  });

  return {
    employee_id: emp.employee_id,
    employee_name: emp.employee_name,
    code: emp.code,
    department: emp.department,
    rows,
    total_minutes: totalMinutes,
    total_hm: minsToHM(totalMinutes),
  };
}

function fmtTime(dt) {
  if (!dt) return '';
  const d = toDate(dt);
  return new Intl.DateTimeFormat('es-PY', {
    timeZone: TZ_PY, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d);
}

function minsToHM(mins) {
  if (!mins || mins <= 0) return '0:00';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2,'0')}`;
}

/**
 * Mayor cantidad de pares entrada/salida de un conjunto de filas.
 *
 * Se calcula con reduce y NO con `Math.max(...filas.map(…))`. El spread pasa
 * cada elemento como un argumento distinto, y V8 desborda el stack con
 * `RangeError: Maximum call stack size exceeded` alrededor de los 125.000
 * argumentos. Ese umbral es alcanzable acá: el array del PDF tiene un elemento
 * por combinación (empleado × día con marcajes), así que un rango de un año
 * sobre varios cientos de empleados lo supera y el reporte falla con una
 * excepción, no con lentitud. Era una de las causas del 502 en períodos
 * históricos.
 *
 * El mínimo es 1 para que la tabla siempre tenga al menos una columna de par.
 */
function maxPairsOf(rows) {
  return (rows || []).reduce((max, r) => {
    const n = r && r.pairs ? r.pairs.length : 0;
    return n > max ? n : max;
  }, 1);
}

// ─── Construir tabla HTML del reporte marcadas ────────────────────
function buildMarcadasTableHtml(empData) {
  const maxPairs = maxPairsOf(empData.rows);

  let headers = '<th>Fecha</th>';
  for (let i = 0; i < maxPairs; i++) {
    headers += `<th>Entrada</th><th>Salida</th>`;
  }
  headers += '<th>Total Permanencia</th>';

  const tbody = empData.rows.map(row => {
    let cells = `<td><strong>${row.dayName}</strong> ${row.date}</td>`;
    for (let i = 0; i < maxPairs; i++) {
      const p = row.pairs[i] || { entrada: '', salida: '' };
      cells += `<td>${p.entrada}</td><td>${p.salida}</td>`;
    }
    const totalClass = row.total === '0:00' ? 'zero' : 'total';
    cells += `<td class="${totalClass}">${row.total}</td>`;
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<table><thead><tr>${headers}</tr></thead><tbody>${tbody}</tbody></table>`;
}

// ─── Cargar y ejecutar todos los schedules activos ────────────────
async function loadSchedules() {
  try {
    const [schedules] = await sequelize.query(
      'SELECT * FROM report_schedules WHERE active = 1'
    );
    for (const s of schedules) {
      registerJob(s);
    }
    logger.info(`Scheduler: ${schedules.length} reporte(s) programados cargados`);
  } catch (err) {
    logger.warn('report_schedules tabla no disponible aún:', err.message);
  }
}

// Registrar un job cron
function registerJob(schedule) {
  // Limpiar job previo si existe
  if (_jobs.has(schedule.id)) {
    _jobs.get(schedule.id).stop();
    _jobs.delete(schedule.id);
  }

  if (!cron.validate(schedule.cron_expression)) {
    logger.warn(`Expresión cron inválida para schedule ${schedule.id}: ${schedule.cron_expression}`);
    return;
  }

  const task = cron.schedule(schedule.cron_expression, cronCallback(
    `reporte_programado_${schedule.id}`,
    () => runScheduledReport(schedule),
    { meta: { schedule_id: schedule.id, schedule_name: schedule.name } }
  ), { timezone: schedule.timezone || TZ_PY });

  _jobs.set(schedule.id, task);
}

// Ejecutar un reporte y enviarlo por email
async function runScheduledReport(schedule) {
  try {
    const config = JSON.parse(schedule.config || '{}');

    // Calcular período según el tipo
    const now = new Date();
    const todayPY = pyDateStr(now);  // "YYYY-MM-DD" en Paraguay
    let dateFrom, dateTo;
    if (schedule.period_type === 'daily') {
      // Día anterior en Paraguay
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - 1);
      dateFrom = dateTo = pyDateStr(d);
    } else if (schedule.period_type === 'weekly') {
      const to = new Date(now); to.setUTCDate(to.getUTCDate() - 1);
      const from = new Date(to); from.setUTCDate(from.getUTCDate() - 6);
      dateFrom = pyDateStr(from);
      dateTo   = pyDateStr(to);
    } else {
      // monthly — mes anterior
      const [cy, cm] = todayPY.split('-').map(Number);
      const prevM = cm === 1 ? 12 : cm - 1;
      const prevY = cm === 1 ? cy - 1 : cy;
      dateFrom = `${prevY}-${String(prevM).padStart(2,'0')}-01`;
      dateTo   = `${prevY}-${String(prevM).padStart(2,'0')}-${new Date(prevY, prevM, 0).getDate()}`;
    }

    const report = await generateMarcadasReport({
      dateFrom, dateTo,
      employeeId: config.employeeId,
      deptId: config.deptId,
    });

    // Construir HTML del email
    const tableHtmlParts = report.data.map(emp => `
      <h3>${emp.employee_name} [${emp.code}] — ${emp.department || ''}</h3>
      ${buildMarcadasTableHtml(emp)}
      <p style="text-align:right;font-weight:bold;color:#1e40af">Total período: ${emp.total_hm}</p>
      <hr>
    `).join('');

    const html = buildReportEmailHtml({
      title: schedule.name,
      period: `${dateFrom} al ${dateTo}`,
      tableHtml: tableHtmlParts || '<p>Sin registros en este período</p>',
    });

    // Enviar a los destinatarios configurados
    const recipients = schedule.recipients ? schedule.recipients.split(',').map(e => e.trim()) : [];
    if (recipients.length > 0) {
      await sendMail({ to: recipients, subject: `${schedule.name} — ${dateFrom}`, html });
    }

    // Actualizar último envío
    await sequelize.query(
      'UPDATE report_schedules SET last_run = NOW() WHERE id = ?',
      { replacements: [schedule.id] }
    );

  } catch (err) {
    // Se relanza: quien decide y registra es runJob, con job, duración y
    // error_code. Tragarlo acá hacía que un reporte fallido quedara como OK.
    err.stage = err.stage || 'reporte_programado';
    throw err;
  }
}

// Detener un job
function stopJob(scheduleId) {
  if (_jobs.has(scheduleId)) {
    _jobs.get(scheduleId).stop();
    _jobs.delete(scheduleId);
  }
}

// ─── Recalcular daily_summary en bloque para una fecha (Paraguay) ─
async function bulkRecalcDailySummary(date) {
  // Insertar/actualizar daily_summary para todos los empleados
  // con registros en attendance_logs para la fecha dada.
  // late_minutes se calcula comparando primer IN con el horario del empleado.
  // Rango SARGABLE (>= inicio, < díaSiguiente) + lock lógico por fecha para que
  // dos procesos no recalculen el mismo día a la vez (elimina el deadlock).
  const { start, next } = dayBounds(date);
  const { retries } = await withDayRecalcLock(date, async (t) => {
  await sequelize.query(`
    INSERT INTO daily_summary
      (employee_id, date, first_in, last_out, worked_minutes, late_minutes, overtime_minutes, status)
    SELECT
      al.employee_id,
      ? AS date,
      MIN(CASE WHEN al.type = 'in'  THEN al.timestamp END) AS first_in,
      MAX(CASE WHEN al.type = 'out' THEN al.timestamp END) AS last_out,
      GREATEST(0, COALESCE(
        TIMESTAMPDIFF(MINUTE,
          MIN(CASE WHEN al.type = 'in'  THEN al.timestamp END),
          MAX(CASE WHEN al.type = 'out' THEN al.timestamp END)
        ), 0
      ) - (
        -- Descuento de descanso configurado en el horario del empleado.
        SELECT COALESCE(s3.break_minutes, 0)
        FROM employees e3 LEFT JOIN schedules s3 ON e3.schedule_id = s3.id
        WHERE e3.id = al.employee_id LIMIT 1
      )) AS worked_minutes,
      GREATEST(0, COALESCE(
        TIMESTAMPDIFF(MINUTE,
          CONCAT(?, ' ', (
            SELECT TIME_FORMAT(
              ADDTIME(s2.check_in, SEC_TO_TIME(COALESCE(s2.tolerance_in,0)*60)),
              '%H:%i:%s')
            FROM employees e2
            LEFT JOIN schedules s2 ON e2.schedule_id = s2.id
            WHERE e2.id = al.employee_id LIMIT 1
          )),
          MIN(CASE WHEN al.type = 'in' THEN al.timestamp END)
        ), 0
      )) AS late_minutes,
      -- Horas extra: minutos que la última SALIDA excede el fin de horario más
      -- su tolerancia (simétrico al cálculo de late_minutes sobre la entrada).
      GREATEST(0, COALESCE(
        TIMESTAMPDIFF(MINUTE,
          CONCAT(?, ' ', (
            SELECT TIME_FORMAT(
              ADDTIME(s2.check_out, SEC_TO_TIME(COALESCE(s2.tolerance_out,0)*60)),
              '%H:%i:%s')
            FROM employees e2
            LEFT JOIN schedules s2 ON e2.schedule_id = s2.id
            WHERE e2.id = al.employee_id LIMIT 1
          )),
          MAX(CASE WHEN al.type = 'out' THEN al.timestamp END)
        ), 0
      )) AS overtime_minutes,
      CASE
        WHEN MIN(CASE WHEN al.type = 'in' THEN al.timestamp END) IS NOT NULL THEN
          CASE WHEN
            TIMESTAMPDIFF(MINUTE,
              CONCAT(?, ' ', (
                SELECT TIME_FORMAT(
                  ADDTIME(s2.check_in, SEC_TO_TIME(COALESCE(s2.tolerance_in,0)*60)),
                  '%H:%i:%s')
                FROM employees e2
                LEFT JOIN schedules s2 ON e2.schedule_id = s2.id
                WHERE e2.id = al.employee_id LIMIT 1
              )),
              MIN(CASE WHEN al.type = 'in' THEN al.timestamp END)
            ) > 0
          THEN 'late'
          ELSE 'present'
          END
        ELSE 'absent'
      END AS status
    FROM attendance_logs al
    WHERE al.timestamp >= ? AND al.timestamp < ?
    GROUP BY al.employee_id
    ORDER BY al.employee_id
    ON DUPLICATE KEY UPDATE
      first_in         = COALESCE(VALUES(first_in),       daily_summary.first_in),
      last_out         = COALESCE(VALUES(last_out),        daily_summary.last_out),
      worked_minutes   = VALUES(worked_minutes),
      late_minutes     = VALUES(late_minutes),
      overtime_minutes = VALUES(overtime_minutes),
      -- 'status' aparece tanto en la columna destino (daily_summary) como en
      -- la lista derivada del SELECT (… END AS status), por eso MySQL 8 lo ve
      -- ambiguo. Se califica el valor EXISTENTE con daily_summary.status y el
      -- valor NUEVO con VALUES(status). No se pisan estados manuales.
      status           = CASE
        WHEN daily_summary.status IN ('holiday','weekend','permission') THEN daily_summary.status
        ELSE VALUES(status)
      END
  `, { replacements: [date, date, date, date, start, next], transaction: t });
  }, { label: `bulkRecalc:${date}` });

  logger.info(`♻️  daily_summary recalculado para ${date}${retries ? ` (tras ${retries} reintento(s) por bloqueo)` : ''}`);
}

// Materializar ausentes: inserta filas 'absent' para empleados activos que,
// según su horario (schedules.work_days, convención DAYOFWEEK: 1=Dom..7=Sáb),
// debían trabajar ese día, no es feriado, y no tienen ya una fila. No pisa
// filas existentes. Empleados sin horario asignado se omiten.
async function materializeAbsents(date) {
  let n = 0;
  // Bajo el mismo lock por fecha: nunca choca con un recálculo del mismo día.
  await withDayRecalcLock(date, async (t) => {
    const [res] = await sequelize.query(`
      INSERT INTO daily_summary (employee_id, date, status)
      SELECT e.id, ?, 'absent'
      FROM employees e
      JOIN schedules s ON e.schedule_id = s.id
      WHERE e.status = 'active'
        AND FIND_IN_SET(DAYOFWEEK(?), REPLACE(s.work_days, ' ', ''))
        AND NOT EXISTS (SELECT 1 FROM daily_summary ds WHERE ds.employee_id = e.id AND ds.date = ?)
        AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.date = ?)
      ON DUPLICATE KEY UPDATE status = daily_summary.status
    `, { replacements: [date, date, date, date], transaction: t });
    n = res?.affectedRows ?? 0;
  }, { label: `materialize:${date}` });
  if (n > 0) logger.info(`🚫 ${n} ausente(s) materializado(s) para ${date}`);
  return n;
}

// ─── Cron respaldo: pull att2000 → MySQL (integración LEGADA, opcional) ───
// Requiere DOS condiciones:
//   1) kill switch ATT2000_AUTO_PULL_ENABLED=true (por defecto false), y
//   2) ATT2000_PULL_CRON="*/10 * * * *" (expresión node-cron).
// Con el kill switch en false el cron NO se registra (att2000 queda como
// integración legada disponible sólo por acciones manuales). No apaga el cron
// en caliente ni elimina endpoints: sólo decide si programar el pull automático.
const { autoPullEnabled, recordRun } = require('./att2000Legacy');
let _att2000PullJob = null;
function startAtt2000PullCron() {
  if (!autoPullEnabled()) {
    logger.info('⏸️  att2000 pull automático DESHABILITADO (ATT2000_AUTO_PULL_ENABLED != true). Integración legada disponible por acciones manuales.');
    return;
  }
  const expr = process.env.ATT2000_PULL_CRON;
  if (!expr) return;
  if (_att2000PullJob) _att2000PullJob.stop();

  try {
    const { syncAttendance } = require('../config/zkAdapter');
    _att2000PullJob = cron.schedule(expr, cronCallback('att2000_pull', async () => {
      try {
        const dateFrom = pyDateStr(new Date(Date.now() - 24 * 3600 * 1000));
        const result = await syncAttendance({ dateFrom, limit: 5000 });
        logger.info(`⏱️  Cron att2000 pull: ${JSON.stringify(result)}`);
        recordRun({ source: 'auto', ok: true, imported: result?.imported, duplicate: result?.duplicate ?? result?.skipped, unmapped: result?.unmapped ?? result?.notFound });

        // Recalcular daily_summary para hoy y ayer (Paraguay) después del sync
        const today     = pyDateStr(new Date());
        const yesterday = dateFrom;
        for (const date of [today, yesterday]) {
          try {
            await bulkRecalcDailySummary(date);
            await materializeAbsents(date);
          } catch (e) {
            logger.warn(`bulkRecalc ${date}: ${e.message}`);
          }
        }
        return result;   // { imported, skipped, notFound, total } → processed
      } catch (err) {
        recordRun({ source: 'auto', ok: false, error: err.message });
        throw err;   // el runner lo registra con código y detalle seguros
      }
    }));
    logger.info(`📅 Cron respaldo att2000 → MySQL (legado) activo: ${expr}`);
  } catch (err) {
    logger.error('No se pudo registrar ATT2000_PULL_CRON', {
      job: 'att2000_pull', result: 'error',
      error_code: safeErrorCode(err), error: serializeError(err, { stage: 'register' }),
    });
  }
}

// ─── Cron alertas diarias de atrasos/ausencias ───────────────────
let _lateJob = null;
let _absentJob = null;
function startDailyAlertsCron() {
  try {
    const { sendDailyLateAlerts, sendDailyAbsenceAlerts } = require('./notifications');
    const lateExpr   = process.env.DAILY_LATE_CRON   || '30 9 * * 1-6';
    const absentExpr = process.env.DAILY_ABSENT_CRON || '0 10 * * 1-6';
    const tz         = process.env.CRON_TZ || 'America/Asuncion';

    if (_lateJob) _lateJob.stop();
    if (cron.validate(lateExpr)) {
      _lateJob = cron.schedule(lateExpr, cronCallback('alertas_atrasos', async () => {
        const r = await sendDailyLateAlerts();
        logger.info(`📧 Alertas atrasos: ${JSON.stringify(r)}`);
        // Webhook Slack/Teams
        try {
          const wh = require('./notificationWebhooks');
          const [rows] = await require('../config/database').sequelize.query(
            `SELECT ds.late_minutes, CONCAT(e.first_name,' ',e.last_name) AS full_name, d.name AS department
             FROM daily_summary ds
             JOIN employees e ON e.id = ds.employee_id
             LEFT JOIN departments d ON d.id = e.department_id
             WHERE ds.date = CURDATE() AND ds.status = 'late' AND ds.late_minutes > 0
             ORDER BY ds.late_minutes DESC LIMIT 20`
          );
          if (rows.length) await wh.notifyLateArrivals(rows).catch(() => {});
        } catch {}
        return r;
      }), { timezone: tz });
      logger.info(`📅 Cron alertas atrasos activo: ${lateExpr} (${tz})`);
    }

    if (_absentJob) _absentJob.stop();
    if (cron.validate(absentExpr)) {
      _absentJob = cron.schedule(absentExpr, cronCallback('alertas_ausencias', async () => {
        const r = await sendDailyAbsenceAlerts();
        logger.info(`📧 Alertas ausencias: ${JSON.stringify(r)}`);
        // Webhook Slack/Teams
        try {
          const wh = require('./notificationWebhooks');
          const [rows] = await require('../config/database').sequelize.query(
            `SELECT CONCAT(e.first_name,' ',e.last_name) AS full_name, d.name AS department
             FROM daily_summary ds
             JOIN employees e ON e.id = ds.employee_id
             LEFT JOIN departments d ON d.id = e.department_id
             WHERE ds.date = CURDATE() AND ds.status = 'absent'
             ORDER BY e.last_name, e.first_name LIMIT 20`
          );
          if (rows.length) await wh.notifyAbsences(rows).catch(() => {});
        } catch {}
        return r;
      }), { timezone: tz });
      logger.info(`📅 Cron alertas ausencias activo: ${absentExpr} (${tz})`);
    }
  } catch (err) {
    logger.error('No se pudieron registrar crons de alertas', {
      job: 'alertas_diarias', result: 'error',
      error_code: safeErrorCode(err), error: serializeError(err, { stage: 'register' }),
    });
  }
}

// ─── Cron diario: vencimiento de capacitaciones ──────────────────
let _coursesCron = null;
function startCoursesDueCron() {
  const expr = process.env.COURSES_DUE_CRON || '0 8 * * 1-6'; // cada día hábil a las 8am
  const tz   = process.env.CRON_TZ || 'America/Asuncion';
  try {
    if (_coursesCron) _coursesCron.stop();
    if (!cron.validate(expr)) return;
    _coursesCron = cron.schedule(expr, cronCallback('capacitaciones_vencimiento', async () => {
      try {
        // Buscar asignaciones de cursos vencidas o a punto de vencer (próximos 3 días)
        //
        // ── Pendiente = completed_at IS NULL ────────────────────────────
        //
        // `course_assignments` NO tiene columna `status`: la migración 028 la
        // creó con diez columnas y el estado de completitud vive en
        // `completed_at` (NULL = pendiente). Esta consulta filtraba por
        // `ca.status NOT IN ('completed','cancelled')` y por eso reventaba
        // TODAS las corridas con ER_BAD_FIELD_ERROR / 42S22.
        //
        // El nombre salió de dos lugares que lo hacen parecer real:
        //   · el índice `idx_emp_status (employee_id, completed_at)` de la 028,
        //     que se llama "status" pero está construido sobre completed_at;
        //   · el alias calculado `AS status` del CASE en GET /courses/:id/progress,
        //     que deriva completed|overdue|due_soon|pending en tiempo de consulta.
        // Ninguno de los dos es una columna almacenada. `'cancelled'`, además,
        // es vocabulario de permisos/onboarding: capacitaciones nunca lo tuvo.
        //
        // ── Un correo por asignación ────────────────────────────────────
        //
        // `users.employee_id` no tiene UNIQUE, así que un empleado con dos
        // cuentas activas duplicaba la fila por el LEFT JOIN y recibía el mismo
        // recordatorio dos veces. La subconsulta escalar toma una sola cuenta,
        // de forma determinística (la de menor id), y la envoltura filtra las
        // que no tienen correo — antes eso lo hacía un WHERE sobre la tabla
        // del LEFT JOIN, que lo volvía un INNER JOIN encubierto.
        //
        // `c.active = 1` acompaña a GET /courses/my y a DELETE /courses/:id
        // (borrado lógico): un curso dado de baja no debe seguir generando
        // recordatorios.
        const [rows] = await sequelize.query(`
          SELECT * FROM (
            SELECT
              ca.id AS assignment_id,
              ca.employee_id,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              (SELECT u.email
                 FROM users u
                WHERE u.employee_id = e.id
                  AND u.active = 1
                  AND u.email IS NOT NULL
                  AND u.email != ''
                ORDER BY u.id
                LIMIT 1) AS employee_email,
              c.title AS course_title,
              ca.due_date,
              DATEDIFF(ca.due_date, CURDATE()) AS days_left
            FROM course_assignments ca
            JOIN courses c ON c.id = ca.course_id
            JOIN employees e ON e.id = ca.employee_id
            WHERE ca.completed_at IS NULL
              AND c.active = 1
              AND ca.due_date IS NOT NULL
              AND DATEDIFF(ca.due_date, CURDATE()) BETWEEN -1 AND 3
          ) t
          WHERE t.employee_email IS NOT NULL
          ORDER BY t.due_date ASC
          LIMIT 200
        `);

        let sent = 0;
        for (const r of rows) {
          const overdue = r.days_left < 0;
          const subject = overdue
            ? `⚠️ Capacitación vencida: ${r.course_title}`
            : `📚 Recordatorio capacitación: ${r.course_title} (${r.days_left === 0 ? 'vence hoy' : `${r.days_left} día${r.days_left > 1 ? 's' : ''}`})`;
          await sendMail({
            to: r.employee_email,
            subject,
            html: `<div style="font-family:sans-serif;max-width:600px">
              <h2 style="color:${overdue ? '#dc2626' : '#d97706'}">${subject}</h2>
              <p>Hola <strong>${r.employee_name}</strong>,</p>
              <p>${overdue
                ? `La capacitación <strong>${r.course_title}</strong> venció el <strong>${r.due_date}</strong>. Por favor completala lo antes posible.`
                : `La capacitación <strong>${r.course_title}</strong> vence el <strong>${r.due_date}</strong>. Ingresá al portal para completarla.`
              }</p>
              <p style="color:#9ca3af;font-size:12px">Sistema de Asistencia — Notificación automática</p>
            </div>`,
          }).catch(() => {});
          sent++;
        }
        if (sent) logger.info(`📚 Cron cursos: ${sent} recordatorio(s) enviado(s)`);
        return { sent };
      } catch (err) {
        throw err;   // el runner registra job, duración, error_code y detalle
      }
    }), { timezone: tz });
    logger.info(`📅 Cron vencimiento capacitaciones activo: ${expr} (${tz})`);
  } catch (err) {
    logger.error('No se pudo registrar cron de capacitaciones', {
      job: 'capacitaciones_vencimiento', result: 'error',
      error_code: safeErrorCode(err), error: serializeError(err, { stage: 'register' }),
    });
  }
}

module.exports = {
  loadSchedules,
  registerJob,
  stopJob,
  generateMarcadasReport,
  buildMarcadasTableHtml,
  maxPairsOf,
  minsToHM,
  fmtTime,
  bulkRecalcDailySummary,
  materializeAbsents,
  pyDateStr,
  startAtt2000PullCron,
  startDailyAlertsCron,
  startCoursesDueCron,
};
