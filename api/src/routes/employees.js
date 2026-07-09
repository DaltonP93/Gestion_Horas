const router = require('express').Router();
const Joi = require('joi');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const {
  getAll, getById, create, update, deactivate, getAttendanceHistory
} = require('../controllers/employeeController');

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

// Listado de departamentos activos (para selectores en formularios)
router.get('/departments', asyncHandler(async (req, res) => {
  const [rows] = await sequelize.query(
    'SELECT id, name, code FROM departments WHERE active = 1 ORDER BY name'
  );
  res.json(rows);
}));

router.get('/',                    requirePermission('empleados', 'view'), getAll);
router.get('/:id',                 requirePermission('empleados', 'view'), getById);
router.post('/',                   authorize('admin','hr'), requirePermission('empleados', 'create'), validate(createEmployeeSchema), create);
router.put('/:id',                 authorize('admin','hr'), requirePermission('empleados', 'update'), update);
router.delete('/:id',              authorize('admin'), requirePermission('empleados', 'delete'), deactivate);
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

// PATCH /api/employees/:id/quick — edición inline rápida (nombre, apellido, etc.)
// Map explícito: la clave recibida del cliente nunca toca el SQL directamente.
const QUICK_EDIT_COLS = {
  first_name: 'first_name', last_name: 'last_name',
  employee_number: 'employee_number', email: 'email',
  phone: 'phone', position: 'position',
  birth_date: 'birth_date', hire_date: 'hire_date',
};
router.patch('/:id/quick', authorize('admin','hr'), requirePermission('empleados', 'update'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { field, value } = req.body || {};
  const col = QUICK_EDIT_COLS[field];
  if (!col) return res.status(400).json({ error: 'Campo no permitido para edición rápida' });
  try {
    await sequelize.query(
      `UPDATE employees SET \`${col}\` = ? WHERE id = ?`,
      { replacements: [value === '' ? null : value, id] }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
