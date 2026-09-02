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
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);

const ADMIN_ROLES = ['admin', 'gth', 'hr', 'super_admin'];
const MGR_ROLES   = [...ADMIN_ROLES, 'manager', 'coordinator', 'gestor'];

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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    await sequelize.query(`UPDATE appraisal_templates SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: [...vals, id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/templates/:id', authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    await sequelize.query('UPDATE appraisal_templates SET active = 0 WHERE id = ?',
      { replacements: [parseInt(req.params.id, 10)] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── EVALUACIONES ────────────────────────────────────────────────────────────

router.get('/', authorize(...MGR_ROLES), async (req, res) => {
  try {
    const { status, employee_id, period, limit = 50, offset = 0 } = req.query;
    const conds = []; const params = [];
    if (status)      { conds.push('a.status = ?');       params.push(status); }
    if (employee_id) { conds.push('a.employee_id = ?');  params.push(employee_id); }
    if (period)      { conds.push('a.period_label LIKE ?'); params.push(`%${period}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

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
      ${where}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `, { replacements: [...params, parseInt(limit), parseInt(offset)] });

    const [[{ total }]] = await sequelize.query(
      `SELECT COUNT(*) AS total FROM appraisals a ${where}`, { replacements: params }
    );
    res.json({ ok: true, data: rows, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Historial de un empleado (admin/manager puede ver cualquiera; empleado solo el suyo)
router.get('/employee/:empId', async (req, res) => {
  try {
    const empId = parseInt(req.params.empId, 10);
    const isAdmin = MGR_ROLES.includes(req.user.role);
    if (!isAdmin && req.user.employee_id !== empId)
      return res.status(403).json({ error: 'Sin permiso' });

    const [rows] = await sequelize.query(`
      SELECT a.id, a.period_label, a.status, a.final_score, a.due_date, a.closed_at,
             t.name AS template_name, t.scale_min, t.scale_max
      FROM appraisals a
      JOIN appraisal_templates t ON t.id = a.template_id
      WHERE a.employee_id = ?
      ORDER BY a.created_at DESC
    `, { replacements: [empId] });
    res.json({ ok: true, data: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[a]] = await sequelize.query(`
      SELECT a.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code AS employee_code,
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
    if (!a) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // Verificar acceso: admin/mgr, o el propio empleado, o el reviewer
    const isAdmin = MGR_ROLES.includes(req.user.role);
    const isReviewer = req.user.id === a.reviewer_id;
    const isEmployee = req.user.employee_id === a.employee_id;
    if (!isAdmin && !isReviewer && !isEmployee)
      return res.status(403).json({ error: 'Sin permiso' });

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
    res.json({ ok: true, data: { ...a, criteria, scores } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authorize(...MGR_ROLES), async (req, res) => {
  const { template_id, employee_id, reviewer_id, period_label, due_date } = req.body || {};
  if (!template_id || !employee_id || !period_label)
    return res.status(400).json({ error: 'template_id, employee_id y period_label son requeridos' });
  try {
    const [[tmpl]] = await sequelize.query(
      'SELECT id FROM appraisal_templates WHERE id = ? AND active = 1', { replacements: [template_id] }
    );
    if (!tmpl) return res.status(400).json({ error: 'Plantilla no encontrada o inactiva' });

    const [r] = await sequelize.query(
      `INSERT INTO appraisals (template_id, employee_id, reviewer_id, period_label, due_date, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'self_pending', ?)`,
      { replacements: [template_id, employee_id, reviewer_id || null, period_label, due_date || null, req.user.id] }
    );
    res.status(201).json({ ok: true, id: insertId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/score — enviar puntajes (self / manager / hr)
router.post('/:id/score', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { scorer_role, scores } = req.body || {};
  if (!['self','manager','hr'].includes(scorer_role))
    return res.status(400).json({ error: 'scorer_role inválido' });
  if (!Array.isArray(scores) || scores.length === 0)
    return res.status(400).json({ error: 'scores[] es requerido' });

  try {
    const [[a]] = await sequelize.query(
      'SELECT * FROM appraisals WHERE id = ?', { replacements: [id] }
    );
    if (!a) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (a.status === 'closed') return res.status(409).json({ error: 'Evaluación cerrada' });

    // Validar que el usuario tiene el rol correcto
    const isAdmin = ADMIN_ROLES.includes(req.user.role);
    const isReviewer = req.user.id === a.reviewer_id;
    const isEmployee = req.user.employee_id === a.employee_id;
    if (scorer_role === 'self' && !isEmployee && !isAdmin)
      return res.status(403).json({ error: 'Solo el empleado puede hacer auto-evaluación' });
    if (scorer_role === 'manager' && !isReviewer && !isAdmin)
      return res.status(403).json({ error: 'Solo el manager asignado puede evaluar' });
    if (scorer_role === 'hr' && !isAdmin)
      return res.status(403).json({ error: 'Solo RRHH puede enviar evaluación HR' });

    // Guardar cada puntaje
    const t = await sequelize.transaction();
    try {
      for (const { criteria_id, score, comment } of scores) {
        if (!criteria_id || score == null) continue;
        await sequelize.query(
          `INSERT INTO appraisal_scores (appraisal_id, criteria_id, scorer_role, score, comment, scored_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE score = VALUES(score), comment = VALUES(comment),
                                   scored_by = VALUES(scored_by), scored_at = NOW()`,
          { replacements: [id, criteria_id, scorer_role, score, comment || null, req.user.id], transaction: t }
        );
      }
      // Avanzar estado automáticamente
      let nextStatus = a.status;
      if (scorer_role === 'self'    && a.status === 'self_pending')    nextStatus = 'manager_pending';
      if (scorer_role === 'manager' && a.status === 'manager_pending') nextStatus = 'hr_review';
      if (nextStatus !== a.status) {
        await sequelize.query('UPDATE appraisals SET status = ? WHERE id = ?',
          { replacements: [nextStatus, id], transaction: t });
      }
      await t.commit();
      res.json({ ok: true, status: nextStatus });
    } catch (e) { await t.rollback(); throw e; }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/close — HR cierra la evaluación y calcula score final ponderado
router.post('/:id/close', authorize(...ADMIN_ROLES), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { hr_comment } = req.body || {};
  try {
    const [[a]] = await sequelize.query(
      'SELECT a.*, t.scale_max FROM appraisals a JOIN appraisal_templates t ON t.id = a.template_id WHERE a.id = ?',
      { replacements: [id] }
    );
    if (!a) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (a.status === 'closed') return res.status(409).json({ error: 'Ya está cerrada' });

    // Calcular promedio ponderado de puntajes de manager (o self si no hay manager)
    const preferRole = a.status === 'hr_review' ? 'manager' : 'self';
    const [scores] = await sequelize.query(`
      SELECT s.score, c.weight
      FROM appraisal_scores s
      JOIN appraisal_template_criteria c ON c.id = s.criteria_id
      WHERE s.appraisal_id = ? AND s.scorer_role = ?
    `, { replacements: [id, preferRole] });

    let finalScore = null;
    if (scores.length > 0) {
      const totalWeight = scores.reduce((acc, r) => acc + parseFloat(r.weight), 0);
      const weighted = scores.reduce((acc, r) => acc + r.score * parseFloat(r.weight), 0);
      finalScore = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) / 100 : null;
    }

    await sequelize.query(
      `UPDATE appraisals SET status='closed', final_score=?, hr_comment=?, closed_at=NOW() WHERE id=?`,
      { replacements: [finalScore, hr_comment || null, id] }
    );
    res.json({ ok: true, final_score: finalScore });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
