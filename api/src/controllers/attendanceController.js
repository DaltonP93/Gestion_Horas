const { sequelize } = require('../config/database');
const { getIO, emitAttendance } = require('../socket/socketServer');
const logger = require('../config/logger');
const { withDayRecalcLock, dayBounds } = require('../services/recalcLock');
const { dbSecondsOfDay, dbDateISO } = require('../utils/dbTime');
const calc = require('../services/dailySummaryCalc');
const { LINKED_SQL } = require('../services/rawPunchStats');
const { getVisibleDepartmentIds, applyDepartmentScope } = require('../services/departmentScope');
const { normalizeAttendanceTimestampForDb, attendanceDisplayInstant } = require('../utils/attendanceTime');
const engine = require('../services/workdayEngine');
const workdaySummary = require('../services/workdaySummaryService');
const lateAlert = require('../services/lateAlertService');
let fireWebhooks;
try { ({ fireWebhooks } = require('../routes/webhooks')); } catch {}

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

    // Hora de pared a persistir. Una marca naive del dispositivo se guarda con
    // sus componentes exactos (sin reinterpretar como UTC); un instante real se
    // convierte a la hora de pared de la institución. `ts` (Date) se conserva
    // sólo para trazas/emisión (display), NO para la persistencia.
    //
    // El instante para display/audit/socket/logs sale de attendanceDisplayInstant,
    // NO de `new Date(timestamp)`: un naive del reloj ("2026-08-27 18:30:15")
    // parseado con `new Date` usa la TZ del proceso Node y da un instante distinto
    // por servidor, así que se invierte el wall-clock interpretándolo como hora de
    // Asunción (tzdata histórica). Un input YA inequívoco (Date o ISO con zona)
    // conserva su instante original: reinvertirlo desde el wall-clock perdería la
    // ocurrencia correcta en la hora repetida de un cambio de zona.
    const tsDb = normalizeAttendanceTimestampForDb(timestamp);
    const ts = attendanceDisplayInstant(timestamp, tsDb);
    // El tipo explícito confiable se conserva; si viene `unknown` se resuelve
    // por CONTEXTO de jornada (secuencia real de marcas), nunca por paridad del
    // día civil, que se reinicia a medianoche y rompe los turnos nocturnos.
    const detectedType = type !== 'unknown' ? type : await resolveMarkType(emp.id, tsDb);

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
    `, { replacements: [emp.id, resolvedDeviceId, tsDb, detectedType, JSON.stringify(raw || {})] });

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

    // att2000 es READ-ONLY: no se replica el marcaje hacia CHECKINOUT. La
    // capacidad de escritura fue eliminada del conector a propósito.

    // Recalcular resumen diario a partir de la hora de pared persistida.
    await recalcDailySummary(emp.id, tsDb);

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

    // Disparar webhooks a sistemas externos (Oracle APEX, ERP, etc.). Sólo con
    // un tipo resuelto: una marca 'unknown' no es ni checkin ni checkout, así que
    // mapearla a 'attendance.checkout' publicaría una salida que nunca ocurrió.
    // El evento de socket ya la refleja como 'unknown'; el webhook la omite hasta
    // que su tipo se determine.
    if (fireWebhooks && (detectedType === 'in' || detectedType === 'out')) {
      const webhookEvent = detectedType === 'in' ? 'attendance.checkin' : 'attendance.checkout';
      fireWebhooks(webhookEvent, event).catch(() => {});
    }

    // Verificar retardos y emitir alerta. El atraso lo determina el MOTOR con la
    // configuración efectiva (no employees.schedule_id actual + setHours): sin
    // config confiable o con conflicto de turnera, NO se inventa una tardanza.
    if (detectedType === 'in') {
      await lateAlert.checkAndAlertLate(emp, emp.id, tsDb, io);
    }

    logger.info(`Marcaje: ${emp.first_name} ${emp.last_name} - ${detectedType} - ${ts.toISOString()}`);
  } catch (err) {
    logger.error('Error en processAttendanceEvent:', err);
    throw err;
  }
}

/**
 * Resuelve el tipo (in/out) de una marca SIN tipo confiable, por CONTEXTO de
 * jornada.
 *
 * El método viejo contaba `COUNT(*) WHERE DATE(timestamp)=fecha` y alternaba por
 * paridad. Eso se reinicia a medianoche: en un turno nocturno (21:32 IN … 00:05
 * OUT) el contador vuelve a cero al cambiar de día civil y el OUT de madrugada
 * se infería como IN. También fallaba ante duplicados y turnos partidos.
 *
 * Acá se mira la SECUENCIA real de marcas anteriores, en una ventana de jornada
 * (no un día civil), y se decide por el estado de sesión.
 *
 * NO inventa in/out sin evidencia: esta función SÓLO corre cuando la fuente no
 * trae tipo, y devuelve 'unknown' cuando el contexto no alcanza para decidir sin
 * ambigüedad. WorkdayEngine sabe tratar 'unknown' aguas abajo, así que preservar
 * la incertidumbre es preferible a fabricar una entrada que nadie fichó. Las
 * reglas:
 *
 *   A) tipo explícito y confiable        → lo resuelve el CALLER, no llega acá;
 *   B) unknown + contexto suficiente y no ambiguo → se infiere in/out;
 *   C) unknown SIN contexto suficiente   → 'unknown';
 *   D) secuencia ambigua                 → 'unknown'.
 *
 * Casos que SÍ se infieren (B):
 *   · última explícita ENTRADA con sesión aún abierta (el hueco no supera una
 *     jornada) → esta marca es SALIDA;
 *   · última explícita SALIDA → esta marca abre sesión → ENTRADA.
 * Todo lo demás —sin marcas previas, sólo unknown previos, o una entrada vieja
 * cuya sesión ya cerró por el hueco— es ambiguo y se conserva 'unknown'.
 */
async function resolveMarkType(employeeId, wallClockTs) {
  const at = engine.toWall(wallClockTs);
  if (!at) return 'unknown';   // sin hora legible: no hay evidencia

  // Ventana hacia atrás suficiente para cubrir una jornada; el límite superior
  // es EXCLUSIVO en esta marca (miramos sólo lo previo).
  const desde = engine.absToDateTime(at.abs - engine.DEFAULTS.historicalMaxWorkdaySpanMinutes * 60);
  const hasta = engine.absToDateTime(at.abs);
  const [rows] = await sequelize.query(`
    SELECT DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp, al.type
    FROM attendance_logs al
    WHERE al.employee_id = ? AND al.timestamp >= ? AND al.timestamp < ?
    ORDER BY al.timestamp, al.id
  `, { replacements: [employeeId, desde, hasta] });

  if (!rows.length) return 'unknown';   // sin marcas previas: no se afirma in/out

  // RÁFAGA / DUPLICADO PRIMERO: si la marca más reciente cae dentro de la ventana
  // de dedupe, esta marca es una repetición del reloj y CONSERVA su tipo, no
  // alterna. Si no, un 08:00:00 in + 08:00:30 (unknown) se tiparía out, y como el
  // dedupe nuevo no colapsa tipos opuestos, quedaría un tramo de 30 s y la salida
  // real de las 17:00 se infiere in. Detectarlo antes de alternar lo evita.
  const previa = rows[rows.length - 1];
  if (previa && (previa.type === 'in' || previa.type === 'out')) {
    const wPrev = engine.toWall(previa.timestamp);
    if (wPrev && (at.abs - wPrev.abs) <= engine.DEFAULTS.duplicateWindowSeconds) {
      return previa.type;
    }
  }

  // Última marca con tipo conocido (los duplicados y desconocidos no cambian el
  // estado de sesión).
  let ultima = null;
  for (const r of rows) {
    if (r.type === 'in' || r.type === 'out') ultima = r;
  }
  if (!ultima) return 'unknown';   // sólo hay unknown previos: sin estado de sesión

  if (ultima.type === 'in') {
    // ¿Sigue abierta la sesión? Si el hueco supera el máximo de una jornada, esa
    // entrada ya pertenece a otra jornada: no se puede afirmar si esta marca es
    // la SALIDA tardía que faltó o una ENTRADA nueva → ambiguo → 'unknown'.
    const w = engine.toWall(ultima.timestamp);
    const gapMin = (at.abs - w.abs) / 60;
    return gapMin <= engine.DEFAULTS.historicalMaxWorkdaySpanMinutes ? 'out' : 'unknown';
  }
  // Última fue SALIDA → esta marca abre una sesión nueva → ENTRADA.
  return 'in';
}

/**
 * Recalcular resumen diario del empleado tras una marca.
 *
 * Punto de conmutación entre dos caminos:
 *   - MOTOR (nuevo): un solo cálculo, el mismo que Marcadas. Recalcula las
 *     work_dates realmente afectadas (incluida la anterior, para el turno
 *     nocturno). Se activa con WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED=true.
 *   - LEGACY (rollback): el cálculo propio anterior, AISLADO como legacy. Es el
 *     default por ahora, para no cambiar producción antes del rollout.
 *
 * El legacy queda disponible sólo como rollback; la matemática NUEVA vive
 * exclusivamente en el motor/materializador, no duplicada acá.
 */
async function recalcDailySummary(employeeId, timestamp) {
  // El escritor hacia adelante del motor exige AMBOS cerrojos (env kill-switch
  // Y setting de BD fase_e_forward_enabled). Con cualquiera en OFF se conserva
  // el camino LEGACY — fail-closed y comportamiento actual intacto.
  if (await workdaySummary.isEngineForwardWriteEnabled()) {
    await workdaySummary.resolveSummary(employeeId, timestamp, { apply: true });
    return;
  }
  await legacyRecalcDailySummary(employeeId, timestamp);
}

// ─────────────────────────────────────────────────────────────────────
// LEGACY (rollback). NO agregar matemática nueva acá: el cálculo del motor
// vive en workdaySummaryService + dailySummaryEngine. Esta función se conserva
// sólo para poder volver atrás mientras el flag está en OFF.
// ─────────────────────────────────────────────────────────────────────
async function legacyRecalcDailySummary(employeeId, timestamp) {
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

  const { start, next } = dayBounds(date);

  // ¿Es feriado o fin de semana? Config estable (no compite con los marcajes),
  // así que se resuelve fuera del lock.
  const [[holiday]] = await sequelize.query(
    'SELECT id, name FROM holidays WHERE date = ? AND active = 1 LIMIT 1',
    { replacements: [date] }
  );
  const dow = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Dom, 6=Sáb
  const isWeekend = (dow === 0 || dow === 6);

  // La LECTURA del día y su ESCRITURA van JUNTAS bajo el mismo lock. Si el día se
  // leyera fuera del lock (como antes), un recálculo viejo —que leyó ANTES de que
  // se insertara un `in` explícito— podría tomar el lock después y pisar con
  // VALUES() el first_in/last_out válido que escribió un recálculo nuevo. Como el
  // upsert reemplaza (no COALESCE), esa carrera borraría datos buenos. Releer bajo
  // el lock hace autoritativo lo que se persiste. El reintento por deadlock
  // reejecuta este bloque: relee y reescribe de forma consistente, sin duplicar
  // (upsert idempotente por ON DUPLICATE KEY).
  await withDayRecalcLock(date, async (t) => {
    // Rango SARGABLE [inicio, díaSiguiente): usa el índice idx_ts/idx_emp_ts y
    // acota los locks de rango (a diferencia de DATE(timestamp), que fuerza scan
    // del índice funcional y amplía los next-key locks → deadlocks).
    const [logs] = await sequelize.query(`
      SELECT timestamp, type FROM attendance_logs
      WHERE employee_id = ? AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC
    `, { replacements: [employeeId, start, next], transaction: t });

    if (!logs.length) {
      // Sin marcajes: si es feriado o fin de semana, registrar como tal (no absent).
      if (holiday || isWeekend) {
        const fallbackStatus = holiday ? 'holiday' : 'weekend';
        await sequelize.query(`
          INSERT INTO daily_summary (employee_id, date, worked_minutes, late_minutes, status)
          VALUES (?, ?, 0, 0, ?)
          ON DUPLICATE KEY UPDATE status = VALUES(status)
        `, { replacements: [employeeId, date, fallbackStatus], transaction: t });
      }
      return;
    }

    const firstIn  = logs.find(l => l.type === 'in');
    const lastOut  = logs.slice().reverse().find(l => l.type === 'out');

    // Los BORDES y la PERMANENCIA salen EXCLUSIVAMENTE de marcas explícitas. Un
    // 'unknown' prueba PRESENCIA (la persona fichó), pero no que sea entrada ni
    // salida: no se puede anclar first_in/last_out ni computar worked_minutes
    // desde él sin inventar in/out. Por eso:
    //   · first_in / last_out = SÓLO el 'in' / 'out' explícito, o NULL;
    //   · worked_minutes = permanencia entre in y out explícitos (0 si falta uno);
    //   · late = sólo con 'in' explícito.
    // El arreglo del falso 'absent' (una jornada de sólo-unknown quedaba como
    // ausencia pese a la actividad) es SÓLO en el ESTADO, no en los bordes: un día
    // con actividad no es ausencia, pero tampoco fabrica una jornada de 9 h desde
    // dos marcas sin tipo. Corrige únicamente el camino LEGACY (flag OFF).

    // Todo el cálculo se hace en HORA DE PARED. Un turno se define en hora de
    // pared ("entra 07:00") y el marcaje se guarda en hora de pared: compararlos
    // no necesita zona horaria. La versión anterior construía el horario previsto
    // con offset fijo `-03:00`, que no representa a America/Asuncion históricamente
    // —Paraguay estuvo en UTC-4 hasta el 2024-10-06—, así que en fechas de invierno
    // anteriores el atraso salía corrido una hora aunque first_in fuese exacto.
    const inSec  = firstIn ? dbSecondsOfDay(firstIn.timestamp)  : null;
    const outSec = lastOut ? dbSecondsOfDay(lastOut.timestamp) : null;

    const workedMinutes = calc.workedMinutes({ firstInSeconds: inSec, lastOutSeconds: outSec });

    // Horario del empleado (config) para el cálculo de atraso; sólo hace falta con
    // un `in` explícito.
    let lateMinutes = 0;
    if (firstIn) {
      const [[emp]] = await sequelize.query(
        'SELECT s.check_in, s.tolerance_in FROM employees e JOIN schedules s ON e.schedule_id = s.id WHERE e.id = ?',
        { replacements: [employeeId], transaction: t }
      );
      if (emp) {
        lateMinutes = calc.lateMinutes({
          firstInSeconds: inSec,
          checkInSeconds: calc.scheduleSeconds(emp.check_in),
          toleranceMin: emp.tolerance_in || 0,
        });
      }
    }

    // Con `in` explícito, el estado sale del cálculo (present/late). Sin `in` pero
    // con actividad (cualquier marca, incluidas 'unknown' o una salida suelta), el
    // día es PRESENTE: la persona fichó, no está ausente. No se inventan ni bordes
    // ni permanencia por eso. (Sin marcas ya se resolvió arriba: feriado/finde o
    // return.)
    const status = firstIn
      ? calc.dayStatus({ hasFirstIn: true, late: lateMinutes })
      : 'present';

    await sequelize.query(`
      INSERT INTO daily_summary (employee_id, date, first_in, last_out, worked_minutes, late_minutes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        -- first_in se REEMPLAZA (como last_out), no se conserva con COALESCE: el
        -- recalculo relee TODO el dia bajo este lock, asi que VALUES(first_in) es
        -- autoritativo. Si el dia ya no tiene una entrada explicita,
        -- VALUES(first_in) es NULL y debe BORRAR un first_in previo, incluido uno
        -- fabricado por el legacy viejo desde una marca sin tipo; conservarlo
        -- dejaria un first_in bogus con worked 0 o junto a un last_out real.
        first_in        = VALUES(first_in),
        last_out        = VALUES(last_out),
        worked_minutes  = VALUES(worked_minutes),
        late_minutes    = VALUES(late_minutes),
        status          = VALUES(status)
    `, { replacements: [
      employeeId, date,
      firstIn  ? firstIn.timestamp  : null,
      lastOut  ? lastOut.timestamp : null,
      workedMinutes, lateMinutes, status
    ], transaction: t });
  }, { label: `recalcEmp:${date}:${employeeId}` });
}

// La alerta de atraso vive ahora en services/lateAlertService.js: la tardanza
// la determina el MOTOR con la configuración efectiva, no un cálculo propio con
// employees.schedule_id actual + setHours.

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
    // Hora de pared a persistir: si el cliente manda naive se guarda tal cual;
    // si manda un ISO con zona se convierte a hora de pared de la institución.
    const tsDb = normalizeAttendanceTimestampForDb(timestamp);
    await sequelize.query(
      'INSERT INTO attendance_logs (employee_id, timestamp, type, source) VALUES (?, ?, ?, "manual")',
      { replacements: [employeeId, tsDb, type] }
    );
    await recalcDailySummary(employeeId, tsDb);

    const [[emp]] = await sequelize.query(
      'SELECT first_name, last_name FROM employees WHERE id = ?',
      { replacements: [employeeId] }
    );

    emitAttendance({
      employeeId, employeeName: `${emp.first_name} ${emp.last_name}`,
      timestamp: tsDb, type, source: 'manual'
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
    // Marcaje móvil = INSTANTE real del sistema (new Date()): se convierte a la
    // hora de pared de la institución para persistir el DATETIME.
    const tsDb = normalizeAttendanceTimestampForDb(new Date());
    const type = await resolveMarkType(employeeId, tsDb);

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
    `, { replacements: [employeeId, tsDb, type, latitude, longitude, accuracy, gf.status, gf.distance] });

    await recalcDailySummary(employeeId, tsDb);

    const [[emp]] = await sequelize.query(
      'SELECT first_name, last_name FROM employees WHERE id = ?',
      { replacements: [employeeId] }
    );

    emitAttendance({
      employeeId, employeeName: `${emp.first_name} ${emp.last_name}`,
      timestamp: tsDb, type, source: 'mobile', latitude, longitude
    });

    // El mensaje refleja el tipo sin inventarlo: una marca 'unknown' (sin
    // contexto suficiente) no se anuncia como entrada ni salida.
    const msg = type === 'in' ? 'Marcaje de entrada registrado'
      : type === 'out' ? 'Marcaje de salida registrado'
      : 'Marcaje registrado';
    res.status(201).json({
      message: msg,
      type, timestamp: tsDb,
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
  recalcDailySummary, legacyRecalcDailySummary, resolveMarkType,
};
