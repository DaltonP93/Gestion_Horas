/**
 * reverseSyncPreview.js — Sincronización inversa empleados → reloj (VISTA PREVIA).
 *
 * SOLO LECTURA / dry-run: compara los empleados de SisHoras con los usuarios
 * cargados en el reloj y calcula el PLAN de cambios (crear / actualizar /
 * deshabilitar / sin cambios), sin escribir NADA en el equipo.
 *
 * Prioridad para determinar el device_user_id del empleado:
 *   1) employee_device_map (vínculo explícito para ESE reloj o global)
 *   2) employee_number (legajo)
 *   3) code — sólo como sugerencia, marcada needs_confirmation.
 *
 * La ESCRITURA real al reloj (apply) NO está incluida: node-zklib no expone
 * escritura de usuarios (USER_WRQ). Requiere una integración de escritura
 * validada en campo (bridge/SDK) y se hará en una etapa posterior. Este motor
 * deja el plan listo y auditable para esa etapa.
 */
const { sequelize } = require('../config/database');
const { withZK } = require('./zktecoReader');

const norm = (v) => String(v == null ? '' : v).trim();

// Resuelve el device_user_id objetivo de cada empleado según prioridad.
function resolveTarget(emp, edmByEmp) {
  const edm = edmByEmp.get(emp.id);
  if (edm) return { userId: norm(edm), source: 'edm', needs_confirmation: false };
  if (norm(emp.employee_number)) return { userId: norm(emp.employee_number), source: 'employee_number', needs_confirmation: false };
  if (norm(emp.code)) return { userId: norm(emp.code), source: 'code', needs_confirmation: true };
  return null;
}

async function previewDeviceSync(deviceId, opts = {}) {
  const [[device]] = await sequelize.query('SELECT * FROM devices WHERE id = ?', { replacements: [deviceId] });
  if (!device) throw new Error('Reloj no encontrado');
  if (!device.ip_address || !norm(device.ip_address)) throw new Error('El reloj no tiene IP configurada');

  // 1) Usuarios actuales del reloj (lectura).
  const readTimeoutMs = opts.readTimeoutMs || 20000;
  const deviceUsers = await withZK(device, async zk => {
    const { data } = await zk.getUsers();
    return data || [];
  }, { maxAttempts: opts.attempts || 3, delayMs: 3000 });

  const deviceByUid = new Map();
  for (const u of deviceUsers) {
    const uid = norm(u.userId ?? u.uid);
    if (uid) deviceByUid.set(uid, { userId: uid, name: norm(u.name) || null, cardno: u.cardno || null, role: u.role });
  }

  // 2) Empleados (activos + inactivos) — conservamos histórico y estado.
  let hasDisablePending = true;
  const [colCheck] = await sequelize.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'device_disable_pending'`
  ).catch(() => [[{ n: 0 }]]);
  hasDisablePending = (colCheck?.[0]?.n || 0) > 0;

  const [employees] = await sequelize.query(`
    SELECT id, code, employee_number, first_name, last_name, status
           ${hasDisablePending ? ', device_disable_pending' : ''}
      FROM employees ORDER BY last_name, first_name`);

  // 3) Vínculos explícitos (employee_device_map) para este reloj o globales.
  const edmByEmp = new Map();
  try {
    const [edm] = await sequelize.query(
      `SELECT employee_id, device_user_id, device_id FROM employee_device_map
        WHERE active = 1 AND (device_id = ? OR device_id IS NULL)
        ORDER BY device_id IS NULL ASC`,   // preferir el específico del reloj
      { replacements: [device.id] }
    );
    for (const m of edm) if (!edmByEmp.has(m.employee_id)) edmByEmp.set(m.employee_id, m.device_user_id);
  } catch { /* tabla puede no existir */ }

  // 4) Calcular el plan.
  const counts = { create: 0, update: 0, disable: 0, ok: 0, skipped: 0, needs_confirmation: 0, errors: 0 };
  const actions = [];
  const matchedUids = new Set();

  for (const emp of employees) {
    const target = resolveTarget(emp, edmByEmp);
    const name = `${norm(emp.first_name)} ${norm(emp.last_name)}`.trim();
    if (!target) {
      counts.skipped++;
      actions.push({ employee_id: emp.id, code: emp.code, name, target_user_id: null, source: null, action: 'skip', reason: 'Sin device_user_id resoluble (falta legajo/código)' });
      continue;
    }
    if (target.needs_confirmation) counts.needs_confirmation++;
    const onDevice = deviceByUid.get(target.userId);
    if (onDevice) matchedUids.add(target.userId);
    const inactive = emp.status !== 'active' || (hasDisablePending && emp.device_disable_pending);

    let action, reason;
    if (inactive) {
      // Empleado inactivo: debería deshabilitarse en el reloj (pendiente de escritura).
      action = onDevice ? 'disable' : 'skip';
      reason = onDevice ? 'Empleado inactivo: deshabilitar en el reloj' : 'Inactivo y no está en el reloj';
    } else if (!onDevice) {
      action = 'create';
      reason = 'Empleado activo no presente en el reloj';
    } else if (norm(onDevice.name) !== name) {
      action = 'update';
      reason = `Nombre difiere (reloj: "${onDevice.name || ''}")`;
    } else {
      action = 'ok';
      reason = 'Coincide, sin cambios';
    }
    counts[action === 'ok' ? 'ok' : action === 'skip' ? 'skipped' : action]++;
    actions.push({
      employee_id: emp.id, code: emp.code, name,
      target_user_id: target.userId, source: target.source,
      needs_confirmation: target.needs_confirmation,
      action, reason,
      device_name: onDevice?.name || null,
    });
  }

  // 5) Usuarios del reloj sin empleado (no se tocan; sólo se informan).
  const deviceOnly = [];
  for (const [uid, u] of deviceByUid) {
    if (!matchedUids.has(uid)) deviceOnly.push({ userId: uid, name: u.name });
  }

  return {
    ok: true,
    device: { id: device.id, name: device.name },
    device_users: deviceByUid.size,
    employees: employees.length,
    counts,
    actions,
    device_only: deviceOnly,
    note: 'Vista previa (dry-run). No se escribió nada en el reloj. La escritura requiere integración validada en campo.',
  };
}

module.exports = { previewDeviceSync, resolveTarget };
