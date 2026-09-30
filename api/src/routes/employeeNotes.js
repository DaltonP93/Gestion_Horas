/**
 * employeeNotes.js — Notas internas por empleado (timeline RRHH).
 *
 * GET    /api/employee-notes/by-employee/:id
 * POST   /api/employee-notes                    (admin/gth/hr/manager)
 * PUT    /api/employee-notes/:id                (autor o admin)
 * DELETE /api/employee-notes/:id                (admin/gth/hr)
 *
 * ALCANCE POR EMPLEADO (services/departmentScope):
 *   - roles globales de RR.HH. (super_admin/admin/gth/hr): sin cambio, todas
 *     las visibilidades de cualquier empleado;
 *   - roles por sede (manager/coordinator/supervisor/gestor): sólo empleados
 *     de los departamentos activos de su sede y visibilidades
 *     `managers`/`employee`;
 *   - employee: sólo SUS notas (users.employee_id vigente) con visibilidad
 *     `employee`;
 *   - cualquier otro rol: nada.
 * Editar y borrar validan el empleado y la visibilidad de la nota GUARDADA.
 * Fuera de alcance, no visible e inexistente responden el MISMO 404, sin
 * contenido, sin escritura y sin auditoría.
 */
const router = require('express').Router();
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { insertId } = require('../utils/insertId');
const { getVisibleDepartmentIds, canSeeEmployee, isGlobal, isScoped } = require('../services/departmentScope');
const { parsePositiveId } = require('../utils/strictId');

router.use(authenticate);

const VALID_TYPES      = new Set(['observation','warning','recognition','medical','training','other']);
const VALID_VISIBILITY = new Set(['hr_only','managers','employee']);
const NOTE_NOT_FOUND = { error: 'Nota no encontrada' };
const EMP_NOT_FOUND = { error: 'Empleado no encontrado' };

/** Visibilidades legibles: null = todas (global); [] = ninguna. */
function readableVisibilities(user, scope) {
  if (isGlobal(scope)) return null;
  if (user?.role === 'employee') return ['employee'];
  if (isScoped(user?.role)) return ['managers', 'employee'];
  return [];
}

/** ¿Puede el actor operar sobre notas de este empleado? */
async function employeeInScope(user, scope, employeeId) {
  if (isGlobal(scope)) return true;
  if (user?.role === 'employee') return user.employee_id != null && Number(user.employee_id) === employeeId;
  if (!isScoped(user?.role)) return false;
  const [[emp]] = await sequelize.query(
    'SELECT department_id FROM employees WHERE id = ? LIMIT 1', { replacements: [employeeId] }
  );
  return !!emp && canSeeEmployee(scope, emp);
}

/**
 * Nota GUARDADA si el actor puede verla (empleado en alcance y visibilidad
 * legible); si no, null (→ 404).
 */
async function loadNoteInScope(user, noteId) {
  const [[note]] = await sequelize.query(
    'SELECT id, employee_id, author_id, visibility FROM employee_notes WHERE id = ? LIMIT 1',
    { replacements: [noteId] }
  );
  if (!note) return null;
  const scope = await getVisibleDepartmentIds(user);
  const vis = readableVisibilities(user, scope);
  if (vis !== null && !vis.includes(note.visibility)) return null;
  return (await employeeInScope(user, scope, Number(note.employee_id))) ? note : null;
}

// Listado por empleado
router.get('/by-employee/:id', async (req, res) => {
  try {
    const empId = parsePositiveId(req.params.id);
    if (empId === null) return res.status(400).json({ error: 'Identificador de empleado inválido' });
    const scope = await getVisibleDepartmentIds(req.user);
    const vis = readableVisibilities(req.user, scope);
    if ((vis !== null && !vis.length) || !(await employeeInScope(req.user, scope, empId))) {
      return res.status(404).json(EMP_NOT_FOUND);
    }
    const visibilityFilter = vis === null ? '' : ` AND n.visibility IN (${vis.map(() => '?').join(',')})`;

    const [rows] = await sequelize.query(`
      SELECT n.*, u.username AS author_username, u.full_name AS author_name
      FROM employee_notes n
      LEFT JOIN users u ON u.id = n.author_id
      WHERE n.employee_id = ? ${visibilityFilter}
      ORDER BY n.pinned DESC, n.created_at DESC
    `, { replacements: [empId, ...(vis || [])] });
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Crear nota
router.post('/',
  authorize('admin', 'gth', 'hr', 'manager'),
  requirePermission('empleados', 'update'),
  async (req, res) => {
    const {
      employee_id, type = 'observation', visibility = 'hr_only',
      title, body, pinned = 0, attachment_url,
    } = req.body || {};
    if (!employee_id || !title) {
      return res.status(400).json({ error: 'employee_id y title son requeridos' });
    }
    const empId = parsePositiveId(employee_id);
    if (empId === null) return res.status(400).json({ error: 'Identificador de empleado inválido' });
    if (!VALID_TYPES.has(type))      return res.status(400).json({ error: 'type inválido' });
    if (!VALID_VISIBILITY.has(visibility)) return res.status(400).json({ error: 'visibility inválido' });
    try {
      // El empleado debe estar en el alcance ANTES de escribir.
      if (!(await employeeInScope(req.user, await getVisibleDepartmentIds(req.user), empId))) {
        return res.status(404).json(EMP_NOT_FOUND);
      }
      const [r] = await sequelize.query(
        `INSERT INTO employee_notes (employee_id, author_id, type, visibility, title, body, pinned, attachment_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [empId, req.user.id, type, visibility, title, body || null, pinned ? 1 : 0, attachment_url || null] }
      );
      const id = insertId(r);
      // Auditoría sin contenido: ni título ni cuerpo (texto libre).
      audit.log({ req, user: req.user, action: 'employee_note_create', entity: 'employee_notes', entity_id: id, details: { employee_id: empId, type } });
      res.status(201).json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: 'Error interno' });
    }
  });

// Editar (autor o admin)
router.put('/:id', async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador de nota inválido' });
    const note = await loadNoteInScope(req.user, id);
    if (!note) return res.status(404).json(NOTE_NOT_FOUND);
    const isAdmin = ['admin', 'gth', 'super_admin'].includes(req.user?.role);
    if (!isAdmin && note.author_id !== req.user?.id) {
      return res.status(403).json({ error: 'Solo el autor o admin pueden editar' });
    }

    const allowed = ['type','visibility','title','body','pinned','attachment_url'];
    const sets = []; const vals = []; const fields = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (k === 'type' && !VALID_TYPES.has(req.body[k])) {
          return res.status(400).json({ error: 'type inválido' });
        }
        if (k === 'visibility' && !VALID_VISIBILITY.has(req.body[k])) {
          return res.status(400).json({ error: 'visibility inválido' });
        }
        sets.push(`${k} = ?`); vals.push(req.body[k]); fields.push(k);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Sin cambios' });
    await sequelize.query(`UPDATE employee_notes SET ${sets.join(', ')} WHERE id = ? AND employee_id = ?`,
      { replacements: [...vals, id, note.employee_id] });
    audit.log({ req, user: req.user, action: 'employee_note_update', entity: 'employee_notes', entity_id: id, details: { employee_id: Number(note.employee_id), fields } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Eliminar
router.delete('/:id',
  authorize('admin', 'gth', 'hr'),
  async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Identificador de nota inválido' });
      const note = await loadNoteInScope(req.user, id);
      if (!note) return res.status(404).json(NOTE_NOT_FOUND);
      await sequelize.query('DELETE FROM employee_notes WHERE id = ? AND employee_id = ?', { replacements: [id, note.employee_id] });
      audit.log({ req, user: req.user, action: 'employee_note_delete', entity: 'employee_notes', entity_id: id, details: { employee_id: Number(note.employee_id) } });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Error interno' });
    }
  });

module.exports = router;
