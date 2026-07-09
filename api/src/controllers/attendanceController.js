const { sequelize } = require('../config/database');
const { getIO, emitAttendance } = require('../socket/socketServer');
const logger = require('../config/logger');
let fireWebhooks;
try { ({ fireWebhooks } = require('../routes/webhooks')); } catch {}
let writeCheckinOut;
try { ({ writeCheckinOut } = require('../config/att2000')); } catch {}

// ─── Procesar evento de marcaje (desde Redis Pub/Sub del Bridge) ────────────
async function processAttendanceEvent(data) {
  const { employeeCode, timestamp, deviceId, deviceIp, deviceSn, type = 'unknown', raw } = data;

  try {
    // Buscar empleado por código ZKTeco
    const [[emp]] = await sequelize.query(
      'SELECT id, first_name, last_name, schedule_id FROM employees WHERE code = ? AND status = "active"',
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

    // Insertar log (INSERT IGNORE — idempotente por clave única)
    await sequelize.query(`
      INSERT IGNORE INTO attendance_logs (employee_id, device_id, timestamp, type, source, raw_data)
      VALUES (?, ?, ?, ?, 'device', ?)
    `, { replacements: [emp.id, resolvedDeviceId, ts, detectedType, JSON.stringify(raw || {})] });

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
  const date = new Intl.DateTimeFormat('sv', { timeZone: 'America/Asuncion' }).format(
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
  // Usar fecha en Paraguay para el resumen
  const date = new Intl.DateTimeFormat('sv', { timeZone: 'America/Asuncion' }).format(
    timestamp instanceof Date ? timestamp : new Date(timestamp)
  );

  const [logs] = await sequelize.query(`
    SELECT timestamp, type FROM attendance_logs
    WHERE employee_id = ? AND DATE(timestamp) = ?
    ORDER BY timestamp ASC
  `, { replacements: [employeeId, date] });

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
      await sequelize.query(`
        INSERT INTO daily_summary (employee_id, date, worked_minutes, late_minutes, status)
        VALUES (?, ?, 0, 0, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status)
      `, { replacements: [employeeId, date, fallbackStatus] });
    }
    return;
  }

  const firstIn  = logs.find(l => l.type === 'in');
  const lastOut  = logs.slice().reverse().find(l => l.type === 'out');

  let workedMinutes = 0;
  if (firstIn && lastOut) {
    const ms = new Date(lastOut.timestamp) - new Date(firstIn.timestamp);
    workedMinutes = Math.floor(ms / 60000);
  }

  // Obtener horario del empleado
  const [[emp]] = await sequelize.query(
    'SELECT s.check_in, s.tolerance_in FROM employees e JOIN schedules s ON e.schedule_id = s.id WHERE e.id = ?',
    { replacements: [employeeId] }
  );

  let lateMinutes = 0;
  let status = firstIn ? 'present' : 'absent';

  if (firstIn && emp) {
    // Construir horario previsto en Paraguay: fecha laboral + hora del turno
    const [h, m] = emp.check_in.split(':').map(Number);
    const tolerMin = emp.tolerance_in || 0;
    // scheduleTime = fecha Paraguay + hora check_in + tolerancia, en UTC
    const scheduleTime = new Date(`${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`);
    scheduleTime.setTime(scheduleTime.getTime() + tolerMin * 60 * 1000);

    const inTime = new Date(firstIn.timestamp);
    if (inTime > scheduleTime) {
      lateMinutes = Math.floor((inTime - scheduleTime) / 60000);
      status = 'late';
    }
  }

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
  ]});
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
    const [[stats]] = await sequelize.query(`
      SELECT
        COUNT(*)                                          AS total_employees,
        SUM(ds.status = 'present')                        AS present,
        SUM(ds.status = 'late')                           AS late,
        SUM(ds.status = 'absent')                         AS absent,
        SUM(ds.status = 'permission')                     AS on_permission
      FROM employees e
      LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date = ?
      WHERE e.status = 'active'
    `, { replacements: [today] });

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
      WHERE DATE(al.timestamp) = ?
      ORDER BY al.timestamp DESC
      LIMIT 20
    `, { replacements: [today] });

    res.json({ stats, recentLogs, date: today });
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
  const params = [date];

  if (dept)       { where += ' AND e.department_id = ?'; params.push(dept); }
  if (employeeId) { where += ' AND e.id = ?'; params.push(employeeId); }

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

    await sequelize.query(`
      INSERT INTO attendance_logs (employee_id, timestamp, type, source, latitude, longitude, accuracy)
      VALUES (?, ?, ?, 'mobile', ?, ?, ?)
    `, { replacements: [employeeId, ts, type, latitude, longitude, accuracy] });

    await recalcDailySummary(employeeId, ts);

    const [[emp]] = await sequelize.query(
      'SELECT first_name, last_name FROM employees WHERE id = ?',
      { replacements: [employeeId] }
    );

    emitAttendance({
      employeeId, employeeName: `${emp.first_name} ${emp.last_name}`,
      timestamp: ts.toISOString(), type, source: 'mobile', latitude, longitude
    });

    res.status(201).json({ message: `Marcaje de ${type === 'in' ? 'entrada' : 'salida'} registrado`, type, timestamp: ts });
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
