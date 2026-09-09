/**
 * onboarding.js — Workflow de Onboarding / Offboarding
 *
 * Templates
 *   GET    /api/onboarding/templates            → listar templates activos
 *   POST   /api/onboarding/templates            → crear template con tareas
 *   GET    /api/onboarding/templates/:id        → detalle + tareas
 *   PUT    /api/onboarding/templates/:id        → editar nombre/desc/estado
 *   DELETE /api/onboarding/templates/:id        → desactivar
 *
 * Procesos
 *   GET    /api/onboarding                      → lista de procesos activos
 *   POST   /api/onboarding                      → iniciar proceso para empleado
 *   GET    /api/onboarding/:id                  → detalle + tareas del proceso
 *   POST   /api/onboarding/:id/complete         → cerrar proceso
 *   POST   /api/onboarding/:id/cancel           → cancelar proceso
 *
 * Tareas
 *   PATCH  /api/onboarding/tasks/:taskId        → actualizar estado/assignee/notas
 */
const router  = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { sendMail } = require('../services/emailService');

router.use(authenticate);

const ADMIN_ROLES = ['admin', 'gth', 'hr', 'super_admin'];
const MGR_ROLES   = [...ADMIN_ROLES, 'manager', 'coordinator', 'gestor'];

// ─── TEMPLATES ───────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const showAll = req.query.all === '1';
    const [rows] = await sequelize.query(`
      SELECT t.*, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM onboarding_template_tasks tt WHERE tt.template_id = t.id) AS task_count
      FROM onboarding_templates t
      LEFT JOIN users u ON u.id = t.created_by
      ${showAll ? '' : 'WHERE t.active = 1'}
      ORDER BY t.type, t.name
    `);
    res.json({ ok: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[t]] = await sequelize.query(
      'SELECT * FROM onboarding_templates WHERE id = ?', { replacements: [id] }
    );
    if (!t) return res.status(404).json({ error: 'Template no encontrado' });
    const [tasks] = await sequelize.query(
      'SELECT * FROM onboarding_template_tasks WHERE template_id = ? ORDER BY sort_order, id',
      { replacements: [id] }
    );
    res.json({ ok: true, data: { ...t, tasks } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/templates', authorize(...ADMIN_ROLES), async (req, res) => {
  const { name, type = 'onboarding', description, tasks = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name es requerido' });
  if (!tasks.length) return res.status(400).json({ error: 'Se requiere al menos una tarea' });

  const t = await sequelize.transaction();
  try {
    const [r] = await sequelize.query(
      `INSERT INTO onboarding_templates (name, type, description, created_by) VALUES (?, ?, ?, ?)`,
      { replacements: [name, type, description || null, req.user.id], transaction: t }
    );
    const templateId = insertId(r);
    for (let i = 0; i < tasks.length; i++) {
      const { title, description: td, default_assignee_role, due_days = 3 } = tasks[i];
      if (!title) continue;
      await sequelize.query(
        `INSERT INTO onboarding_template_tasks
           (template_id, title, description, default_assignee_role, due_days, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        { replacements: [templateId, title, td || null, default_assignee_role || null, due_days, i], transaction: t }
      );
    }
    await t.commit();
    res.status(201).json({ ok: true, id: templateId });
  } catch (err) { await t.rollback(); res.status(500).json({ error: err.message }); }
});

router.put('/templates/:id', authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['name', 'description', 'active'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Sin cambios' });
    await sequelize.query(`UPDATE onboarding_templates SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/templates/:id', authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    await sequelize.query('UPDATE onboarding_templates SET active = 0 WHERE id = ?',
      { replacements: [parseInt(req.params.id, 10)] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PROCESOS ────────────────────────────────────────────────────────────────

router.get('/', authorize(...MGR_ROLES), async (req, res) => {
  try {
    const { status = 'active', type, employee_id } = req.query;
    const conds = []; const params = [];
    if (status)      { conds.push('p.status = ?');      params.push(status); }
    if (type)        { conds.push('p.type = ?');         params.push(type); }
    if (employee_id) { conds.push('p.employee_id = ?'); params.push(employee_id); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [rows] = await sequelize.query(`
      SELECT p.id, p.type, p.status, p.start_date, p.created_at, p.completed_at,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code AS employee_code,
             d.name AS department_name,
             t.name AS template_name,
             (SELECT COUNT(*) FROM onboarding_tasks ot WHERE ot.process_id = p.id) AS total_tasks,
             (SELECT COUNT(*) FROM onboarding_tasks ot WHERE ot.process_id = p.id AND ot.status = 'done') AS done_tasks,
             (SELECT COUNT(*) FROM onboarding_tasks ot
              WHERE ot.process_id = p.id AND ot.due_date < CURDATE() AND ot.status NOT IN ('done','skipped')) AS overdue_tasks
      FROM onboarding_processes p
      JOIN employees e ON e.id = p.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN onboarding_templates t ON t.id = p.template_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT 100
    `, { replacements: params });
    res.json({ ok: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[p]] = await sequelize.query(`
      SELECT p.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code AS employee_code,
             d.name AS department_name,
             t.name AS template_name, t.type AS template_type
      FROM onboarding_processes p
      JOIN employees e ON e.id = p.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN onboarding_templates t ON t.id = p.template_id
      WHERE p.id = ?
    `, { replacements: [id] });
    if (!p) return res.status(404).json({ error: 'Proceso no encontrado' });

    const isMgr = MGR_ROLES.includes(req.user.role);
    if (!isMgr) return res.status(403).json({ error: 'Sin permiso' });

    const [tasks] = await sequelize.query(`
      SELECT ot.*, u.full_name AS assignee_name, cb.full_name AS completed_by_name
      FROM onboarding_tasks ot
      LEFT JOIN users u  ON u.id  = ot.assignee_id
      LEFT JOIN users cb ON cb.id = ot.completed_by
      WHERE ot.process_id = ?
      ORDER BY ot.sort_order, ot.id
    `, { replacements: [id] });

    res.json({ ok: true, data: { ...p, tasks } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize(...ADMIN_ROLES), async (req, res) => {
  const { template_id, employee_id, start_date, assignees = {} } = req.body || {};
  if (!template_id || !employee_id || !start_date)
    return res.status(400).json({ error: 'template_id, employee_id y start_date son requeridos' });

  try {
    const [[tmpl]] = await sequelize.query(
      'SELECT * FROM onboarding_templates WHERE id = ? AND active = 1', { replacements: [template_id] }
    );
    if (!tmpl) return res.status(400).json({ error: 'Template no encontrado o inactivo' });

    const [templateTasks] = await sequelize.query(
      'SELECT * FROM onboarding_template_tasks WHERE template_id = ? ORDER BY sort_order, id',
      { replacements: [template_id] }
    );

    const t = await sequelize.transaction();
    try {
      const [r] = await sequelize.query(
        `INSERT INTO onboarding_processes (template_id, employee_id, type, start_date, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        { replacements: [template_id, employee_id, tmpl.type, start_date, req.user.id], transaction: t }
      );
      const processId = insertId(r);
      const startDt = new Date(start_date);

      for (let i = 0; i < templateTasks.length; i++) {
        const task = templateTasks[i];
        const due = new Date(startDt);
        due.setDate(due.getDate() + (task.due_days || 3));
        const dueStr = due.toISOString().split('T')[0];
        // assignees puede ser { [task_template_id]: user_id }
        const assigneeId = assignees[task.id] || null;
        await sequelize.query(
          `INSERT INTO onboarding_tasks
             (process_id, title, description, assignee_id, due_date, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          { replacements: [processId, task.title, task.description || null, assigneeId, dueStr, i], transaction: t }
        );
      }
      await t.commit();

      // Notificar por email a assignees (best-effort)
      notifyAssignees(processId).catch(() => {});

      res.status(201).json({ ok: true, id: processId });
    } catch (err) { await t.rollback(); throw err; }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/complete', authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await sequelize.query(
      `UPDATE onboarding_processes SET status='completed', completed_at=NOW() WHERE id=?`,
      { replacements: [id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/cancel', authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await sequelize.query(
      `UPDATE onboarding_processes SET status='cancelled' WHERE id=?`,
      { replacements: [id] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TAREAS ───────────────────────────────────────────────────────────────────

router.patch('/tasks/:taskId', async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const [[task]] = await sequelize.query(
      'SELECT ot.*, p.status AS process_status FROM onboarding_tasks ot JOIN onboarding_processes p ON p.id = ot.process_id WHERE ot.id = ?',
      { replacements: [taskId] }
    );
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.process_status !== 'active')
      return res.status(409).json({ error: 'El proceso no está activo' });

    const allowed = ['status', 'assignee_id', 'notes', 'due_date'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.body[k]); }
    }
    // Si se marca done, registrar quién y cuándo
    if (req.body.status === 'done') {
      sets.push('completed_at = NOW()'); sets.push('completed_by = ?'); vals.push(req.user.id);
    }
    if (!sets.length) return res.status(400).json({ error: 'Sin cambios' });

    await sequelize.query(`UPDATE onboarding_tasks SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, taskId] });

    // Si todas las tareas están done/skipped → auto-completar proceso
    const [[{ pending }]] = await sequelize.query(
      `SELECT COUNT(*) AS pending FROM onboarding_tasks
       WHERE process_id = ? AND status NOT IN ('done','skipped')`,
      { replacements: [task.process_id] }
    );
    if (pending === 0) {
      await sequelize.query(
        `UPDATE onboarding_processes SET status='completed', completed_at=NOW() WHERE id=?`,
        { replacements: [task.process_id] }
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Email a responsables al crear proceso ───────────────────────────────────
async function notifyAssignees(processId) {
  const [[p]] = await sequelize.query(`
    SELECT p.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name, t.name AS template_name, t.type
    FROM onboarding_processes p
    JOIN employees e ON e.id = p.employee_id
    JOIN onboarding_templates t ON t.id = p.template_id
    WHERE p.id = ?
  `, { replacements: [processId] });
  if (!p) return;

  const [tasks] = await sequelize.query(`
    SELECT ot.title, ot.due_date, u.email, u.full_name
    FROM onboarding_tasks ot
    JOIN users u ON u.id = ot.assignee_id
    WHERE ot.process_id = ? AND u.email IS NOT NULL
  `, { replacements: [processId] });

  // Agrupar por email
  const byEmail = {};
  for (const t of tasks) {
    if (!byEmail[t.email]) byEmail[t.email] = { name: t.full_name, tasks: [] };
    byEmail[t.email].tasks.push(t);
  }

  const typeLabel = p.type === 'onboarding' ? 'Onboarding' : 'Offboarding';
  for (const [email, { name, tasks: assignedTasks }] of Object.entries(byEmail)) {
    const taskList = assignedTasks.map(t =>
      `<li><strong>${t.title}</strong> — vence ${t.due_date}</li>`
    ).join('');
    await sendMail({
      to: email,
      subject: `📋 ${typeLabel}: tareas asignadas para ${p.employee_name}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#1e40af">${typeLabel} — ${p.employee_name}</h2>
        <p>Hola ${name}, se te han asignado las siguientes tareas:</p>
        <ul style="color:#374151">${taskList}</ul>
        <p>Ingresá al sistema para marcarlas como completadas.</p>
        <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb">
        <p style="color:#9ca3af;font-size:12px">Sistema de Asistencia — RRHH</p>
      </div>`,
    });
  }
}

module.exports = router;
