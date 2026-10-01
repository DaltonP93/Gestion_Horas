/**
 * appraisals.js — Evaluaciones de Desempeño
 *
 * Plantillas
 *   GET    /api/appraisals/templates          → listar plantillas activas
 *   POST   /api/appraisals/templates          → crear plantilla (admin/gth/hr)
 *   GET    /api/appraisals/templates/:id      → detalle + criterios
 *   PUT    /api/appraisals/templates/:id      → editar plantilla
 *   DELETE /api/appraisals/templates/:id      → desactivar plantilla
 *
 * Evaluaciones
 *   GET    /api/appraisals                    → lista (filtros: status, employee_id, period)
 *   POST   /api/appraisals                    → crear (asignar template a empleado)
 *   GET    /api/appraisals/:id                → detalle + puntajes + criterios
 *   POST   /api/appraisals/:id/score          → enviar puntajes (self / manager / hr)
 *   POST   /api/appraisals/:id/advance        → avanzar estado del workflow
 *   POST   /api/appraisals/:id/close          → cerrar y calcular score final
 *   GET    /api/appraisals/employee/:empId    → historial de un empleado
 *
 * ACCESO (evaluaciones)
 *   - Global: super_admin, admin, gth, hr.
 *   - Con alcance: manager, coordinator, gestor → sólo evaluaciones de
 *     empleados de su alcance vigente (services/departmentScope).
 *   - supervisor: fuera de la administración (alta, historial, plantillas y
 *     cierre → 403). Puede ser elegido como reviewer. Ve y opera la UNIÓN de:
 *       · sus evaluaciones PROPIAS (users.employee_id): acceso personal, sin
 *         depender de su sede ni de su alcance; sólo autoevaluación;
 *       · las ASIGNADAS (reviewer = su cuenta) con el empleado dentro de su
 *         alcance vigente: puntuación como manager. Cambio de sede, sede
 *         inactiva o empleado fuera → la asignada desaparece (404); la propia
 *         sigue visible. Ser el evaluado nunca habilita puntuar como manager.
 *   - employee: sólo listado, historial, detalle y autoevaluación propios.
 *   - Inexistente y fuera de alcance responden el mismo 404 sin datos.
 *     Listado y total usan exactamente el mismo filtro.
 *   - El reviewer asignado lee y puntúa como manager mientras su cuenta siga
 *     activa (authenticate) y el empleado esté en su alcance vigente. Los
 *     roles globales pueden actuar como override de manager/hr, pero nunca
 *     envían la autoevaluación de otro.
 *
 * CONSISTENCIA: alta, puntuación y cierre corren en una transacción. La
 * evaluación se bloquea (FOR UPDATE) antes de autorizar; empleado,
 * plantilla, criterios, reviewer y alcance se leen con bloqueo dentro de la
 * misma transacción. Rechazo o `affectedRows = 0` → rollback sin escritura ni
 * auditoría; la auditoría se registra sólo después del commit.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { getVisibleDepartmentIds, canSeeEmployee, isGlobal } = require('../services/departmentScope');
const { findEmployeeInScope, rollbackQuietly } = require('../services/employeeScopeLock');
const { parsePositiveId } = require('../utils/strictId');
const V = require('../services/appraisalValidation');
const { canSeeAppraisal, listScope, ownEmployeeId } = require('../services/appraisalAccess');
const { escapeLike } = require('../services/userLookup');

router.use(authenticate);

const ADMIN_ROLES = ['admin', 'gth', 'hr', 'super_admin'];
const MGR_ROLES   = [...ADMIN_ROLES, 'manager', 'coordinator', 'gestor'];
/** Roles válidos como reviewer al ASIGNAR: gestión y supervisor (que no administra). */
const REVIEWER_ROLES = new Set([...MGR_ROLES, 'supervisor']);
/** Listado: gestión, employee (lo propio) y supervisor (sólo sus asignadas). */
const LIST_ROLES = [...MGR_ROLES, 'employee', 'supervisor'];
/** Historial de un empleado: gestión y el propio employee (NO supervisor). */
const HISTORY_ROLES = [...MGR_ROLES, 'employee'];

const NOT_FOUND = { error: 'Evaluación no encontrada' };
const EMPLOYEE_NOT_FOUND = { error: 'Empleado no encontrado' };
const INVALID_REVIEWER = { error: 'Reviewer inválido', code: 'INVALID_REVIEWER' };
const NOT_ACTIVE_STATE = (msg) => ({ error: msg, code: 'INVALID_STATE' });
const badInput = (res, error) => res.status(400).json({ error, code: 'INVALID_INPUT' });
const serverError = (res) => res.status(500).json({ error: 'Error interno' });

// ─── PLANTILLAS ──────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const onlyActive = req.query.all !== '1';
    const [rows] = await sequelize.query(`
      SELECT t.*, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM appraisal_template_criteria c WHERE c.template_id = t.id) AS criteria_count
      FROM appraisal_templates t
      LEFT JOIN users u ON u.id = t.created_by
      ${onlyActive ? 'WHERE t.active = 1' : ''}
      ORDER BY t.created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) { serverError(res); }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[t]] = await sequelize.query(
      'SELECT * FROM appraisal_templates WHERE id = ?', { replacements: [id] }
    );
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const [criteria] = await sequelize.query(
      'SELECT * FROM appraisal_template_criteria WHERE template_id = ? ORDER BY sort_order, id',
      { replacements: [id] }
    );
    res.json({ ok: true, data: { ...t, criteria } });
  } catch (err) { serverError(res); }
});

router.post('/templates', authorize(...ADMIN_ROLES), async (req, res) => {
  const { name, description, scale_min = 1, scale_max = 5, criteria = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name es requerido' });
  if (!Array.isArray(criteria) || criteria.length === 0)
    return res.status(400).json({ error: 'Se requiere al menos un criterio' });
  const t = await sequelize.transaction();
  try {
    const [r] = await sequelize.query(
      `INSERT INTO appraisal_templates (name, description, scale_min, scale_max, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [name, description || null, scale_min, scale_max, req.user.id], transaction: t }
    );
    const templateId = insertId(r);
    for (let i = 0; i < criteria.length; i++) {
      const { name: cn, description: cd, weight = 1 } = criteria[i];
      if (!cn) continue;
      await sequelize.query(
        `INSERT INTO appraisal_template_criteria (template_id, name, description, weight, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        { replacements: [templateId, cn, cd || null, weight, i], transaction: t }
      );
    }
    await t.commit();
    res.status(201).json({ ok: true, id: templateId });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
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
    await sequelize.query(`UPDATE appraisal_templates SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, id] });
    res.json({ ok: true });
  } catch (err) { serverError(res); }
});

router.delete('/templates/:id', authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    await sequelize.query('UPDATE appraisal_templates SET active = 0 WHERE id = ?',
      { replacements: [parseInt(req.params.id, 10)] });
    res.json({ ok: true });
  } catch (err) { serverError(res); }
});

// ─── EVALUACIONES ────────────────────────────────────────────────────────────

router.get('/', authorize(...LIST_ROLES), async (req, res) => {
  try {
    const q = V.validateListQuery(req.query);
    if (!q.ok) return badInput(res, q.error);
    const { status, employeeId, period, limit, offset } = q.value;
    const conds = []; const params = [];
    if (status)     { conds.push('a.status = ?');           params.push(status); }
    if (employeeId) { conds.push('a.employee_id = ?');      params.push(employeeId); }
    if (period)     { conds.push("a.period_label LIKE ? ESCAPE '!'"); params.push(`%${escapeLike(period)}%`); }
    const sc = listScope(req.user, await getVisibleDepartmentIds(req.user),
      `WHERE 1=1${conds.map((c) => ` AND ${c}`).join('')}`, params);

    const [rows] = await sequelize.query(`
      SELECT a.id, a.period_label, a.status, a.due_date, a.final_score, a.created_at,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code AS employee_code,
             d.name AS department_name,
             t.name AS template_name,
             u.full_name AS reviewer_name
      FROM appraisals a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN appraisal_templates t ON t.id = a.template_id
      LEFT JOIN users u ON u.id = a.reviewer_id
      ${sc.where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `, { replacements: [...sc.params, limit, offset] });

    const [[{ total }]] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM appraisals a JOIN employees e ON e.id = a.employee_id ${sc.where}`,
      { replacements: sc.params }
    );
    res.json({ ok: true, data: rows, total: Number(total), limit, offset });
  } catch (err) { serverError(res); }
});

// Historial de un empleado: gestión dentro de su alcance; employee sólo el suyo.
router.get('/employee/:empId', authorize(...HISTORY_ROLES), async (req, res) => {
  try {
    const empId = parsePositiveId(req.params.empId);
    if (empId === null) return badInput(res, 'Identificador de empleado inválido');
    const visible = req.user.role === 'employee'
      ? ownEmployeeId(req.user) === empId
      : !!(await findEmployeeInScope(req.user, empId));
    if (!visible) return res.status(404).json(EMPLOYEE_NOT_FOUND);

    const [rows] = await sequelize.query(`
      SELECT a.id, a.period_label, a.status, a.final_score, a.due_date, a.closed_at,
             t.name AS template_name, t.scale_min, t.scale_max
      FROM appraisals a
      JOIN appraisal_templates t ON t.id = a.template_id
      WHERE a.employee_id = ?
      ORDER BY a.created_at DESC, a.id DESC
    `, { replacements: [empId] });
    res.json({ ok: true, data: rows });
  } catch (err) { serverError(res); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return badInput(res, 'Identificador de evaluación inválido');
    const [[a]] = await sequelize.query(`
      SELECT a.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code AS employee_code,
             e.department_id AS employee_department_id,
             d.name AS department_name,
             t.name AS template_name, t.scale_min, t.scale_max,
             u.full_name AS reviewer_name,
             cb.full_name AS created_by_name
      FROM appraisals a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN appraisal_templates t ON t.id = a.template_id
      LEFT JOIN users u ON u.id = a.reviewer_id
      LEFT JOIN users cb ON cb.id = a.created_by
      WHERE a.id = ?
    `, { replacements: [id] });
    const scope = await getVisibleDepartmentIds(req.user);
    const emp = a && { id: Number(a.employee_id), department_id: a.employee_department_id == null ? null : Number(a.employee_department_id) };
    // Inexistente y sin acceso: el mismo 404, sin datos.
    if (!a || !canSeeAppraisal(req.user, scope, a, emp)) return res.status(404).json(NOT_FOUND);
    const { employee_department_id: _omit, ...appraisal } = a;

    const [criteria] = await sequelize.query(
      'SELECT * FROM appraisal_template_criteria WHERE template_id = ? ORDER BY sort_order, id',
      { replacements: [a.template_id] }
    );
    const [scores] = await sequelize.query(
      `SELECT s.*, u.full_name AS scored_by_name
       FROM appraisal_scores s
       LEFT JOIN users u ON u.id = s.scored_by
       WHERE s.appraisal_id = ?`,
      { replacements: [id] }
    );
    res.json({ ok: true, data: { ...appraisal, criteria, scores } });
  } catch (err) { serverError(res); }
});

/**
 * ¿Puede asignarse esta cuenta como reviewer del empleado? Cuenta existente,
 * ACTIVA, con rol de gestión o supervisor; si el actor tiene alcance, la cuenta debe ser
 * de una sede de su alcance (igual que /api/users/lookup); y el empleado
 * debe estar dentro del alcance VIGENTE del reviewer. Todo con FOR SHARE.
 */
async function reviewerAllowed(actorScope, reviewerId, emp, transaction) {
  const [[u]] = await sequelize.query(
    'SELECT id, role, active, branch_id FROM users WHERE id = ? LIMIT 1 FOR SHARE',
    { replacements: [reviewerId], transaction }
  );
  if (!u || !Number(u.active) || !REVIEWER_ROLES.has(u.role)) return false;
  if (!isGlobal(actorScope)) {
    const branches = Array.isArray(actorScope && actorScope.branchIds) ? actorScope.branchIds : [];
    if (u.branch_id == null || !branches.includes(Number(u.branch_id))) return false;
  }
  const reviewerScope = await getVisibleDepartmentIds({ id: Number(u.id), role: u.role }, { transaction });
  return canSeeEmployee(reviewerScope, emp);
}

router.post('/', authorize(...MGR_ROLES), async (req, res) => {
  const v = V.validateCreate(req.body);
  if (!v.ok) return badInput(res, v.error);
  const { templateId, employeeId, reviewerId, periodLabel, dueDate } = v.value;
  let t;
  try {
    t = await sequelize.transaction();
    const [[tmpl]] = await sequelize.query(
      'SELECT id FROM appraisal_templates WHERE id = ? AND active = 1 LIMIT 1 FOR SHARE',
      { replacements: [templateId], transaction: t }
    );
    if (!tmpl) {
      await rollbackQuietly(t);
      return res.status(400).json({ error: 'Plantilla no encontrada o inactiva', code: 'INVALID_TEMPLATE' });
    }
    const emp = await findEmployeeInScope(req.user, employeeId, { transaction: t, lock: true });
    if (!emp) { await rollbackQuietly(t); return res.status(404).json(EMPLOYEE_NOT_FOUND); }
    if (reviewerId !== null) {
      const scope = await getVisibleDepartmentIds(req.user, { transaction: t });
      if (!(await reviewerAllowed(scope, reviewerId, emp, t))) { await rollbackQuietly(t); return res.status(400).json(INVALID_REVIEWER); }
    }
    const [r] = await sequelize.query(
      `INSERT INTO appraisals (template_id, employee_id, reviewer_id, period_label, due_date, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'self_pending', ?)`,
      { replacements: [templateId, employeeId, reviewerId, periodLabel, dueDate, req.user.id], transaction: t }
    );
    const id = insertId(r);
    await t.commit();
    audit.log({ req, user: req.user, action: 'appraisal_create', entity: 'appraisals', entity_id: id, details: { employee_id: employeeId, status: 'self_pending' } });
    res.status(201).json({ ok: true, id });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

// POST /:id/score — enviar puntajes (self / manager / hr)
router.post('/:id/score', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return badInput(res, 'Identificador de evaluación inválido');
  const v = V.validateScoreBody(req.body);
  if (!v.ok) return badInput(res, v.error);
  const { scorerRole, scores } = v.value;
  let t;
  try {
    t = await sequelize.transaction();
    const scope = await getVisibleDepartmentIds(req.user, { transaction: t });
    // La evaluación se bloquea ANTES de autorizar: estado, reviewer y empleado
    // se evalúan sobre el valor vigente.
    const [[a]] = await sequelize.query(
      'SELECT id, template_id, employee_id, reviewer_id, status FROM appraisals WHERE id = ? LIMIT 1 FOR UPDATE',
      { replacements: [id], transaction: t }
    );
    const [[e]] = a ? await sequelize.query(
      'SELECT id, department_id FROM employees WHERE id = ? LIMIT 1 FOR SHARE',
      { replacements: [a.employee_id], transaction: t }
    ) : [[null]];
    const emp = e && { id: Number(e.id), department_id: e.department_id == null ? null : Number(e.department_id) };
    if (!a || !emp || !canSeeAppraisal(req.user, scope, a, emp)) { await rollbackQuietly(t); return res.status(404).json(NOT_FOUND); }

    const isOwn = ownEmployeeId(req.user) === Number(a.employee_id);
    const isReviewer = Number(a.reviewer_id) === Number(req.user.id) && canSeeEmployee(scope, emp);
    const allowed = scorerRole === 'self' ? isOwn
      : scorerRole === 'manager' ? (isReviewer || isGlobal(scope))
      : isGlobal(scope);
    if (!allowed) {
      await rollbackQuietly(t);
      const msg = { self: 'Sólo el empleado puede enviar su autoevaluación', manager: 'Sólo el reviewer asignado puede evaluar como manager', hr: 'Sólo RR.HH. puede enviar la evaluación de RR.HH.' };
      return res.status(403).json({ error: msg[scorerRole] });
    }
    const state = V.SCORE_STATE[scorerRole];
    if (a.status !== state.from) { await rollbackQuietly(t); return res.status(409).json(NOT_ACTIVE_STATE('La evaluación no está en el estado correspondiente')); }
    if (scorerRole === 'hr') {
      const [[{ n }]] = await sequelize.query(
        "SELECT COUNT(*) AS n FROM appraisal_scores WHERE appraisal_id = ? AND scorer_role = 'hr' FOR SHARE",
        { replacements: [id], transaction: t }
      );
      if (Number(n) > 0) { await rollbackQuietly(t); return res.status(409).json(NOT_ACTIVE_STATE('La evaluación de RR.HH. ya fue enviada')); }
    }

    const [[tmpl]] = await sequelize.query(
      'SELECT scale_min, scale_max FROM appraisal_templates WHERE id = ? LIMIT 1 FOR SHARE',
      { replacements: [a.template_id], transaction: t }
    );
    const [crit] = await sequelize.query(
      'SELECT id FROM appraisal_template_criteria WHERE template_id = ? FOR SHARE',
      { replacements: [a.template_id], transaction: t }
    );
    const check = tmpl && V.checkScoresAgainstTemplate(scores, crit.map((c) => c.id), tmpl.scale_min, tmpl.scale_max);
    if (!check || !check.ok) { await rollbackQuietly(t); return badInput(res, check ? check.error : 'Plantilla inválida'); }

    for (const s of scores) {
      await sequelize.query(
        `INSERT INTO appraisal_scores (appraisal_id, criteria_id, scorer_role, score, comment, scored_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        { replacements: [id, s.criteriaId, scorerRole, s.score, s.comment, req.user.id], transaction: t }
      );
    }
    if (state.to !== state.from) {
      const [u] = await sequelize.query(
        'UPDATE appraisals SET status = ? WHERE id = ? AND status = ?',
        { replacements: [state.to, id, state.from], transaction: t }
      );
      if (!u || !u.affectedRows) { await rollbackQuietly(t); return res.status(409).json(NOT_ACTIVE_STATE('La evaluación no está en el estado correspondiente')); }
    }
    await t.commit();
    audit.log({ req, user: req.user, action: 'appraisal_score', entity: 'appraisals', entity_id: id, details: { role: scorerRole, from: state.from, to: state.to, count: scores.length } });
    res.json({ ok: true, status: state.to });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

// POST /:id/close — RR.HH. cierra la evaluación y calcula el score final ponderado:
// desde manager_pending con la autoevaluación; desde hr_review con la del manager.
router.post('/:id/close', authorize(...ADMIN_ROLES), async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return badInput(res, 'Identificador de evaluación inválido');
  const v = V.validateCloseBody(req.body);
  if (!v.ok) return badInput(res, v.error);
  let t;
  try {
    t = await sequelize.transaction();
    const [[a]] = await sequelize.query(
      'SELECT id, status FROM appraisals WHERE id = ? LIMIT 1 FOR UPDATE',
      { replacements: [id], transaction: t }
    );
    if (!a) { await rollbackQuietly(t); return res.status(404).json(NOT_FOUND); }
    const preferRole = V.CLOSE_FROM[a.status];
    if (!preferRole) { await rollbackQuietly(t); return res.status(409).json(NOT_ACTIVE_STATE('La evaluación no se puede cerrar en su estado actual')); }

    const [scores] = await sequelize.query(`
      SELECT s.score, c.weight
      FROM appraisal_scores s
      JOIN appraisal_template_criteria c ON c.id = s.criteria_id
      WHERE s.appraisal_id = ? AND s.scorer_role = ?
      FOR SHARE
    `, { replacements: [id, preferRole], transaction: t });
    const finalScore = V.computeFinalScore(scores);

    const [u] = await sequelize.query(
      `UPDATE appraisals SET status = 'closed', final_score = ?, hr_comment = ?, closed_at = NOW()
        WHERE id = ? AND status = ?`,
      { replacements: [finalScore, v.value.hrComment, id, a.status], transaction: t }
    );
    if (!u || !u.affectedRows) { await rollbackQuietly(t); return res.status(409).json(NOT_ACTIVE_STATE('La evaluación no se puede cerrar en su estado actual')); }
    await t.commit();
    audit.log({ req, user: req.user, action: 'appraisal_close', entity: 'appraisals', entity_id: id, details: { from: a.status, to: 'closed', count: scores.length } });
    res.json({ ok: true, final_score: finalScore });
  } catch (err) { await rollbackQuietly(t); serverError(res); }
});

module.exports = router;
