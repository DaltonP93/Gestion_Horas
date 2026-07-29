const router = require('express').Router();
const Joi = require('joi');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const {
  getAll, getById, create, update, deactivate, reactivate, getInactiveMarks, getAttendanceHistory
} = require('../controllers/employeeController');
const { capsForRole, classifyField } = require('../services/employeeCaps');
const { validate: validateField, auditValueOf, SENSITIVE_VALUE } = require('../services/employeeFieldValidation');
const audit = require('../services/audit');

// DTO de alta de empleado: campos requeridos + formatos válidos.
const createEmployeeSchema = Joi.object({
  code:            Joi.string().trim().max(20).required(),
  first_name:      Joi.string().trim().max(80).required(),
  last_name:       Joi.string().trim().max(80).required(),
  email:           Joi.string().email().allow(null, ''),
  phone:           Joi.string().max(30).allow(null, ''),
  employee_number: Joi.string().max(40).allow(null, ''),
  department_id:   Joi.number().integer().positive().allow(null),
  schedule_id:     Joi.number().integer().positive().allow(null),
  position:        Joi.string().max(120).allow(null, ''),
  hire_date:       Joi.date().iso().allow(null, ''),
  status:          Joi.string().valid('active', 'inactive').default('active'),
}).unknown(true);

router.use(authenticate);

// ─── Guards de sub-acciones (PR 1: edición de ficha) ────────────
// Complementan al catálogo plano `requirePermission` con capacidades
// diferenciadas por campo. El catálogo global (submódulos) llega en PR 3.
function guardLegalOnPut(req, res, next) {
  const caps = capsForRole(req.user?.role);
  const legalIn = Object.keys(req.body || {}).some(k => classifyField(k) === 'legal');
  const personalIn = Object.keys(req.body || {}).some(k => classifyField(k) === 'personal' && QUICK_EDIT_COLS[k]);
  if (personalIn && !caps.personal_update) return res.status(403).json({ error: 'Sin permiso (empleados.personal.update)' });
  if (legalIn && !caps.legal_update)       return res.status(403).json({ error: 'Sin permiso (empleados.legal.update)' });
  next();
}
function guardStatusChange(req, res, next) {
  const caps = capsForRole(req.user?.role);
  if (!caps.status_change) return res.status(403).json({ error: 'Sin permiso (empleados.status.change)' });
  next();
}
function guardBiometricsLink(req, res, next) {
  const caps = capsForRole(req.user?.role);
  if (!caps.biometrics_link) return res.status(403).json({ error: 'Sin permiso (empleados.biometrics.link)' });
  next();
}

// Listado de departamentos activos (para selectores en formularios)
router.get('/departments', asyncHandler(async (req, res) => {
  const [rows] = await sequelize.query(
    'SELECT id, name, code FROM departments WHERE active = 1 ORDER BY name'
  );
  res.json(rows);
}));

// Alerta: empleados inactivos que siguen marcando. ANTES de '/:id'.
router.get('/inactive-marks',      requirePermission('empleados', 'view'), getInactiveMarks);

router.get('/',                    requirePermission('empleados', 'view'), getAll);
router.get('/:id',                 requirePermission('empleados', 'view'), getById);
router.post('/',                   authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'create'), validate(createEmployeeSchema), create);
router.put('/:id',                 authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'update'), guardLegalOnPut, update);
router.delete('/:id',              authorize('admin'), requirePermission('empleados', 'delete'), deactivate);
router.post('/:id/deactivate',     authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'delete'), guardStatusChange, deactivate);
router.post('/:id/reactivate',     authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'update'), guardStatusChange, reactivate);
router.get('/:id/attendance',      requirePermission('empleados', 'view'), getAttendanceHistory);

// Helper: normalizar fecha de hire_date aceptando "DD/MM/YYYY", "YYYY-MM-DD", etc.
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY o DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const [, d, mo, y] = m;
    const yyyy = y.length === 2 ? '20' + y : y;
    return `${yyyy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function parseStatus(v) {
  if (!v) return 'active';
  const s = String(v).toLowerCase().trim();
  if (['inactive', 'inactivo', 'baja', 'disabled', '0', 'no', 'false'].includes(s)) return 'inactive';
  if (['suspended', 'suspendido', 'suspenso'].includes(s)) return 'suspended';
  return 'active';
}

// POST /api/employees/import — importar lote de empleados (CSV/Excel)
router.post('/import', authorize('admin','hr'), requirePermission('empleados', 'create'), async (req, res) => {
  const { employees } = req.body;
  if (!Array.isArray(employees) || !employees.length) {
    return res.status(400).json({ error: 'Se requiere un array de empleados' });
  }

  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  // ── Precarga para evitar N+1 (2 queries en vez de 2·N lecturas) ──
  // Mapa de departamentos por nombre y código (case-insensitive).
  const [allDepts] = await sequelize.query('SELECT id, name, code FROM departments');
  const deptMap = new Map();
  for (const d of allDepts) {
    if (d.name) deptMap.set(String(d.name).toLowerCase().trim(), d.id);
    if (d.code) deptMap.set(String(d.code).toLowerCase().trim(), d.id);
  }
  // Set de códigos de empleado ya existentes (solo los del lote).
  const loteCodes = [...new Set(employees.map(e => String(e.code || '').trim()).filter(Boolean))];
  const existingCodes = new Set();
  if (loteCodes.length) {
    const [rows] = await sequelize.query(
      `SELECT code FROM employees WHERE code IN (${loteCodes.map(() => '?').join(',')})`,
      { replacements: loteCodes }
    );
    for (const r of rows) existingCodes.add(String(r.code));
  }

  for (const emp of employees) {
    const code       = String(emp.code || '').trim();
    const firstName  = String(emp.first_name || emp.nombre || emp.Nombre || '').trim();
    const lastName   = String(emp.last_name  || emp.apellido || emp.Apellido || '').trim();
    const empNumber  = String(emp.employee_number || emp.legajo || emp.cedula || emp.document_id || '').trim() || null;
    const hireDate   = parseDate(emp.hire_date || emp.fecha_ingreso || emp.hiredate);
    const status     = parseStatus(emp.status || emp.estado);
    const email      = String(emp.email || '').trim() || null;
    const phone      = String(emp.phone || emp.telefono || '').trim() || null;
    const position   = String(emp.position || emp.cargo || '').trim() || null;

    if (!code || !firstName) {
      errors.push({ code: code || '?', error: 'Código y nombre son requeridos' });
      continue;
    }

    try {
      // Resolver department_id desde nombre de departamento si no viene el ID
      let deptId = emp.department_id || null;
      if (!deptId && (emp.department || emp.departamento)) {
        const deptName = String(emp.department || emp.departamento).trim();
        const key = deptName.toLowerCase();
        if (deptMap.has(key)) {
          deptId = deptMap.get(key);
        } else if (deptName) {
          // Auto-crear el departamento si no existe (facilita imports desde HR externo)
          const [ins] = await sequelize.query(
            'INSERT INTO departments (name, active) VALUES (?, 1)',
            { replacements: [deptName] }
          );
          deptId = ins; // insertId
          deptMap.set(key, deptId); // cachear para las siguientes filas del lote
        }
      }

      const existing = existingCodes.has(code);

      if (existing) {
        if (emp._update) {
          await sequelize.query(`
            UPDATE employees SET
              first_name      = COALESCE(NULLIF(?,''), first_name),
              last_name       = COALESCE(NULLIF(?,''), last_name),
              employee_number = COALESCE(NULLIF(?,''), employee_number),
              email           = COALESCE(NULLIF(?,''), email),
              phone           = COALESCE(NULLIF(?,''), phone),
              position        = COALESCE(NULLIF(?,''), position),
              department_id   = COALESCE(?, department_id),
              hire_date       = COALESCE(?, hire_date),
              status          = COALESCE(NULLIF(?,''), status)
            WHERE code = ?`,
            { replacements: [firstName, lastName, empNumber, email, phone, position, deptId, hireDate, status, code] }
          );
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      await sequelize.query(`
        INSERT INTO employees
          (code, employee_number, first_name, last_name, email, phone, position, department_id, hire_date, status)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        { replacements: [code, empNumber, firstName, lastName, email, phone, position, deptId, hireDate, status] }
      );
      existingCodes.add(code); // evita reinsertar si el código se repite en el lote
      created++;
    } catch (e) {
      errors.push({ code, error: e.message });
    }
  }

  res.json({ ok: true, created, updated, skipped, errors, total: employees.length });
});

// PATCH /api/employees/bulk — actualizar varios empleados a la vez
// Body: { ids: [1,2,3], changes: { department_id, status, position, schedule_id } }
router.patch('/bulk', authorize('admin','hr'), requirePermission('empleados', 'update'), async (req, res) => {
  const { ids, changes } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids requerido (array)' });
  }
  if (!changes || typeof changes !== 'object') {
    return res.status(400).json({ error: 'changes requerido' });
  }
  const allowed = ['department_id', 'schedule_id', 'status', 'position'];
  const sets = [];
  const vals = [];
  for (const f of allowed) {
    if (changes[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(changes[f] === '' ? null : changes[f]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Ningún campo válido en changes' });
  try {
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await sequelize.query(
      `UPDATE employees SET ${sets.join(', ')} WHERE id IN (${placeholders})`,
      { replacements: [...vals, ...ids] }
    );
    res.json({ ok: true, affected: result?.affectedRows ?? ids.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /api/employees/:id/quick — edición inline rápida.
// Map explícito: la clave recibida del cliente nunca toca el SQL directamente.
// Los campos legales (MTESS/IPS) usan sub-permiso `legal.update`; el resto,
// `personal.update`. Nunca se guarda el valor de salario en la auditoría.
const QUICK_EDIT_COLS = {
  first_name: 'first_name', last_name: 'last_name',
  employee_number: 'employee_number', email: 'email',
  phone: 'phone', position: 'position',
  birth_date: 'birth_date', hire_date: 'hire_date',
  // Datos para planillas legales (MTESS / IPS)
  document_number: 'document_number', ips_number: 'ips_number',
  salary_base: 'salary_base', gender: 'gender', pay_type: 'pay_type',
  children_count: 'children_count', antiguedad_rate: 'antiguedad_rate',
};
router.patch('/:id/quick', authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'update'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const { field, value } = req.body || {};
  const col = QUICK_EDIT_COLS[field];
  if (!col) return res.status(400).json({ error: 'Campo no permitido para edición rápida' });

  const kind = classifyField(field);           // 'personal' | 'legal'
  const caps = capsForRole(req.user?.role);
  const needed = kind === 'legal' ? 'legal_update' : 'personal_update';
  if (!caps[needed]) {
    return res.status(403).json({ error: `Sin permiso (empleados.${kind}.update)` });
  }

  const parsed = validateField(field, value);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, field });

  const [[prev]] = await sequelize.query(
    `SELECT \`${col}\` AS v FROM employees WHERE id = ?`, { replacements: [id] }
  );
  if (!prev) return res.status(404).json({ error: 'Empleado no encontrado' });
  const before = prev.v;
  const after = parsed.value;

  // No-op si el valor efectivo no cambió (evita eventos ruidosos).
  const same = (before === after) || (before == null && after == null) ||
               (before != null && after != null && String(before) === String(after));
  if (same) return res.json({ ok: true, changed: false });

  await sequelize.query(
    `UPDATE employees SET \`${col}\` = ? WHERE id = ?`,
    { replacements: [after, id] }
  );

  audit.log({
    req, user: req.user,
    action: `employee.update.${kind}`,
    entity: 'employee', entity_id: id,
    details: {
      field,
      from: auditValueOf(field, before),
      to:   auditValueOf(field, after),
      sensitive: SENSITIVE_VALUE.has(field) || undefined,
    },
  });

  res.json({ ok: true, changed: true });
}));

// ─── Biometría / Relojes (Fase C) ─────────────────────────────
const { linkEmployeeDevice, unlinkEmployeeDevice } = require('../services/deviceMapping');
const { tableExists } = require('../services/zktecoReader');

// GET /api/employees/:id/biometrics — vínculos del empleado + sugerencias +
// última marca por reloj. No pierde nada: sólo lectura.
router.get('/:id/biometrics', requirePermission('empleados', 'view'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const [[emp]] = await sequelize.query('SELECT id, code, employee_number FROM employees WHERE id=?', { replacements: [id] });
  if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

  const hasEdm = await tableExists('employee_device_map');
  const hasRaw = await tableExists('raw_device_punches');

  let linked = [];
  if (hasEdm) {
    [linked] = await sequelize.query(`
      SELECT edm.id, edm.device_id, d.name AS device_name, edm.device_user_id,
             edm.active, edm.created_at,
             (SELECT MAX(al.timestamp) FROM attendance_logs al
               WHERE al.employee_id = edm.employee_id
                 AND (edm.device_id IS NULL OR al.device_id = edm.device_id)) AS last_mark
      FROM employee_device_map edm
      LEFT JOIN devices d ON d.id = edm.device_id
      WHERE edm.employee_id = ? AND edm.active = 1
      ORDER BY edm.id`, { replacements: [id] });
  }

  // Sugerencias: marcas sin empleado cuyo device_user_id coincide con code/employee_number.
  let suggestions = [];
  const keys = [emp.code, emp.employee_number].filter(v => v != null && String(v).trim() !== '').map(String);
  if (hasRaw && keys.length) {
    [suggestions] = await sequelize.query(`
      SELECT r.device_id, d.name AS device_name, r.device_user_id,
             COUNT(*) AS marcas, MIN(r.record_time_py) AS first_py, MAX(r.record_time_py) AS last_py
      FROM raw_device_punches r
      LEFT JOIN devices d ON d.id = r.device_id
      WHERE r.mapping_status = 'unmapped' AND r.device_user_id IN (${keys.map(() => '?').join(',')})
      GROUP BY r.device_id, d.name, r.device_user_id`, { replacements: keys });
  }

  // Última marca del empleado por reloj (para "Biometría / Relojes").
  const [byDevice] = await sequelize.query(`
    SELECT al.device_id, d.name AS device_name, COUNT(*) AS marcas, MAX(al.timestamp) AS last_mark
    FROM attendance_logs al
    LEFT JOIN devices d ON d.id = al.device_id
    WHERE al.employee_id = ?
    GROUP BY al.device_id, d.name
    ORDER BY last_mark DESC`, { replacements: [id] });

  res.json({ ok: true, employee: { id: emp.id, code: emp.code, employee_number: emp.employee_number }, linked, suggestions, by_device: byDevice });
}));

// POST /api/employees/:id/biometrics — vincular un device_user_id al empleado
// (permite resolver casos como 5404 desde el perfil) y reprocesar sus marcas.
router.post('/:id/biometrics', authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'update'), guardBiometricsLink, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const deviceUserId = String(req.body.device_user_id || '').trim();
  const deviceId = req.body.device_id != null && req.body.device_id !== '' ? parseInt(req.body.device_id, 10) : null;
  if (!deviceUserId) return res.status(400).json({ error: 'device_user_id es obligatorio' });
  const [[emp]] = await sequelize.query('SELECT id FROM employees WHERE id=?', { replacements: [id] });
  if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
  try {
    const summary = await linkEmployeeDevice({ employeeId: id, deviceUserId, deviceId, createdBy: req.user?.id || null });
    audit.log({ req, user: req.user, action: 'biometric.link', entity: 'employee', entity_id: id,
      details: { device_user_id: deviceUserId, device_id: deviceId, ...summary } });
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}));

// DELETE /api/employees/:id/biometrics/:mapId — desvincular (active=0). NO borra
// attendance_logs históricos.
router.delete('/:id/biometrics/:mapId', authorize('admin', 'hr', 'gth'), requirePermission('empleados', 'update'), guardBiometricsLink, asyncHandler(async (req, res) => {
  try {
    const r = await unlinkEmployeeDevice({ mapId: parseInt(req.params.mapId), employeeId: parseInt(req.params.id) });
    audit.log({ req, user: req.user, action: 'biometric.unlink', entity: 'employee', entity_id: parseInt(req.params.id), details: r });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

module.exports = router;
