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
 *   GET    /api/onboarding/:id/assignee-candidates → responsables asignables (filtrados)
 *
 * Tareas
 *   PATCH  /api/onboarding/tasks/:taskId        → actualizar estado/assignee/notas/fecha
 *
 * ROLES
 *   - Gestión global: super_admin, admin, gth, hr.
 *   - Gestión con alcance: manager, coordinator, gestor (departamentos activos
 *     de su sede, services/departmentScope).
 *   - supervisor y employee NO administran onboarding (403).
 *   - Consultar plantillas: roles de gestión. Crear/editar/desactivar
 *     plantillas y crear/completar/cancelar procesos: sólo gestión global.
 *   - Listado, detalle, candidatos y PATCH aplican el MISMO alcance: el del
 *     empleado del proceso. Para un rol con alcance, un proceso/tarea
 *     inexistente y uno fuera de alcance responden el mismo 404.
 *
 * CONSISTENCIA: PATCH de tarea, alta, completar y cancelar corren en una
 * transacción: tarea → proceso → empleado se bloquean con FOR UPDATE (en ese
 * orden), el alcance del actor y el responsable con FOR SHARE. Rechazo o
 * `affectedRows = 0` → rollback, sin escritura ni auditoría; la auditoría se
 * registra sólo después del commit. Se mantiene el autocompletado del
 * proceso cuando no quedan tareas pendientes (sin reapertura ni estados
 * nuevos). `completed_at`/`completed_by` de la tarea se fijan al pasar a
 * `done` y se limpian al salir de `done`; un PATCH sin estado los conserva.
 *
 * PLANTILLAS: el alta se valida entera (plantilla y cada tarea, sin omitir
 * tareas inválidas) antes de abrir la transacción. `due_days` es un entero
 * de 0 a 3650; 0 = vence el mismo día que `start_date`; sólo si falta se usa 3.
 */
const router  = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { sendMail } = require('../services/emailService');
const audit = require('../services/audit');
const { getVisibleDepartmentIds, applyDepartmentScope, canSeeEmployee, isGlobal } = require('../services/departmentScope');
const { findEmployeeInScope, rollbackQuietly } = require('../services/employeeScopeLock');
const { parsePositiveId } = require('../utils/strictId');
const V = require('../services/onboardingValidation');

router.use(authenticate);

const ADMIN_ROLES = ['admin', 'gth', 'hr', 'super_admin'];
const MGR_ROLES   = [...ADMIN_ROLES, 'manager', 'coordinator', 'gestor'];

const PROCESS_NOT_FOUND = { error: 'Proceso no encontrado' };
const TASK_NOT_FOUND = { error: 'Tarea no encontrada' };
const TEMPLATE_NOT_FOUND = { error: 'Plantilla no encontrada' };
const INVALID_ASSIGNEE = { error: 'Responsable inválido', code: 'INVALID_ASSIGNEE' };
const badInput = (res, error) => res.status(400).json({ error, code: 'INVALID_INPUT' });
const serverError = (res) => res.status(500).json({ error: 'Error interno' });

/**
 * ¿Puede el actor asignar esta cuenta como responsable? Cuenta existente y
 * ACTIVA; un rol con alcance, además, sólo cuentas vinculadas a un empleado
 * de su alcance. Dentro de una transacción la fila se lee con FOR SHARE: una
 * desactivación concurrente espera al commit (o la asignación espera la suya).
 */
async function assigneeAllowed(scope, assigneeId, transaction) {
  const [[u]] = await sequelize.query(
    `SELECT u.id, u.active, e.department_id
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = ? LIMIT 1${transaction ? ' FOR SHARE' : ''}`,
    { replacements: [assigneeId], transaction }
  );
  if (!u || !Number(u.active)) return false;
  if (isGlobal(scope)) return true;
  return u.department_id != null && canSeeEmployee(scope, { department_id: Number(u.department_id) });
}

/** Proceso visible para el actor (alcance del empleado del proceso) o null. */
async function findProcessInScope(user, processId) {
  const scope = await getVisibleDepartmentIds(user);
  const sc = applyDepartmentScope('WHERE p.id = ?', [processId], scope, 'e.department_id');
  const [[p]] = await sequelize.query(`
    SELECT p.*,
           CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code AS employee_code,
           d.name AS department_name,
           t.name AS template_name, t.type AS template_type
    FROM onboarding_processes p
    JOIN employees e ON e.id = p.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    JOIN onboarding_templates t ON t.id = p.template_id
    ${sc.where}
  `, { replacements: sc.params });
  return p ? { process: p, scope } : null;
}

// ─── TEMPLATES ───────────────────────────────────────────────────────────────

router.get('/templates', authorize(...MGR_ROLES), async (req, res) => {
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
  } catch (err) { serverError(res); }
});

router.get('/templates/:id', authorize(...MGR_ROLES), async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return badInput(res, 'Identificador de plantilla inválido');
    const [[t]] = await sequelize.query(
      'SELECT * FROM onboarding_templates WHERE id = ?', { replacements: [id] }
    );
    if (!t) return res.status(404).json(TEMPLATE_NOT_FOUND);
    const [tasks] = await sequelize.query(
      'SELECT * FROM onboarding_template_tasks WHERE template_id = ? ORDER BY sort_order, id',
      { replacements: [id] }
    );
    res.json({ ok: true, data: { ...t, tasks } });
  } catch (err) { serverError(res); }
});

router.post('/templates', authorize(...ADMIN_ROLES), async (req, res) => {
  // Todo se valida ANTES de abrir la transacción: un error → 400 sin escribir.
  const v = V.validateTemplateCreate(req.body);
  if (!v.ok) return badInput(res, v.error);
  const { name, type, description, tasks } = v.value;
  let t;
  try {
    t = await sequelize.transaction();
    const [r] = await sequelize.query(
      `INSERT INTO onboarding_templates (name, type, description, created_by) VALUES (?, ?, ?, ?)`,
      { replacements: [name, type, description, req.user.id], transaction: t }
    );
    const templateId = insertId(r);
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      await sequelize.query(
        `INSERT INTO onboarding_template_tasks
           (template_id, title, description, default_assignee_role, due_days, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        { replacements: [templateId, task.title, task.description, task.default_assignee_role, task.due_days, i], transaction: t }
      );
    }
    await t.commit();
    res.status(201).json({ ok: true, id: templateId });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

/** Plantilla existente bloqueada (FOR UPDATE) dentro de `transaction`, o null. */
async function lockTemplate(id, transaction) {
  const [[row]] = await sequelize.query(
    'SELECT id FROM onboarding_templates WHERE id = ? LIMIT 1 FOR UPDATE', { replacements: [id], transaction }
  );
  return row || null;
}

router.put('/templates/:id', authorize(...ADMIN_ROLES), async (req, res) => {
  let t;
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return badInput(res, 'Identificador de plantilla inválido');
    const v = V.validateTemplateUpdate(req.body);
    if (!v.ok) return badInput(res, v.error);
    t = await sequelize.transaction();
    if (!(await lockTemplate(id, t))) { await rollbackQuietly(t); return res.status(404).json(TEMPLATE_NOT_FOUND); }
    const keys = Object.keys(v.value);
    await sequelize.query(
      `UPDATE onboarding_templates SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      { replacements: [...keys.map((k) => v.value[k]), id], transaction: t }
    );
    await t.commit();
    res.json({ ok: true });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

router.delete('/templates/:id', authorize(...ADMIN_ROLES), async (req, res) => {
  let t;
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return badInput(res, 'Identificador de plantilla inválido');
    t = await sequelize.transaction();
    if (!(await lockTemplate(id, t))) { await rollbackQuietly(t); return res.status(404).json(TEMPLATE_NOT_FOUND); }
    await sequelize.query('UPDATE onboarding_templates SET active = 0 WHERE id = ?', { replacements: [id], transaction: t });
    await t.commit();
    res.json({ ok: true });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

// ─── PROCESOS ────────────────────────────────────────────────────────────────

router.get('/', authorize(...MGR_ROLES), async (req, res) => {
  try {
    const q = V.validateProcessListQuery(req.query);
    if (!q.ok) return badInput(res, q.error);
    const conds = []; const params = [];
    if (q.value.status)     { conds.push('p.status = ?');      params.push(q.value.status); }
    if (q.value.type)       { conds.push('p.type = ?');        params.push(q.value.type); }
    if (q.value.employeeId) { conds.push('p.employee_id = ?'); params.push(q.value.employeeId); }
    // Mismo alcance que el detalle y el PATCH: el del empleado del proceso.
    const sc = applyDepartmentScope(`WHERE 1=1${conds.map((c) => ` AND ${c}`).join('')}`, params,
      await getVisibleDepartmentIds(req.user), 'e.department_id');

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
      ${sc.where}
      ORDER BY p.created_at DESC
      LIMIT 100
    `, { replacements: sc.params });
    res.json({ ok: true, data: rows });
  } catch (err) { serverError(res); }
});

router.get('/:id', authorize(...MGR_ROLES), async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return badInput(res, 'Identificador de proceso inválido');
    const found = await findProcessInScope(req.user, id);
    if (!found) return res.status(404).json(PROCESS_NOT_FOUND);

    const [tasks] = await sequelize.query(`
      SELECT ot.*, u.full_name AS assignee_name, cb.full_name AS completed_by_name
      FROM onboarding_tasks ot
      LEFT JOIN users u  ON u.id  = ot.assignee_id
      LEFT JOIN users cb ON cb.id = ot.completed_by
      WHERE ot.process_id = ?
      ORDER BY ot.sort_order, ot.id
    `, { replacements: [id] });

    res.json({ ok: true, data: { ...found.process, tasks } });
  } catch (err) { serverError(res); }
});

// Responsables asignables para las tareas de un proceso: cuentas ACTIVAS; un
// rol con alcance sólo ve cuentas vinculadas a empleados de su alcance.
router.get('/:id/assignee-candidates', authorize(...MGR_ROLES), async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return badInput(res, 'Identificador de proceso inválido');
    const found = await findProcessInScope(req.user, id);
    if (!found) return res.status(404).json(PROCESS_NOT_FOUND);
    let rows;
    if (isGlobal(found.scope)) {
      [rows] = await sequelize.query(
        `SELECT u.id, u.full_name, u.username, u.role FROM users u
          WHERE u.active = 1 ORDER BY u.full_name, u.id LIMIT 500`
      );
    } else {
      const sc = applyDepartmentScope('WHERE u.active = 1', [], found.scope, 'e.department_id');
      [rows] = await sequelize.query(
        `SELECT u.id, u.full_name, u.username, u.role FROM users u
           JOIN employees e ON e.id = u.employee_id
          ${sc.where} ORDER BY u.full_name, u.id LIMIT 500`,
        { replacements: sc.params }
      );
    }
    res.json({ ok: true, data: rows });
  } catch (err) { serverError(res); }
});

router.post('/', authorize(...ADMIN_ROLES), async (req, res) => {
  const v = V.validateProcessCreate(req.body);
  if (!v.ok) return badInput(res, v.error);
  const { templateId, employeeId, startDate, assignees } = v.value;
  let t;
  try {
    t = await sequelize.transaction();
    const [[tmpl]] = await sequelize.query(
      'SELECT id, type FROM onboarding_templates WHERE id = ? AND active = 1 LIMIT 1 FOR SHARE',
      { replacements: [templateId], transaction: t }
    );
    if (!tmpl) { await rollbackQuietly(t); return res.status(404).json(TEMPLATE_NOT_FOUND); }
    if (!(await findEmployeeInScope(req.user, employeeId, { transaction: t, lock: true }))) {
      await rollbackQuietly(t);
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    const [templateTasks] = await sequelize.query(
      'SELECT id, title, description, due_days FROM onboarding_template_tasks WHERE template_id = ? ORDER BY sort_order, id',
      { replacements: [templateId], transaction: t }
    );
    const taskIds = new Set(templateTasks.map((x) => Number(x.id)));
    if ([...assignees.keys()].some((k) => !taskIds.has(k))) {
      await rollbackQuietly(t);
      return badInput(res, 'assignees referencia tareas que no son de la plantilla');
    }
    const scope = await getVisibleDepartmentIds(req.user, { transaction: t });
    for (const uid of new Set(assignees.values())) {
      if (!(await assigneeAllowed(scope, uid, t))) { await rollbackQuietly(t); return res.status(400).json(INVALID_ASSIGNEE); }
    }

    const [r] = await sequelize.query(
      `INSERT INTO onboarding_processes (template_id, employee_id, type, start_date, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [templateId, employeeId, tmpl.type, startDate, req.user.id], transaction: t }
    );
    const processId = insertId(r);
    for (let i = 0; i < templateTasks.length; i++) {
      const task = templateTasks[i];
      // Fecha civil: start_date + due_days (0 = el mismo día), sin zona horaria.
      const dueStr = V.taskDueDate(startDate, task.due_days);
      await sequelize.query(
        `INSERT INTO onboarding_tasks
           (process_id, title, description, assignee_id, due_date, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        { replacements: [processId, task.title, task.description || null, assignees.get(Number(task.id)) || null, dueStr, i], transaction: t }
      );
    }
    await t.commit();
    audit.log({ req, user: req.user, action: 'onboarding_process_create', entity: 'onboarding_processes', entity_id: processId, details: { employee_id: employeeId, type: tmpl.type, count: templateTasks.length } });

    // Notificar por email a assignees (best-effort)
    notifyAssignees(processId).catch(() => {});

    res.status(201).json({ ok: true, id: processId });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

/** Completar / cancelar: proceso bloqueado, sólo desde 'active'. */
function closeProcessHandler(targetStatus, action) {
  return async (req, res) => {
    let t;
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return badInput(res, 'Identificador de proceso inválido');
      t = await sequelize.transaction();
      const [[p]] = await sequelize.query(
        'SELECT id, status FROM onboarding_processes WHERE id = ? LIMIT 1 FOR UPDATE',
        { replacements: [id], transaction: t }
      );
      if (!p) { await rollbackQuietly(t); return res.status(404).json(PROCESS_NOT_FOUND); }
      if (p.status !== 'active') { await rollbackQuietly(t); return res.status(409).json({ error: 'El proceso no está activo' }); }
      const [r] = await sequelize.query(
        `UPDATE onboarding_processes SET status = ?${targetStatus === 'completed' ? ', completed_at = NOW()' : ''}
          WHERE id = ? AND status = 'active'`,
        { replacements: [targetStatus, id], transaction: t }
      );
      if (!r || !r.affectedRows) { await rollbackQuietly(t); return res.status(409).json({ error: 'El proceso no está activo' }); }
      await t.commit();
      audit.log({ req, user: req.user, action, entity: 'onboarding_processes', entity_id: id, details: { status: targetStatus } });
      res.json({ ok: true });
    } catch (err) { await rollbackQuietly(t); serverError(res); }
  };
}

router.post('/:id/complete', authorize(...ADMIN_ROLES), closeProcessHandler('completed', 'onboarding_process_complete'));
router.post('/:id/cancel', authorize(...ADMIN_ROLES), closeProcessHandler('cancelled', 'onboarding_process_cancel'));

// ─── TAREAS ───────────────────────────────────────────────────────────────────

router.patch('/tasks/:taskId', authorize(...MGR_ROLES), async (req, res) => {
  const taskId = parsePositiveId(req.params.taskId);
  if (taskId === null) return badInput(res, 'Identificador de tarea inválido');
  const v = V.validateTaskPatch(req.body);
  if (!v.ok) return badInput(res, v.error);
  const patch = v.value;
  let t;
  try {
    t = await sequelize.transaction();
    const scope = await getVisibleDepartmentIds(req.user, { transaction: t });
    // Orden de bloqueo: tarea → proceso → empleado (todo desde lo GUARDADO).
    const [[task]] = await sequelize.query(
      'SELECT id, process_id FROM onboarding_tasks WHERE id = ? LIMIT 1 FOR UPDATE',
      { replacements: [taskId], transaction: t }
    );
    if (!task) { await rollbackQuietly(t); return res.status(404).json(TASK_NOT_FOUND); }
    const [[proc]] = await sequelize.query(
      'SELECT id, employee_id, status FROM onboarding_processes WHERE id = ? LIMIT 1 FOR UPDATE',
      { replacements: [task.process_id], transaction: t }
    );
    const emp = proc && await findEmployeeInScope(req.user, Number(proc.employee_id), { transaction: t, lock: true });
    // Inexistente y fuera de alcance: el mismo 404 (antes de revelar el estado).
    if (!emp) { await rollbackQuietly(t); return res.status(404).json(TASK_NOT_FOUND); }
    if (proc.status !== 'active') { await rollbackQuietly(t); return res.status(409).json({ error: 'El proceso no está activo' }); }
    if (patch.assignee_id != null && !(await assigneeAllowed(scope, patch.assignee_id, t))) {
      await rollbackQuietly(t);
      return res.status(400).json(INVALID_ASSIGNEE);
    }

    const fields = Object.keys(patch);
    // Metadatos de finalización en el MISMO UPDATE: a done → actor y fecha;
    // a otro estado → NULL; sin cambio de estado → se conservan.
    const completion = V.taskCompletionSets(patch, req.user.id);
    const sets = [...fields.map((k) => `${k} = ?`), ...completion.sets];
    const vals = [...fields.map((k) => patch[k]), ...completion.vals];
    const [r] = await sequelize.query(
      `UPDATE onboarding_tasks SET ${sets.join(', ')} WHERE id = ? AND process_id = ?`,
      { replacements: [...vals, taskId, proc.id], transaction: t }
    );
    if (!r || !r.affectedRows) { await rollbackQuietly(t); return res.status(404).json(TASK_NOT_FOUND); }

    // Si todas las tareas están done/skipped → auto-completar proceso (contrato actual).
    const [[{ pending }]] = await sequelize.query(
      `SELECT COUNT(*) AS pending FROM onboarding_tasks
        WHERE process_id = ? AND status NOT IN ('done','skipped')`,
      { replacements: [proc.id], transaction: t }
    );
    let closed = false;
    if (Number(pending) === 0) {
      const [c] = await sequelize.query(
        `UPDATE onboarding_processes SET status='completed', completed_at=NOW() WHERE id = ? AND status = 'active'`,
        { replacements: [proc.id], transaction: t }
      );
      closed = !!(c && c.affectedRows);
    }
    await t.commit();
    audit.log({ req, user: req.user, action: 'onboarding_task_update', entity: 'onboarding_tasks', entity_id: taskId, details: { fields, status: patch.status, closed } });
    res.json({ ok: true });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
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
