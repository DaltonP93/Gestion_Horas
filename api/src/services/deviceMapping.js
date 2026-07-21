/**
 * deviceMapping.js — Vinculación deviceUserId ↔ empleado + reproceso de marcas.
 *
 * Lógica compartida por las rutas de relojes y de empleados (perfil →
 * Biometría/Relojes). No pierde marcaciones: reprocesa raw_device_punches
 * 'unmapped' y crea attendance_logs cuando encuentra empleado.
 */
const { sequelize } = require('../config/database');
const { buildEmployeeMatcher, resolveTypes, pyDateStr, pyDateTimeStr } = require('./zktecoReader');

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// Reprocesa raw_device_punches 'unmapped' (por rango o por deviceUserId): mapea,
// crea attendance_logs y recalcula daily_summary. Devuelve el resumen.
async function reprocessUnmapped({ from = null, to = null, deviceUserId = null, deviceId = null } = {}) {
  const where = ["mapping_status = 'unmapped'"];
  const repl = [];
  if (isDate(from)) { where.push('record_time_py >= ?'); repl.push(`${from} 00:00:00`); }
  if (isDate(to))   { where.push('record_time_py <= ?'); repl.push(`${to} 23:59:59`); }
  if (deviceUserId) { where.push('device_user_id = ?'); repl.push(deviceUserId); }
  if (deviceId != null) { where.push('device_id = ?'); repl.push(deviceId); }

  const [rows] = await sequelize.query(
    `SELECT id, device_id, device_user_id, record_time FROM raw_device_punches
     WHERE ${where.join(' AND ')} ORDER BY record_time`,
    { replacements: repl }
  );
  const result = { candidates: rows.length, mapped: 0, still_unmapped: 0, duplicate: 0, errors: 0 };
  if (!rows.length) return result;

  const matcher = await buildEmployeeMatcher();
  const mappable = [];
  for (const r of rows) {
    const empId = matcher.resolve(r.device_id, r.device_user_id);
    if (!empId) { result.still_unmapped++; continue; }
    mappable.push({ rawId: r.id, empId, device_id: r.device_id, ts: new Date(r.record_time) });
  }
  if (!mappable.length) return result;

  resolveTypes(mappable);
  const dates = new Set();
  for (const p of mappable) {
    try {
      const tsStr = pyDateTimeStr(p.ts);
      dates.add(pyDateStr(p.ts));
      const [dup] = await sequelize.query(
        `SELECT id FROM attendance_logs WHERE employee_id=? AND DATE_FORMAT(\`timestamp\`,'%Y-%m-%d %H:%i:%s')=? LIMIT 1`,
        { replacements: [p.empId, tsStr] }
      );
      let logId;
      if (dup.length) { logId = dup[0].id; result.duplicate++; }
      else {
        const [ins] = await sequelize.query(
          `INSERT IGNORE INTO attendance_logs (employee_id, device_id, \`timestamp\`, type, source) VALUES (?,?,?,?, 'zkteco_direct')`,
          { replacements: [p.empId, p.device_id, p.ts, p.type] }
        );
        if (ins?.insertId) { logId = ins.insertId; result.mapped++; } else { result.duplicate++; }
      }
      await sequelize.query(
        `UPDATE raw_device_punches SET mapping_status='mapped', employee_id=?, imported_attendance_log_id=? WHERE id=?`,
        { replacements: [p.empId, logId || null, p.rawId] }
      );
    } catch { result.errors++; }
  }

  if (dates.size) {
    const { bulkRecalcDailySummary, materializeAbsents } = require('./scheduler');
    for (const d of [...dates].sort()) {
      try { await bulkRecalcDailySummary(d); await materializeAbsents(d); } catch { /* seguir */ }
    }
  }
  result.dates = [...dates].sort();
  return result;
}

// Vincula un deviceUserId a un empleado (upsert idempotente en
// employee_device_map) y reprocesa sus marcas crudas. deviceId puede ser null
// (mapeo global). Devuelve el resumen del reproceso.
async function linkEmployeeDevice({ employeeId, deviceUserId, deviceId = null, createdBy = null }) {
  const uid = String(deviceUserId || '').trim();
  if (!employeeId || !uid) throw new Error('employee_id y device_user_id son obligatorios.');
  await sequelize.query(
    `INSERT INTO employee_device_map (employee_id, device_id, device_user_id, active, created_by)
     VALUES (?,?,?,1,?)
     ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), active = 1, updated_at = NOW()`,
    { replacements: [employeeId, deviceId, uid, createdBy] }
  );
  return reprocessUnmapped({ deviceUserId: uid, deviceId });
}

// Desactiva un vínculo (active=0). NO borra attendance_logs históricos.
async function unlinkEmployeeDevice({ mapId, employeeId }) {
  const [[row]] = await sequelize.query(
    'SELECT id, employee_id, device_user_id FROM employee_device_map WHERE id=?',
    { replacements: [mapId] }
  );
  if (!row) throw new Error('Vínculo no encontrado.');
  if (employeeId != null && Number(row.employee_id) !== Number(employeeId)) {
    throw new Error('El vínculo no pertenece a ese empleado.');
  }
  await sequelize.query('UPDATE employee_device_map SET active=0, updated_at=NOW() WHERE id=?', { replacements: [mapId] });
  return { unlinked: true, device_user_id: row.device_user_id };
}

module.exports = { reprocessUnmapped, linkEmployeeDevice, unlinkEmployeeDevice };
