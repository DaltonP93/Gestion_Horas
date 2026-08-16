const { sequelize } = require('../config/database');
const { getIO, emitAttendance } = require('../socket/socketServer');
const logger = require('../config/logger');
const { withDayRecalcLock, dayBounds } = require('../services/recalcLock');
const { dbSecondsOfDay, dbDateISO } = require('../utils/dbTime');
const calc = require('../services/dailySummaryCalc');
const { LINKED_SQL } = require('../services/rawPunchStats');
const { getVisibleDepartmentIds, applyDepartmentScope } = require('../services/departmentScope');
let fireWebhooks;
try { ({ fireWebhooks } = require('../routes/webhooks')); } catch {}
let writeCheckinOut;
try { ({ writeCheckinOut } = require('../config/att2000')); } catch {}

// ─── Procesar evento de marcaje (desde Redis Pub/Sub del Bridge) ────────────
async function processAttendanceEvent(data) {
  const { employeeCode, timestamp, deviceId, deviceIp, deviceSn, type = 'unknown', raw } = data;

  try {
    // Buscar empleado por código ZKTeco (cualquier estado: no perdemos marcas).
    const [[emp]] = await sequelize.query(
      'SELECT id, first_name, last_name, schedule_id, status FROM employees WHERE code = ?',
      { replacements: [employeeCode] }
    );

    if (!emp) {
      logger.warn(`Marcaje de código desconocido: ${employeeCode}`);
      return;
    }

    const ts = new Date(timestamp);
    const detectedType = type !== 'unknown' ? type : await detectMarkType(emp.id, ts);

    // Resolver device_id si no vino pero tenemos IP
    let resolvedDeviceId = deviceId;
    if (!resolvedDeviceId && deviceIp) {
      const [[dev]] = await sequelize.query(
        'SELECT id FROM devices WHERE ip_address = ? LIMIT 1',
        { replacements: [deviceIp] }
      ).catch(() => [[]]);
      resolvedDeviceId = dev?.id || null;
    }

    // Insertar log (INSERT IGNORE — idempotente por clave única).
    // Se conserva SIEMPRE, incluso para inactivos, para no perder el histórico.
    await sequelize.query(`
      INSERT IGNORE INTO attendance_logs (employee_id, device_id, timestamp, type, source, raw_data)
      VALUES (?, ?, ?, ?, 'device', ?)
    `, { replacements: [emp.id, resolvedDeviceId, ts, detectedType, JSON.stringify(raw || {})] });

    // Empleado inactivo/suspendido que sigue marcando → alerta, sin procesar
    // como asistencia operativa (no recalc, no att2000, no retardo). La marca
    // ya quedó guardada arriba para trazabilidad.
    if (emp.status && emp.status !== 'active') {
      logger.warn(`⚠️ Marcaje de empleado NO activo (${emp.status}): ${emp.first_name} ${emp.last_name} [${employeeCode}]`);
      try {
        const audit = require('../services/audit');
        audit.log({ req: null, user: null, action: 'attendance.inactive_mark', entity: 'employee', entity_id: emp.id,
          details: { code: employeeCode, name: `${emp.first_name} ${emp.last_name}`, status: emp.status, timestamp: ts.toISOString(), device_id: resolvedDeviceId } });
      } catch { /* auditoría best-effort */ }
      try {
        getIO().to('role:admin').to('role:gestor').to('role:hr').emit('attendance:inactive_mark', {
          employeeId: emp.id, employeeName: `${emp.first_name} ${emp.last_name}`,
          employeeCode, status: emp.status, timestamp: ts.toISOString(), deviceId: resolvedDeviceId,
        });
      } catch { /* socket opcional */ }
      return;
    }

    // Replicar el marcaje en att2000.CHECKINOUT si está habilitado
    if (process.env.ATT2000_WRITE_ENABLED === 'true' && writeCheckinOut) {
      writeCheckinOut([{
        userId: employeeCode,
        attTime: ts,
        inOutStatus: detectedType === 'in' ? 0 : detectedType === 'out' ? 1 : null,
        sensorId: resolvedDeviceId || 0,
        verifyMode: 0
      }]).catch(err => logger.error(`att2000 write falló: ${err.message}`));
    }

    // Recalcular resumen diario
    await recalcDailySummary(emp.id, ts);

    // Emitir en tiempo real a todos los clientes web
    const io = getIO();
    const event = {
      employeeId: emp.id,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      employeeCode,
      timestamp: ts.toISOString(),
      type: detectedType,
      deviceId
    };

    emitAttendance(event);

    // Disparar webhooks a sistemas externos (Oracle APEX, ERP, etc.)
    if (fireWebhooks) {
      const webhookEvent = detectedType === 'in' ? 'attendance.checkin' : 'attendance.checkout';
      fireWebhooks(webhookEvent, event).catch(() => {});
    }

    // Verificar retardos y emitir alerta
    if (detectedType === 'in') {
      await checkAndAlertLate(emp, ts, io);
    }

    logger.info(`Marcaje: ${emp.first_name} ${emp.last_name} - ${detectedType} - ${ts.toISOString()}`);
  } catch (err) {
    logger.error('Error en processAttendanceEvent:', err);
    throw err;
  }
}

// Determinar si es entrada o salida según historial del día
async function detectMarkType(employeeId, timestamp) {
  // MISMA semántica de fecha que recalcDailySummary. Si acá se usara la
  // conversión a America/Asuncion, un marcaje de madrugada en una fecha de
  // invierno anterior al 2024-10-06 contaría las marcas del día ANTERIOR y
  // se inferiría un in/out equivocado, que después consume el resumen.
  const date = dbDateISO(timestamp)
    || new Intl.DateTimeFormat('sv', { timeZone: 'UTC' }).format(
         timestamp instanceof Date ? timestamp : new Date(timestamp)
       );
  const [[row]] = await sequelize.query(
    'SELECT COUNT(*) AS cnt FROM attendance_logs WHERE employee_id = ? AND DATE(timestamp) = ?',
    { replacements: [employeeId, date] }
  );
  // Par: salida, Impar: entrada
  return row.cnt % 2 === 0 ? 'in' : 'out';
}

// Recalcular resumen diario del empleado
async function recalcDailySummary(employeeId, timestamp) {
  // Fecha del resumen = fecha de la hora de pared guardada, sin conversión.
  //
  // Antes se formateaba el instante en `America/Asuncion`, lo que aplica la
  // tzdata histórica: para un marcaje de madrugada en una fecha de invierno
  // anterior al 2024-10-06 (Paraguay en UTC-4) el resultado caía en el DÍA
  // ANTERIOR, y el resumen se escribía contra la clave equivocada. La fecha
  // que corresponde es la que está guardada en la columna.
  const date = dbDateISO(timestamp)
    || new Intl.DateTimeFormat('sv', { timeZone: 'UTC' }).format(
         timestamp instanceof Date ? timestamp : new Date(timestamp)
       );

  // Rango SARGABLE [inicio, díaSiguiente): usa el índice idx_ts/idx_emp_ts y
  // acota los locks de rango (a diferencia de DATE(timestamp), que fuerza
  // scan del índice funcional y amplía los next-key locks → deadlocks).
  const { start, next } = dayBounds(date);
  const [logs] = await sequelize.query(`
    SELECT timestamp, type FROM attendance_logs
    WHERE employee_id = ? AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp ASC
  `, { replacements: [employeeId, start, next] });

  // ¿Es feriado o fin de semana? Marcar estado aunque no haya marcajes
  const [[holiday]] = await sequelize.query(
    'SELECT id, name FROM holidays WHERE date = ? AND active = 1 LIMIT 1',
    { replacements: [date] }
  );
  const dow = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Dom, 6=Sáb
  const isWeekend = (dow === 0 || dow === 6);

  if (!logs.length) {
    // Sin marcajes: si es feriado o fin de semana, registrar como tal (no absent)
    if (holiday || isWeekend) {
      const fallbackStatus = holiday ? 'holiday' : 'weekend';
      // Bajo el lock por fecha: se serializa con el recálculo en bloque del
      // mismo día (worker/cron) y se reintenta ante deadlock/lock-wait.
      await withDayRecalcLock(date, async (t) => {
        await sequelize.query(`
          INSERT INTO daily_summary (employee_id, date, worked_minutes, late_minutes, status)
          VALUES (?, ?, 0, 0, ?)
          ON DUPLICATE KEY UPDATE status = VALUES(status)
        `, { replacements: [employeeId, date, fallbackStatus], transaction: t });
      }, { label: `recalcEmp:${date}:${employeeId}` });
    }
    return;
  }

  const firstIn  = logs.find(l => l.type === 'in');
  const lastOut  = logs.slice().reverse().find(l => l.type === 'out');

  // Todo el cálculo se hace en HORA DE PARED. Un turno se define en hora de
  // pared ("entra 07:00") y el marcaje se guarda en hora de pared: compararlos
  // no necesita zona horaria. La versión anterior construía el horario
  // previsto con offset fijo `-03:00`, que no representa a America/Asuncion
  // históricamente —Paraguay estuvo en UTC-4 hasta el 2024-10-06—, así que en
  // fechas de invierno anteriores el atraso salía corrido una hora aunque
  // first_in fuese exacto.
  const inSec  = firstIn ? dbSecondsOfDay(firstIn.timestamp)  : null;
  const outSec = lastOut ? dbSecondsOfDay(lastOut.timestamp) : null;

  const workedMinutes = calc.workedMinutes({ firstInSeconds: inSec, lastOutSeconds: outSec });

  // Obtener horario del empleado
  const [[emp]] = await sequelize.query(
    'SELECT s.check_in, s.tolerance_in FROM employees e JOIN schedules s ON e.schedule_id = s.id WHERE e.id = ?',
    { replacements: [employeeId] }
  );

  const lateMinutes = (firstIn && emp)
    ? calc.lateMinutes({
        firstInSeconds: inSec,
        checkInSeconds: calc.scheduleSeconds(emp.check_in),
        toleranceMin: emp.tolerance_in || 0,
      })
    : 0;

  const status = calc.dayStatus({ hasFirstIn: Boolean(firstIn), late: lateMinutes });

  // Bajo el lock por fecha (serializa con el recálculo en bloque del mismo día)
  // y con reintento acotado ante deadlock/lock-wait.
  await withDayRecalcLock(date, async (t) => {
    await sequelize.query(`
      INSERT INTO daily_summary (employee_id, date, first_in, last_out, worked_minutes, late_minutes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        first_in        = COALESCE(VALUES(first_in), first_in),
        last_out        = VALUES(last_out),
        worked_minutes  = VALUES(worked_minutes),
        late_minutes    = VALUES(late_minutes),
        status          = VALUES(status)
    `, { replacements: [
      employeeId, date,
      firstIn  ? firstIn.timestamp  : null,
      lastOut  ? lastOut.timestamp  : null,
      workedMinutes, lateMinutes, status
    ], transaction: t });
  }, { label: `recalcEmp:${date}:${employeeId}` });
}

async function checkAndAlertLate(emp, inTime, io) {
  const [[schedule]] = await sequelize.query(
    'SELECT s.check_in, s.tolerance_in FROM employees e JOIN schedules s ON e.schedule_id = s.id WHERE e.id = ?',
    { replacements: [emp.id] }
  ).catch(() => [[]]);

  if (!schedule) return;

  const [h, m] = schedule.check_in.split(':').map(Number);
  const deadline = new Date(inTime);
  deadline.setHours(h, m + (schedule.tolerance_in || 0), 0, 0);

  if (inTime > deadline) {
    const lateMin = Math.floor((inTime - deadline) / 60000);
    io.to('role:admin').to('role:hr').emit('alert:late', {
      employeeId: emp.id,
      employeeName: `${emp.first_name} ${emp.last_name}`,
      lateMinutes: lateMin,
      timestamp: inTime.toISOString()
    });
  }
}

// POST /api/attendance/bridge/webhook
async function bridgeWebhook(req, res) {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      await processAttendanceEvent(event);
    }
    res.json({ processed: events.length });
  } catch (err) {
    logger.error('Error en bridge webhook:', err);
    res.status(500).json({ error: 'Error procesando marcajes' });
  }
}

// Fecha actual en Paraguay (UTC-3 permanente desde 2023 / America/Asuncion)
function todayPY() {
  return new Intl.DateTimeFormat('sv', { timeZone: 'America/Asuncion' }).format(new Date());
}

// GET /api/attendance/live  — estado actual del día
async function getDashboardStats(req, res) {
  const today = todayPY();

  try {
    // RBAC jerárquico: los roles scoped ven KPIs sólo de su ámbito de
    // departamentos (mismo criterio que /api/employees). `live_punches` y
    // los indicadores de `raw_device_punches` no se filtran porque son
    // conteos operativos globales sin PII (útiles para diagnóstico de
    // sync). Los KPIs de asistencia (present/late/absent/…) sí se acotan.
    const scope = await getVisibleDepartmentIds(req.user);
    const isScoped = !scope.unrestricted;
    const emptyScope = isScoped && !(scope.ids || []).length;
    const deptClause = isScoped && !emptyScope
      ? `AND e.department_id IN (${scope.ids.map(() => '?').join(',')})`
      : '';
    const activeClause = isScoped && !emptyScope
      ? `AND emp.department_id IN (${scope.ids.map(() => '?').join(',')})`
      : '';
    const deptIds = isScoped && !emptyScope ? scope.ids : [];

    // Métricas por EMPLEADO ÚNICO (no por cantidad de marcas). Se usa
    // COUNT(DISTINCT employee_id), inmune a duplicados de daily_summary.
    // - present/late/absent/permission: empleados activos únicos en ese estado hoy.
    // - present_today: empleados únicos con AL MENOS una marca válida hoy (fuente
    //   operativa de verdad; coincide con COUNT(DISTINCT employee_id) de logs).
    // - active_employees: denominador de cobertura.
    // - live_punches: CANTIDAD de marcas del día (logs), NO empleados.
    const kpiParams = [
      ...deptIds,
      today, ...deptIds,
      today, ...deptIds,
      today, ...deptIds,
      today, ...deptIds,
      today, ...deptIds,
      today,
    ];
    const [[counts]] = await sequelize.query(`
      SELECT
        (SELECT COUNT(*) FROM employees emp WHERE emp.status = 'active' ${activeClause}) AS active_employees,
        (SELECT COUNT(DISTINCT ds.employee_id)
           FROM daily_summary ds JOIN employees e ON e.id = ds.employee_id AND e.status = 'active'
          WHERE ds.date = ? AND ds.status = 'present' ${deptClause})    AS present,
        (SELECT COUNT(DISTINCT ds.employee_id)
           FROM daily_summary ds JOIN employees e ON e.id = ds.employee_id AND e.status = 'active'
          WHERE ds.date = ? AND ds.status = 'late' ${deptClause})       AS late,
        (SELECT COUNT(DISTINCT ds.employee_id)
           FROM daily_summary ds JOIN employees e ON e.id = ds.employee_id AND e.status = 'active'
          WHERE ds.date = ? AND ds.status = 'absent' ${deptClause})     AS absent,
        (SELECT COUNT(DISTINCT ds.employee_id)
           FROM daily_summary ds JOIN employees e ON e.id = ds.employee_id AND e.status = 'active'
          WHERE ds.date = ? AND ds.status = 'permission' ${deptClause}) AS on_permission,
        (SELECT COUNT(DISTINCT al.employee_id)
           FROM attendance_logs al JOIN employees e ON e.id = al.employee_id AND e.status = 'active'
          WHERE DATE(al.timestamp) = ? ${deptClause})                   AS present_today,
        (SELECT COUNT(*) FROM attendance_logs WHERE DATE(timestamp) = ?) AS live_punches
    `, { replacements: emptyScope
        ? [today, today, today, today, today, today]  // no-op, se cortocircuita abajo
        : kpiParams });

    // Rol scoped sin depto vinculado → devolvemos ceros sin llenar recentLogs.
    if (emptyScope) {
      return res.json({
        stats: {
          total_employees: 0, active_employees: 0,
          present: 0, late: 0, absent: 0, on_permission: 0,
          present_today: 0, live_punches: 0, coverage_pct: 0,
          raw_today: 0, mapped_today: 0, unmapped_pending: 0, unmapped_today: 0,
        },
        recentLogs: [],
        date: today,
        _scope: { unrestricted: false, departments: 0 },
      });
    }

    const active = Number(counts.active_employees) || 0;
    const presentToday = Number(counts.present_today) || 0;
    const stats = {
      total_employees: active,          // compat: el denominador SON los activos
      active_employees: active,
      present: Number(counts.present) || 0,
      late: Number(counts.late) || 0,
      absent: Number(counts.absent) || 0,
      on_permission: Number(counts.on_permission) || 0,
      present_today: presentToday,      // empleados únicos con marca válida hoy
      live_punches: Number(counts.live_punches) || 0,  // cantidad de marcas hoy
      coverage_pct: active ? Math.round((presentToday / active) * 100) : 0,
    };

    // Indicadores de marcaciones crudas / vinculadas / sin empleado (best-effort:
    // raw_device_punches existe desde la migración 056). Nunca rompe el dashboard.
    stats.raw_today = 0; stats.mapped_today = 0; stats.unmapped_pending = 0; stats.unmapped_today = 0;
    try {
      // "Vinculadas" = marcas asociadas a un empleado: mapping_status 'mapped'
      // O 'duplicate' (LINKED_SQL). El auto-polling relee el buffer del reloj en
      // cada ciclo, así que las marcas ya importadas quedan como 'duplicate';
      // igual están vinculadas y deben contarse (antes se omitían).
      const [[rp]] = await sequelize.query(`
        SELECT
          SUM(LEFT(record_time_py, 10) = ?)                              AS raw_today,
          SUM(LEFT(record_time_py, 10) = ? AND ${LINKED_SQL})            AS mapped_today,
          SUM(mapping_status = 'unmapped')                              AS unmapped_pending,
          SUM(LEFT(record_time_py, 10) = ? AND mapping_status = 'unmapped') AS unmapped_today
        FROM raw_device_punches
      `, { replacements: [today, today, today] });
      stats.raw_today = Number(rp?.raw_today) || 0;
      stats.mapped_today = Number(rp?.mapped_today) || 0;
      stats.unmapped_pending = Number(rp?.unmapped_pending) || 0;
      stats.unmapped_today = Number(rp?.unmapped_today) || 0;
    } catch { /* raw_device_punches puede no existir en instalaciones viejas */ }

    const [recentLogs] = await sequelize.query(`
      SELECT
        al.id, al.timestamp, al.type, al.source,
        CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
        e.id AS employee_id, e.photo_url,
        d.name AS department, dv.name AS device_name
      FROM attendance_logs al
      JOIN employees  e  ON al.employee_id = e.id
      LEFT JOIN departments d  ON e.department_id = d.id
      LEFT JOIN devices     dv ON al.device_id = dv.id
      WHERE DATE(al.timestamp) = ? ${deptClause}
      ORDER BY al.timestamp DESC
      LIMIT 20
    `, { replacements: [today, ...deptIds] });

    res.json({
      stats, recentLogs, date: today,
      _scope: { unrestricted: !!scope.unrestricted, departments: scope.unrestricted ? null : deptIds.length },
    });
  } catch (err) {
    logger.error('Error getDashboardStats:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
}

// GET /api/attendance?date=&dept=&employeeId=
async function getByDate(req, res) {
  const { date = todayPY(), dept, employeeId, page = 1, limit = 100 } = req.query;
  const offset = (page - 1) * limit;

  let where = 'WHERE ds.date = ?';
  let params = [date];

  if (dept)       { where += ' AND e.department_id = ?'; params.push(dept); }
  if (employeeId) { where += ' AND e.id = ?'; params.push(employeeId); }

  // RBAC jerárquico: acota por departamento del usuario scoped.
  const scope = await getVisibleDepartmentIds(req.user);
  ({ where, params } = applyDepartmentScope(where, params, scope, 'e.department_id'));

  try {
    const [rows] = await sequelize.query(`
      SELECT
        ds.*, e.code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
        e.photo_url, d.name AS department, s.check_in AS scheduled_in, s.check_out AS scheduled_out
      FROM daily_summary ds
      JOIN employees   e ON ds.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN schedules   s ON e.schedule_id   = s.id
      ${where}
      ORDER BY e.last_name, e.first_name
      LIMIT ? OFFSET ?
    `, { replacements: [...params, +limit, +offset] });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener asistencia' });
  }
}

// POST /api/attendance/manual
async function registerManual(req, res) {
  const { employeeId, timestamp, type, notes } = req.body;
  if (!employeeId || !timestamp || !type) {
    return res.status(400).json({ error: 'employeeId, timestamp y type son requeridos' });
  }

  try {
    const ts = new Date(timestamp);
    await sequelize.query(
      'INSERT INTO attendance_logs (employee_id, timestamp, type, source) VALUES (?, ?, ?, "manual")',
      { replacements: [employeeId, ts, type] }
    );
    await recalcDailySummary(employeeId, ts);

    const [[emp]] = await sequelize.query(
      'SELECT first_name, last_name FROM employees WHERE id = ?',
      { replacements: [employeeId] }
    );

    emitAttendance({
      employeeId, employeeName: `${emp.first_name} ${emp.last_name}`,
      timestamp: ts.toISOString(), type, source: 'manual'
    });

    res.status(201).json({ message: 'Marcaje manual registrado' });
  } catch (err) {
    logger.error('Error registerManual:', err);
    res.status(500).json({ error: 'Error al registrar marcaje' });
  }
}

// POST /api/attendance/mobile  — marcaje desde app móvil
async function registerMobile(req, res) {
  const { latitude, longitude, accuracy } = req.body;
  const employeeId = req.user.employee_id;

  if (!employeeId) {
    return res.status(400).json({ error: 'Tu usuario no tiene un empleado asociado' });
  }

  try {
    const ts = new Date();
    const type = await detectMarkType(employeeId, ts);

    // Geocerca: valida el perímetro de la sede según el modo configurado.
    const geofence = require('../services/geofence');
    const gf = await geofence.check(employeeId, latitude, longitude);
    if (gf.blocked) {
      return res.status(403).json({
        error: `Estás fuera del área permitida de tu sede (${gf.distance}m > ${gf.fence.radius}m).`,
        geofence: { status: gf.status, distance_m: gf.distance, radius_m: gf.fence?.radius },
      });
    }

    await sequelize.query(`
      INSERT INTO attendance_logs (employee_id, timestamp, type, source, latitude, longitude, accuracy, geofence_status, distance_m)
      VALUES (?, ?, ?, 'mobile', ?, ?, ?, ?, ?)
    `, { replacements: [employeeId, ts, type, latitude, longitude, accuracy, gf.status, gf.distance] });

    await recalcDailySummary(employeeId, ts);

    const [[emp]] = await sequelize.query(
      'SELECT first_name, last_name FROM employees WHERE id = ?',
      { replacements: [employeeId] }
    );

    emitAttendance({
      employeeId, employeeName: `${emp.first_name} ${emp.last_name}`,
      timestamp: ts.toISOString(), type, source: 'mobile', latitude, longitude
    });

    res.status(201).json({
      message: `Marcaje de ${type === 'in' ? 'entrada' : 'salida'} registrado`,
      type, timestamp: ts,
      geofence: { status: gf.status, distance_m: gf.distance },
    });
  } catch (err) {
    logger.error('Error registerMobile:', err);
    res.status(500).json({ error: 'Error al registrar marcaje móvil' });
  }
}

module.exports = {
  processAttendanceEvent, bridgeWebhook, getDashboardStats,
  getByDate, registerManual, registerMobile,
  recalcDailySummary,
};
