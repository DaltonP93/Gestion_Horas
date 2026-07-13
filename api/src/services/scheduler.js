/**
 * scheduler.js
 * Gestión de reportes automáticos programados con node-cron.
 * Los schedules se guardan en la tabla report_schedules de MySQL.
 */

const cron = require('node-cron');
const { sequelize } = require('../config/database');
const { sendMail, buildReportEmailHtml } = require('./emailService');
const logger = require('../config/logger');

const _jobs = new Map(); // scheduleId → tarea cron activa

// ─── Helpers de timezone Paraguay ────────────────────────────────
const TZ_PY = 'America/Asuncion';
const _dtfHour = new Intl.DateTimeFormat('es-PY', { timeZone: TZ_PY, hour: 'numeric', hour12: false });
const _dtfDate = new Intl.DateTimeFormat('es-PY', { timeZone: TZ_PY, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Hora (0-23) de un Date en Paraguay */
function pyHour(d) { return parseInt(_dtfHour.format(d), 10); }

/** "YYYY-MM-DD" de un Date en Paraguay */
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
async function generateMarcadasReport({ dateFrom, dateTo, employeeId, deptId } = {}) {
  const today = pyDateStr(new Date());
  const from  = dateFrom || today;
  const to    = dateTo   || today;

  let empFilter = 'WHERE e.status = "active"';
  const params  = [from, to];
  if (employeeId) { empFilter += ' AND e.id = ?'; params.push(employeeId); }
  if (deptId)     { empFilter += ' AND e.department_id = ?'; params.push(deptId); }

  // Obtener todos los logs del período
  const [logs] = await sequelize.query(`
    SELECT
      e.id AS employee_id,
      CONCAT(e.first_name,' ',e.last_name) AS employee_name,
      e.code,
      d.name AS department,
      al.timestamp, al.type
    FROM attendance_logs al
    JOIN employees e ON al.employee_id = e.id
    LEFT JOIN departments d ON e.department_id = d.id
    ${empFilter.replace('WHERE e.status = "active"', 'WHERE e.status = "active"')}
      AND DATE(al.timestamp) BETWEEN ? AND ?
    ORDER BY e.last_name, al.timestamp
  `, { replacements: params });

  // Agrupar por empleado y fecha (fecha "laboral": marcas 00:00-04:59 se asignan al día anterior)
  const byEmp = {};
  const SHIFT_CUTOFF_HOUR = 5; // marcas antes de las 05:00 pertenecen al turno del día anterior
  for (const log of logs) {
    if (!byEmp[log.employee_id]) {
      byEmp[log.employee_id] = {
        employee_id: log.employee_id,
        employee_name: log.employee_name,
        code: log.code,
        department: log.department,
        days: {},
      };
    }
    const ts = toDate(log.timestamp);                // → JS Date UTC correcto
    const workDate = new Date(ts);
    if (pyHour(ts) < SHIFT_CUTOFF_HOUR) {           // hora en Paraguay
      workDate.setUTCDate(workDate.getUTCDate() - 1);
    }
    const date = pyDateStr(workDate);               // fecha laboral en Paraguay
    if (!byEmp[log.employee_id].days[date]) {
      byEmp[log.employee_id].days[date] = [];
    }
    byEmp[log.employee_id].days[date].push(ts);
  }

  // Construir filas tipo "Marcadas" — pares entrada/salida
  const result = [];
  const DAY_NAMES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const MONTH_NAMES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

  for (const empData of Object.values(byEmp)) {
    const rows = [];
    let totalMinutes = 0;

    for (const [dateStr, marks] of Object.entries(empData.days).sort()) {
      const d = new Date(dateStr + 'T12:00');
      const dayName = DAY_NAMES[d.getDay()];
      const formatted = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

      // Ordenar marcas y deduplicar las que caen dentro del mismo minuto
      // (algunos relojes registran el mismo fichaje 2 veces por segundo)
      marks.sort((a, b) => a - b);
      const deduped = [];
      for (const m of marks) {
        const last = deduped[deduped.length - 1];
        if (!last || Math.abs(m - last) > 60 * 1000) deduped.push(m);
      }

      // Emparejar (par = entrada, impar = salida) y sumar sólo pares completos.
      // Así se excluye el tiempo de almuerzo entre pares (in/out/in/out).
      // Si el día queda con un marcaje impar sin par, se ignora la última entrada.
      const pairs = [];
      let dayMinutes = 0;
      for (let i = 0; i < deduped.length; i += 2) {
        const entrada = deduped[i];
        const salida  = deduped[i + 1];
        pairs.push({
          entrada: entrada ? fmtTime(entrada) : '',
          salida:  salida  ? fmtTime(salida)  : '',
        });
        if (entrada && salida && salida > entrada) {
          dayMinutes += Math.round((salida - entrada) / 60000);
        }
      }
      totalMinutes += dayMinutes;

      rows.push({
        dayName,
        date: formatted,
        pairs,          // array de {entrada, salida}
        total: dayMinutes > 0 ? minsToHM(dayMinutes) : '0:00',
      });
    }

    result.push({
      ...empData,
      rows,
      total_minutes: totalMinutes,
      total_hm: minsToHM(totalMinutes),
    });
  }

  return { data: result, period: { from, to } };
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

// ─── Construir tabla HTML del reporte marcadas ────────────────────
function buildMarcadasTableHtml(empData) {
  const maxPairs = Math.max(...empData.rows.map(r => r.pairs.length), 1);

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

  const task = cron.schedule(schedule.cron_expression, async () => {
    logger.info(`Ejecutando reporte programado #${schedule.id}: ${schedule.name}`);
    await runScheduledReport(schedule);
  }, { timezone: schedule.timezone || TZ_PY });

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
    logger.error(`Error en reporte programado #${schedule.id}:`, err);
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
    WHERE DATE(al.timestamp) = ?
    GROUP BY al.employee_id
    ON DUPLICATE KEY UPDATE
      first_in         = COALESCE(VALUES(first_in),       first_in),
      last_out         = COALESCE(VALUES(last_out),        last_out),
      worked_minutes   = VALUES(worked_minutes),
      late_minutes     = VALUES(late_minutes),
      overtime_minutes = VALUES(overtime_minutes),
      status           = CASE
        WHEN status IN ('holiday','weekend','permission') THEN status
        ELSE VALUES(status)
      END
  `, { replacements: [date, date, date, date, date] });

  logger.info(`♻️  daily_summary recalculado para ${date}`);
}

// Materializar ausentes: inserta filas 'absent' para empleados activos que,
// según su horario (schedules.work_days, convención DAYOFWEEK: 1=Dom..7=Sáb),
// debían trabajar ese día, no es feriado, y no tienen ya una fila. No pisa
// filas existentes. Empleados sin horario asignado se omiten.
async function materializeAbsents(date) {
  const [res] = await sequelize.query(`
    INSERT INTO daily_summary (employee_id, date, status)
    SELECT e.id, ?, 'absent'
    FROM employees e
    JOIN schedules s ON e.schedule_id = s.id
    WHERE e.status = 'active'
      AND FIND_IN_SET(DAYOFWEEK(?), REPLACE(s.work_days, ' ', ''))
      AND NOT EXISTS (SELECT 1 FROM daily_summary ds WHERE ds.employee_id = e.id AND ds.date = ?)
      AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.date = ?)
    ON DUPLICATE KEY UPDATE status = status
  `, { replacements: [date, date, date, date] });
  const n = res?.affectedRows ?? 0;
  if (n > 0) logger.info(`🚫 ${n} ausente(s) materializado(s) para ${date}`);
  return n;
}

// ─── Cron respaldo: pull att2000 → MySQL ─────────────────────────
// Activar con ATT2000_PULL_CRON="*/10 * * * *" (sintaxis node-cron)
let _att2000PullJob = null;
function startAtt2000PullCron() {
  const expr = process.env.ATT2000_PULL_CRON;
  if (!expr) return;
  if (_att2000PullJob) _att2000PullJob.stop();

  try {
    const { syncAttendance } = require('../config/zkAdapter');
    _att2000PullJob = cron.schedule(expr, async () => {
      try {
        const dateFrom = pyDateStr(new Date(Date.now() - 24 * 3600 * 1000));
        const result = await syncAttendance({ dateFrom, limit: 5000 });
        logger.info(`⏱️  Cron att2000 pull: ${JSON.stringify(result)}`);

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
      } catch (err) {
        logger.error('Error en cron att2000 pull:', err.message);
      }
    });
    logger.info(`📅 Cron respaldo att2000 → MySQL activo: ${expr}`);
  } catch (err) {
    logger.error('No se pudo registrar ATT2000_PULL_CRON:', err.message);
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
      _lateJob = cron.schedule(lateExpr, async () => {
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
      }, { timezone: tz });
      logger.info(`📅 Cron alertas atrasos activo: ${lateExpr} (${tz})`);
    }

    if (_absentJob) _absentJob.stop();
    if (cron.validate(absentExpr)) {
      _absentJob = cron.schedule(absentExpr, async () => {
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
      }, { timezone: tz });
      logger.info(`📅 Cron alertas ausencias activo: ${absentExpr} (${tz})`);
    }
  } catch (err) {
    logger.error('No se pudieron registrar crons de alertas:', err.message);
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
    _coursesCron = cron.schedule(expr, async () => {
      try {
        // Buscar asignaciones de cursos vencidas o a punto de vencer (próximos 3 días)
        const [rows] = await sequelize.query(`
          SELECT
            ca.id AS assignment_id,
            ca.employee_id,
            CONCAT(e.first_name,' ',e.last_name) AS employee_name,
            u.email AS employee_email,
            c.title AS course_title,
            ca.due_date,
            DATEDIFF(ca.due_date, CURDATE()) AS days_left
          FROM course_assignments ca
          JOIN courses c ON c.id = ca.course_id
          JOIN employees e ON e.id = ca.employee_id
          LEFT JOIN users u ON u.employee_id = e.id AND u.active = 1
          WHERE ca.status NOT IN ('completed','cancelled')
            AND ca.due_date IS NOT NULL
            AND DATEDIFF(ca.due_date, CURDATE()) BETWEEN -1 AND 3
            AND u.email IS NOT NULL AND u.email != ''
          ORDER BY ca.due_date ASC
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
      } catch (err) {
        logger.error('Error cron courses due:', err.message);
      }
    }, { timezone: tz });
    logger.info(`📅 Cron vencimiento capacitaciones activo: ${expr} (${tz})`);
  } catch (err) {
    logger.error('No se pudo registrar cron de capacitaciones:', err.message);
  }
}

module.exports = {
  loadSchedules,
  registerJob,
  stopJob,
  generateMarcadasReport,
  buildMarcadasTableHtml,
  minsToHM,
  fmtTime,
  bulkRecalcDailySummary,
  materializeAbsents,
  pyDateStr,
  startAtt2000PullCron,
  startDailyAlertsCron,
  startCoursesDueCron,
};
