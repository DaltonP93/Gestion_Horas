/**
 * employeeNotes.js — Notas internas por empleado (timeline RRHH).
 *
 * GET    /api/employee-notes/by-employee/:id
 * POST   /api/employee-notes                    (admin/gth/hr/manager)
 * PUT    /api/employee-notes/:id                (autor o admin)
 * DELETE /api/employee-notes/:id                (admin/gth/hr)
 *
 * ALCANCE POR EMPLEADO (services/departmentScope):
 *   - roles globales de RR.HH. (super_admin/admin/gth/hr): todas las
 *     visibilidades de cualquier empleado EXISTENTE;
 *   - roles por sede (manager/coordinator/supervisor/gestor): sólo empleados
 *     de los departamentos activos de su sede y visibilidades
 *     `managers`/`employee`;
 *   - employee: sólo SUS notas (users.employee_id vigente) con visibilidad
 *     `employee`;
 *   - cualquier otro rol: nada.
 * Fuera de alcance, no visible e inexistente responden el MISMO 404, sin
 * contenido, sin escritura y sin auditoría.
 *
 * VISIBILIDAD AL ESCRIBIR: un rol global que omite `visibility` crea
 * `hr_only`; un rol por sede crea `managers` por defecto y sólo puede crear o
 * cambiar a `managers`/`employee` (lo que puede leer). `hr_only` desde un rol
 * por sede → 403 VISIBILITY_NOT_ALLOWED sin escritura. Una escalación
 * confidencial hacia RR.HH. sería un flujo aparte.
 *
 * CONSISTENCIA: alta, edición y borrado leen la nota y el empleado con
 * FOR UPDATE y el alcance con FOR SHARE dentro de la MISMA transacción que la
 * mutación. Rechazo o `affectedRows = 0` → rollback y 404; la auditoría (sin
 * título ni cuerpo) se registra sólo después del commit.
 */
const router = require('express').Router();
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { insertId } = require('../utils/insertId');
const { isScoped, isUnrestricted } = require('../services/departmentScope');
const { findEmployeeInScope, rollbackQuietly } = require('../services/employeeScopeLock');
const { parsePositiveId } = require('../utils/strictId');

router.use(authenticate);

const VALID_TYPES      = new Set(['observation','warning','recognition','medical','training','other']);
const VALID_VISIBILITY = new Set(['hr_only','managers','employee']);
const SCOPED_VISIBILITY = ['managers', 'employee'];
const NOTE_NOT_FOUND = { error: 'Nota no encontrada' };
const EMP_NOT_FOUND = { error: 'Empleado no encontrado' };
const VISIBILITY_FORBIDDEN = { error: 'Visibilidad no permitida para su rol', code: 'VISIBILITY_NOT_ALLOWED' };

/** Visibilidades legibles: null = todas (global); [] = ninguna. */
function readableVisibilities(user) {
  if (isUnrestricted(user?.role)) return null;
  if (user?.role === 'employee') return ['employee'];
  if (isScoped(user?.role)) return SCOPED_VISIBILITY;
  return [];
}

/**
 * Nota GUARDADA bloqueada (FOR UPDATE) si el actor puede verla (visibilidad
 * legible y empleado existente, en alcance y bloqueado), dentro de
 * `transaction`; si no, null (→ 404).
 */
async function lockNoteInScope(user, noteId, transaction) {
  const [[note]] = await sequelize.query(
    'SELECT id, employee_id, author_id, visibility FROM employee_notes WHERE id = ? LIMIT 1 FOR UPDATE',
    { replacements: [noteId], transaction }
  );
  if (!note) return null;
  const vis = readableVisibilities(user);
  if (vis !== null && !vis.includes(note.visibility)) return null;
  const emp = await findEmployeeInScope(user, Number(note.employee_id), { transaction, lock: true, allowSelf: true });
  return emp ? { ...note, employee_id: emp.id } : null;
}

// Listado por empleado
router.get('/by-employee/:id', async (req, res) => {
  try {
    const empId = parsePositiveId(req.params.id);
    if (empId === null) return res.status(400).json({ error: 'Identificador de empleado inválido' });
    const vis = readableVisibilities(req.user);
    if ((vis !== null && !vis.length) || !(await findEmployeeInScope(req.user, empId, { allowSelf: true }))) {
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
    const global = isUnrestricted(req.user?.role);
    const {
      employee_id, type = 'observation', visibility = global ? 'hr_only' : 'managers',
      title, body, pinned = 0, attachment_url,
    } = req.body || {};
    if (!employee_id || !title) {
      return res.status(400).json({ error: 'employee_id y title son requeridos' });
    }
    const empId = parsePositiveId(employee_id);
    if (empId === null) return res.status(400).json({ error: 'Identificador de empleado inválido' });
    if (!VALID_TYPES.has(type))      return res.status(400).json({ error: 'type inválido' });
    if (!VALID_VISIBILITY.has(visibility)) return res.status(400).json({ error: 'visibility inválido' });
    if (!global && !SCOPED_VISIBILITY.includes(visibility)) return res.status(403).json(VISIBILITY_FORBIDDEN);
    let t;
    try {
      t = await sequelize.transaction();
      // El empleado debe existir y estar en el alcance, bloqueado hasta el commit.
      if (!(await findEmployeeInScope(req.user, empId, { transaction: t, lock: true }))) {
        await rollbackQuietly(t);
        return res.status(404).json(EMP_NOT_FOUND);
      }
      const [r] = await sequelize.query(
        `INSERT INTO employee_notes (employee_id, author_id, type, visibility, title, body, pinned, attachment_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [empId, req.user.id, type, visibility, title, body || null, pinned ? 1 : 0, attachment_url || null], transaction: t }
      );
      const id = insertId(r);
      await t.commit();
      // Auditoría sin contenido: ni título ni cuerpo (texto libre).
      audit.log({ req, user: req.user, action: 'employee_note_create', entity: 'employee_notes', entity_id: id, details: { employee_id: empId, type } });
      res.status(201).json({ ok: true, id });
    } catch (err) {
      await rollbackQuietly(t);
      res.status(500).json({ error: 'Error interno' });
    }
  });

// Editar (autor o admin)
router.put('/:id', async (req, res) => {
  let t;
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Identificador de nota inválido' });
    const body = req.body || {};
    t = await sequelize.transaction();
    const note = await lockNoteInScope(req.user, id, t);
    if (!note) { await rollbackQuietly(t); return res.status(404).json(NOTE_NOT_FOUND); }
    const isAdmin = ['admin', 'gth', 'super_admin'].includes(req.user?.role);
    if (!isAdmin && note.author_id !== req.user?.id) {
      await rollbackQuietly(t);
      return res.status(403).json({ error: 'Solo el autor o admin pueden editar' });
    }

    const allowed = ['type','visibility','title','body','pinned','attachment_url'];
    const sets = []; const vals = []; const fields = [];
    for (const k of allowed) {
      if (body[k] !== undefined) {
        if (k === 'type' && !VALID_TYPES.has(body[k])) {
          await rollbackQuietly(t); return res.status(400).json({ error: 'type inválido' });
        }
        if (k === 'visibility' && !VALID_VISIBILITY.has(body[k])) {
          await rollbackQuietly(t); return res.status(400).json({ error: 'visibility inválido' });
        }
        if (k === 'visibility' && !isUnrestricted(req.user?.role) && !SCOPED_VISIBILITY.includes(body[k])) {
          await rollbackQuietly(t); return res.status(403).json(VISIBILITY_FORBIDDEN);
        }
        sets.push(`${k} = ?`); vals.push(body[k]); fields.push(k);
      }
    }
    if (!sets.length) { await rollbackQuietly(t); return res.status(400).json({ error: 'Sin cambios' }); }
    const [r] = await sequelize.query(`UPDATE employee_notes SET ${sets.join(', ')} WHERE id = ? AND employee_id = ?`,
      { replacements: [...vals, id, note.employee_id], transaction: t });
    if (!r || !r.affectedRows) { await rollbackQuietly(t); return res.status(404).json(NOTE_NOT_FOUND); }
    await t.commit();
    audit.log({ req, user: req.user, action: 'employee_note_update', entity: 'employee_notes', entity_id: id, details: { employee_id: note.employee_id, fields } });
    res.json({ ok: true });
  } catch (err) {
    await rollbackQuietly(t);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Eliminar
router.delete('/:id',
  authorize('admin', 'gth', 'hr'),
  async (req, res) => {
    let t;
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Identificador de nota inválido' });
      t = await sequelize.transaction();
      const note = await lockNoteInScope(req.user, id, t);
      if (!note) { await rollbackQuietly(t); return res.status(404).json(NOTE_NOT_FOUND); }
      const [r] = await sequelize.query('DELETE FROM employee_notes WHERE id = ? AND employee_id = ?',
        { replacements: [id, note.employee_id], transaction: t });
      if (!r || !r.affectedRows) { await rollbackQuietly(t); return res.status(404).json(NOTE_NOT_FOUND); }
      await t.commit();
      audit.log({ req, user: req.user, action: 'employee_note_delete', entity: 'employee_notes', entity_id: id, details: { employee_id: note.employee_id } });
      res.json({ ok: true });
    } catch (err) {
      await rollbackQuietly(t);
      res.status(500).json({ error: 'Error interno' });
    }
  });

module.exports = router;
