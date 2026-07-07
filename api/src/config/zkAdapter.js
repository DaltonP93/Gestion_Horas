/**
 * zkAdapter.js
 * Adaptador para la base de datos att2000 del
 * ZKTeco Fingerprint Attendance System V2011
 *
 * SCHEMA REAL att2000 (SQL Server):
 * ┌─────────────────┬─────────────────────────────────────────┐
 * │ Tabla           │ Descripción                             │
 * ├─────────────────┼─────────────────────────────────────────┤
 * │ CHECKINOUT      │ Marcajes: USERID, CHECKTIME, CHECKTYPE  │
 * │ USERINFO        │ Empleados: USERID, Badgenumber, Name    │
 * │ DEPARTMENTS     │ Deptos: DEPTID, DeptName                │
 * │ SHIFT           │ Horarios: SHIFTID, ShiftName, CheckIn1  │
 * │ Machines        │ Relojes: MachineID, IPAddress           │
 * │ HOLIDAYS        │ Días festivos                           │
 * └─────────────────┴─────────────────────────────────────────┘
 */

const { queryAtt2000, getTableColumns, pickCol } = require('./att2000');
const { sequelize }    = require('./database');
const logger           = require('./logger');

// ─── CHECKINOUT ──────────────────────────────────────────────────
// Columnas reales:
//   USERID      int          → código del empleado en el reloj
//   CHECKTIME   datetime     → fecha y hora del marcaje
//   CHECKTYPE   varchar(1)   → 'I'=entrada, 'O'=salida (o null)
//   VERIFYCODE  int          → 0=huella, 1=pin, 4=tarjeta, 15=cara
//   SENSORID    int          → ID del reloj
//   WorkCode    varchar(10)

async function fetchCheckInOut({ dateFrom, dateTo, limit = 5000 } = {}) {
  // Parametrizar entradas del usuario para evitar inyección SQL de 2º grado
  // sobre la BD att2000. Los nombres de columna se siguen resolviendo por
  // lista blanca vía pickCol(); solo valores viajan como parámetros.
  const params = {};
  let where = '1=1';
  if (dateFrom) { where += ' AND CHECKTIME >= @dateFrom'; params.dateFrom = new Date(dateFrom); }
  if (dateTo)   { where += ' AND CHECKTIME <= @dateTo';   params.dateTo   = new Date(dateTo); }

  // Sanear limit a entero positivo acotado (SQL Server admite TOP (@n))
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 200000);
  params.limit = safeLimit;

  const chkCols  = await getTableColumns('CHECKINOUT');
  const userCols = await getTableColumns('USERINFO');

  const rows = await queryAtt2000(`
    SELECT TOP (@limit)
      ${pickCol(chkCols,  'USERID',     { prefix: 'c.' })},
      ${pickCol(chkCols,  'CHECKTIME',  { prefix: 'c.' })},
      ${pickCol(chkCols,  'CHECKTYPE',  { prefix: 'c.' })},
      ${pickCol(chkCols,  'VERIFYCODE', { prefix: 'c.' })},
      ${pickCol(chkCols,  'SENSORID',   { prefix: 'c.' })},
      ${pickCol(chkCols,  'WorkCode',   { prefix: 'c.' })},
      ${pickCol(userCols, 'Badgenumber',{ prefix: 'u.' })},
      ${pickCol(userCols, 'Name',       { prefix: 'u.', alias: 'EmployeeName' })},
      ${pickCol(userCols, 'DefaultDeptID', { prefix: 'u.' })}
    FROM CHECKINOUT c
    LEFT JOIN USERINFO u ON c.USERID = u.USERID
    WHERE ${where}
    ORDER BY c.CHECKTIME DESC
  `, params);
  return rows;
}

// ─── USERINFO ─────────────────────────────────────────────────────
// Columnas reales:
//   USERID          int
//   Badgenumber     varchar(24)  → número de empleado
//   Name            varchar(24)  → nombre completo
//   DefaultDeptID   int
//   HireDay         varchar(10)
//   CardNo          varchar(20)
//   VerifyMode      int

async function fetchUserInfo() {
  const userCols = await getTableColumns('USERINFO');
  const deptCols = await getTableColumns('DEPARTMENTS');
  return queryAtt2000(`
    SELECT
      ${pickCol(userCols, 'USERID',        { prefix: 'u.' })},
      ${pickCol(userCols, 'Badgenumber',   { prefix: 'u.' })},
      ${pickCol(userCols, 'Name',          { prefix: 'u.' })},
      ${pickCol(userCols, 'DefaultDeptID', { prefix: 'u.' })},
      ${pickCol(userCols, 'HireDay',       { prefix: 'u.' })},
      ${pickCol(userCols, 'CardNo',        { prefix: 'u.' })},
      ${pickCol(deptCols, 'DeptName',      { prefix: 'd.' })}
    FROM USERINFO u
    LEFT JOIN DEPARTMENTS d ON u.DefaultDeptID = d.DEPTID
    ORDER BY u.USERID
  `);
}

// ─── DEPARTMENTS ─────────────────────────────────────────────────
async function fetchDepartments() {
  const cols = await getTableColumns('DEPARTMENTS');
  return queryAtt2000(`
    SELECT
      ${pickCol(cols, 'DEPTID')},
      ${pickCol(cols, 'DeptName')},
      ${pickCol(cols, 'ParentDeptID')}
    FROM DEPARTMENTS
    ORDER BY DeptName
  `);
}

// ─── SHIFT (Horarios) ─────────────────────────────────────────────
// Columnas típicas:
//   SHIFTID, ShiftName, CheckIn1, CheckOut1, Late, EarlyLeave
async function fetchShifts() {
  return queryAtt2000(`
    SELECT
      SHIFTID, ShiftName,
      CheckIn1, CheckOut1,
      CheckIn2, CheckOut2,
      Late, EarlyLeave, OT
    FROM SHIFT
    ORDER BY ShiftName
  `);
}

// ─── Machines (Relojes) ───────────────────────────────────────────
async function fetchMachines() {
  const cols = await getTableColumns('Machines');
  return queryAtt2000(`
    SELECT
      ${pickCol(cols, 'MachineID')},
      ${pickCol(cols, 'MachineAlias')},
      ${pickCol(cols, 'IPAddress')},
      ${pickCol(cols, 'Port')},
      ${pickCol(cols, 'Status')}
    FROM Machines
  `);
}

// ─── HOLIDAYS ────────────────────────────────────────────────────
async function fetchHolidays() {
  return queryAtt2000(`
    SELECT HolidayID, HolidayName, HolidayDate
    FROM HOLIDAYS
    ORDER BY HolidayDate
  `).catch(() => []); // no falla si no existe
}

// =================================================================
// SINCRONIZACIÓN: att2000 → nuevo sistema MySQL
// =================================================================

// Importar departamentos
async function syncDepartments() {
  const depts = await fetchDepartments();
  let synced = 0;
  for (const d of depts) {
    await sequelize.query(`
      INSERT INTO departments (id, name)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name)
    `, { replacements: [d.DEPTID, d.DeptName] });
    synced++;
  }
  logger.info(`Sync departamentos: ${synced}`);
  return { synced };
}

// ¿El valor parece un nombre humano real?
// Rechaza vacíos, cadenas iguales al USERID, puramente numéricas o con
// caracteres basura típicos de registros ZK sin nombre ("<<<<", "---", etc.)
function looksLikeRealName(raw, userId) {
  if (!raw) return false;
  const s = String(raw).trim();
  if (!s) return false;
  if (s === String(userId)) return false;
  // Sin ninguna letra unicode → basura (dígitos, símbolos, "<<<<", "1001")
  if (!/\p{L}/u.test(s)) return false;
  // Menos de 2 caracteres alfabéticos → basura
  const letters = s.match(/\p{L}/gu) || [];
  if (letters.length < 2) return false;
  return true;
}

// Importar empleados (USERINFO → employees)
async function syncEmployees() {
  const users = await fetchUserInfo();
  let synced = 0, errors = 0;

  for (const u of users) {
    // Name en att2000 viene como "Apellido,Nombre [Segundo...]" (coma separador).
    // Si no hay coma, asumimos "Nombre Apellido" por espacio.
    // Si Name es basura (vacío, igual a USERID, numérico, "<<<<"), dejar en blanco.
    const cleanName = looksLikeRealName(u.Name, u.USERID) ? String(u.Name).trim() : '';
    let firstName = '', lastName = '';
    if (cleanName) {
      if (cleanName.includes(',')) {
        // Formato ZKTeco: "Apellido,Nombre Segundo..."
        const [last, rest] = cleanName.split(',', 2).map(s => s.trim());
        lastName  = last || '';
        firstName = rest || '';
      } else {
        // Sin coma: "Nombre Apellido" por espacio
        const parts = cleanName.split(/\s+/);
        firstName = parts[0] || '';
        lastName  = parts.slice(1).join(' ') || '';
      }
    }

    try {
      await sequelize.query(`
        INSERT INTO employees (code, employee_number, first_name, last_name, department_id, hire_date)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          -- Solo sobreescribir si el Name nuevo no está vacío.
          -- Evita borrar nombres corregidos a mano cuando att2000 devuelve basura.
          first_name    = COALESCE(NULLIF(VALUES(first_name), ''), first_name),
          last_name     = COALESCE(NULLIF(VALUES(last_name),  ''), last_name),
          employee_number = COALESCE(NULLIF(VALUES(employee_number), ''), employee_number),
          department_id = COALESCE(VALUES(department_id), department_id)
      `, { replacements: [
        String(u.USERID),           // code = USERID del reloj
        u.Badgenumber || null,       // número de empleado
        firstName,
        lastName,
        u.DefaultDeptID || null,
        u.HireDay ? new Date(u.HireDay) : null,
      ]});
      synced++;
    } catch (err) {
      logger.error(`Error sync empleado ${u.USERID}:`, err.message);
      errors++;
    }
  }
  logger.info(`Sync empleados: ${synced} OK, ${errors} errores`);
  return { synced, errors, total: users.length };
}

// Importar marcajes históricos (CHECKINOUT → attendance_logs)
async function syncAttendance({ dateFrom, dateTo, limit = 10000 } = {}) {
  const records = await fetchCheckInOut({ dateFrom, dateTo, limit });
  let imported = 0, skipped = 0, notFound = 0;

  for (const r of records) {
    try {
      // Buscar empleado en el nuevo sistema por código USERID
      const [[emp]] = await sequelize.query(
        'SELECT id FROM employees WHERE code = ?',
        { replacements: [String(r.USERID)] }
      );

      if (!emp) { notFound++; continue; }

      // Mapear CHECKTYPE: 'I'=entrada, 'O'=salida, null=detectar por orden
      let type = 'unknown';
      if (r.CHECKTYPE === 'I' || r.CHECKTYPE === 'i') type = 'in';
      else if (r.CHECKTYPE === 'O' || r.CHECKTYPE === 'o') type = 'out';

      // Buscar dispositivo por sensor_id (MachineNo en att2000) con fallback al id MySQL
      const sid = r.SENSORID || 0;
      const [[device]] = await sequelize.query(
        'SELECT id FROM devices WHERE sensor_id = ? OR id = ? ORDER BY (sensor_id = ?) DESC LIMIT 1',
        { replacements: [sid, sid, sid] }
      ).catch(() => [[]]);

      const [result] = await sequelize.query(`
        INSERT IGNORE INTO attendance_logs
          (employee_id, device_id, timestamp, type, source, raw_data)
        VALUES (?, ?, ?, ?, 'device', ?)
      `, { replacements: [
        emp.id,
        device?.id || null,
        new Date(r.CHECKTIME),
        type,
        JSON.stringify({
          userid: r.USERID,
          checktype: r.CHECKTYPE,
          verifycode: r.VERIFYCODE,
          sensorid: r.SENSORID
        })
      ]});

      if (result.affectedRows > 0) imported++;
      else skipped++;

    } catch (err) {
      logger.error(`Error importando marcaje ${r.USERID} ${r.CHECKTIME}:`, err.message);
      skipped++;
    }
  }

  logger.info(`Sync asistencia: ${imported} importados, ${skipped} duplicados, ${notFound} sin empleado`);
  return { imported, skipped, notFound, total: records.length };
}

// Importar relojes desde Machines
async function syncMachines() {
  const machines = await fetchMachines();
  let synced = 0;
  for (const m of machines) {
    await sequelize.query(`
      INSERT INTO devices (id, name, ip_address, port)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), ip_address = VALUES(ip_address)
    `, { replacements: [
      m.MachineID,
      m.MachineAlias || `Reloj ${m.MachineID}`,
      m.IPAddress || '',
      m.Port || 4370,
    ]});
    synced++;
  }
  logger.info(`Sync relojes: ${synced}`);
  return { synced };
}

// Importar días festivos
async function syncHolidays() {
  const holidays = await fetchHolidays();
  let synced = 0;
  for (const h of holidays) {
    await sequelize.query(`
      INSERT IGNORE INTO holidays (name, date, type)
      VALUES (?, ?, 'company')
    `, { replacements: [h.HolidayName, new Date(h.HolidayDate)] });
    synced++;
  }
  logger.info(`Sync festivos: ${synced}`);
  return { synced };
}

// Sincronización completa (en orden correcto)
async function fullSync({ dateFrom, dateTo } = {}) {
  logger.info('🔄 Iniciando sincronización completa att2000 → nuevo sistema...');
  const result = {
    departments: await syncDepartments(),
    machines:    await syncMachines(),
    employees:   await syncEmployees(),
    holidays:    await syncHolidays(),
    attendance:  await syncAttendance({ dateFrom, dateTo, limit: 50000 }),
  };
  logger.info('✅ Sincronización completa terminada');
  return result;
}

module.exports = {
  fetchCheckInOut,
  fetchUserInfo,
  fetchDepartments,
  fetchShifts,
  fetchMachines,
  fetchHolidays,
  syncDepartments,
  syncEmployees,
  syncAttendance,
  syncMachines,
  syncHolidays,
  fullSync,
};
