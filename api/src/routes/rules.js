/**
 * rules.js — Constructor de condiciones (CRUD del motor de reglas).
 *
 *   GET    /api/rules/schema           → catálogo para el builder (módulos,
 *                                        campos, operadores, acciones).
 *   GET    /api/rules?module=          → lista de reglas (opcionalmente por módulo).
 *   POST   /api/rules                  → crear (validada contra el registro).
 *   PUT    /api/rules/:id              → actualizar.
 *   DELETE /api/rules/:id              → eliminar.
 *   POST   /api/rules/evaluate         → dry-run: evalúa una regla (o el id de
 *                                        una guardada) contra un contexto de prueba.
 *
 * Toda la lógica de campos/operadores/acciones vive en services/ruleEngine.js.
 * Gobernado por el permiso 'reglas' (sección admin).
 */
const router = require('express').Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const engine = require('../services/ruleEngine');
const runtime = require('../services/ruleRuntime');

router.use(authenticate);

// Normaliza una fila de BD (parsea los JSON) a objeto de dominio.
function parseRow(r) {
  const parse = (v, def) => {
    if (v == null) return def;
    if (typeof v === 'object') return v; // el driver ya puede devolver JSON parseado
    try { return JSON.parse(v); } catch { return def; }
  };
  return {
    id: r.id, name: r.name, module: r.module, description: r.description,
    match_type: r.match_type, conditions: parse(r.conditions, []),
    action_type: r.action_type, action_params: parse(r.action_params, {}),
    priority: r.priority, active: !!r.active,
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
    created_by_name: r.created_by_name || null,
  };
}

// ── Esquema para el builder ────────────────────────────────────
router.get('/schema', requirePermission('reglas', 'view'), (req, res) => {
  res.json(engine.getSchema());
});

// ── Listar reglas ──────────────────────────────────────────────
router.get('/', requirePermission('reglas', 'view'), async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.module) {
      if (!engine.MODULE_KEYS.includes(req.query.module)) return res.status(400).json({ error: 'Módulo inválido' });
      where = 'WHERE r.module = ?'; params.push(req.query.module);
    }
    const [rows] = await sequelize.query(`
      SELECT r.*, u.full_name AS created_by_name
      FROM condition_rules r
      LEFT JOIN users u ON u.id = r.created_by
      ${where}
      ORDER BY r.module, r.priority, r.id
    `, { replacements: params });
    res.json(rows.map(parseRow));
  } catch (e) { next(e); }
});

// Construye el payload de regla desde el body (con defaults saneados).
function ruleFromBody(body) {
  return {
    name: String(body.name || '').trim(),
    module: body.module,
    description: body.description ? String(body.description).slice(0, 500) : null,
    match_type: body.match_type === 'any' ? 'any' : 'all',
    conditions: Array.isArray(body.conditions) ? body.conditions : [],
    action_type: body.action_type,
    action_params: body.action_params && typeof body.action_params === 'object' ? body.action_params : {},
    priority: Number.isFinite(+body.priority) ? parseInt(body.priority, 10) : 100,
    active: body.active === undefined ? 1 : (body.active ? 1 : 0),
  };
}

// ── Crear ──────────────────────────────────────────────────────
router.post('/', requirePermission('reglas', 'create'), async (req, res, next) => {
  try {
    const rule = ruleFromBody(req.body || {});
    const { valid, errors } = engine.validateRule(rule);
    if (!valid) return res.status(400).json({ error: 'Regla inválida', errors });
    const [r] = await sequelize.query(
      `INSERT INTO condition_rules
         (name, module, description, match_type, conditions, action_type, action_params, priority, active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      { replacements: [
        rule.name, rule.module, rule.description, rule.match_type,
        JSON.stringify(rule.conditions), rule.action_type, JSON.stringify(rule.action_params),
        rule.priority, rule.active, req.user?.id || null,
      ] }
    );
    audit.log({ req, user: req.user, action: 'rule_create', entity: 'condition_rules',
      entity_id: r.insertId, details: { name: rule.name, module: rule.module } });
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

// ── Actualizar ─────────────────────────────────────────────────
router.put('/:id', requirePermission('reglas', 'update'), async (req, res, next) => {
  try {
    const rule = ruleFromBody(req.body || {});
    const { valid, errors } = engine.validateRule(rule);
    if (!valid) return res.status(400).json({ error: 'Regla inválida', errors });
    const [r] = await sequelize.query(
      `UPDATE condition_rules SET
         name=?, module=?, description=?, match_type=?, conditions=?, action_type=?, action_params=?, priority=?, active=?
       WHERE id=?`,
      { replacements: [
        rule.name, rule.module, rule.description, rule.match_type,
        JSON.stringify(rule.conditions), rule.action_type, JSON.stringify(rule.action_params),
        rule.priority, rule.active, req.params.id,
      ] }
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Regla no encontrada' });
    audit.log({ req, user: req.user, action: 'rule_update', entity: 'condition_rules',
      entity_id: req.params.id, details: { name: rule.name, module: rule.module } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Eliminar ───────────────────────────────────────────────────
router.delete('/:id', requirePermission('reglas', 'delete'), async (req, res, next) => {
  try {
    const [r] = await sequelize.query('DELETE FROM condition_rules WHERE id = ?', { replacements: [req.params.id] });
    if (!r.affectedRows) return res.status(404).json({ error: 'Regla no encontrada' });
    audit.log({ req, user: req.user, action: 'rule_delete', entity: 'condition_rules', entity_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Dry-run: probar una regla contra un contexto ───────────────
// body: { rule?, id?, context }. Si viene `id`, carga la regla guardada; si no,
// usa `rule` del body (para probar antes de guardar).
router.post('/evaluate', requirePermission('reglas', 'view'), async (req, res, next) => {
  try {
    const { id, rule: rawRule, context } = req.body || {};
    let rule = rawRule;
    if (id) {
      const [rows] = await sequelize.query('SELECT * FROM condition_rules WHERE id = ? LIMIT 1', { replacements: [id] });
      if (!rows.length) return res.status(404).json({ error: 'Regla no encontrada' });
      rule = parseRow(rows[0]);
    } else {
      rule = ruleFromBody(rawRule || {});
      const { valid, errors } = engine.validateRule(rule);
      if (!valid) return res.status(400).json({ error: 'Regla inválida', errors });
    }
    const result = engine.evaluateRule(rule, context && typeof context === 'object' ? context : {});
    res.json(result);
  } catch (e) { next(e); }
});

// ── Alertas: evalúa las reglas ACTIVAS del módulo asistencia sobre el
// resumen diario de un período y devuelve las que disparan. Convierte el motor
// de reglas en un consumidor real (no sólo un editor). El contexto de cada día
// incluye desvíos de horario, feriado/fin de semana y la reducción vigente de
// lactancia.
router.get('/alerts', requirePermission('reglas', 'view'), async (req, res, next) => {
  try {
    const module = req.query.module || 'asistencia';
    if (module !== 'asistencia') {
      // Por ahora sólo el módulo asistencia tiene un builder de contexto real.
      return res.json({ module, total: 0, data: [], note: 'Sólo el módulo asistencia tiene evaluación sobre datos.' });
    }
    const rules = await runtime.getActiveRules('asistencia');
    if (!rules.length) return res.json({ module, total: 0, data: [], rules: 0 });

    const now = new Date();
    const from = req.query.from || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    const params = [from, to];
    let deptFilter = '';
    if (req.query.dept) { deptFilter = 'AND e.department_id = ?'; params.push(req.query.dept); }

    const [rows] = await sequelize.query(`
      SELECT e.id AS employee_id, e.code, CONCAT(e.first_name,' ',e.last_name) AS name,
             COALESCE(d.name,'') AS department,
             DATE_FORMAT(ds.date, '%Y-%m-%d') AS date,
             COALESCE(ds.worked_minutes,0)   AS worked_minutes,
             COALESCE(ds.late_minutes,0)     AS late_minutes,
             COALESCE(ds.overtime_minutes,0) AS overtime_minutes,
             ds.status,
             TIME_FORMAT(ds.first_in, '%H:%i') AS first_in,
             TIME_FORMAT(ds.last_out, '%H:%i') AS last_out,
             TIME_FORMAT(s.check_in,  '%H:%i') AS check_in,
             TIME_FORMAT(s.check_out, '%H:%i') AS check_out,
             (h.date IS NOT NULL) AS is_holiday,
             lp.reduction_minutes AS lactancia_min
      FROM daily_summary ds
      JOIN employees e ON e.id = ds.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN schedules   s ON s.id = e.schedule_id
      LEFT JOIN holidays    h ON h.date = ds.date AND h.active = 1
      LEFT JOIN lactancia_periods lp ON lp.employee_id = e.id AND lp.status = 'active'
             AND lp.start_date <= ds.date AND (lp.end_date IS NULL OR lp.end_date >= ds.date)
      WHERE ds.date BETWEEN ? AND ? ${deptFilter}
      ORDER BY ds.date DESC, name
    `, { replacements: params });

    const toMin = hm => hm ? (+hm.slice(0, 2) * 60 + +hm.slice(3, 5)) : null;
    const alerts = [];
    for (const r of rows) {
      const inM = toMin(r.first_in), outM = toMin(r.last_out);
      const ciM = toMin(r.check_in), coM = toMin(r.check_out);
      const dow = new Date(r.date + 'T00:00:00').getDay() + 1; // 1=Dom … 7=Sáb
      const context = {
        worked_minutes: r.worked_minutes,
        late_minutes: r.late_minutes,
        overtime_minutes: r.overtime_minutes,
        early_in_minutes: (inM != null && ciM != null) ? Math.max(0, ciM - inM) : 0,
        late_out_minutes: (outM != null && coM != null) ? Math.max(0, outM - coM) : 0,
        status: r.status,
        is_holiday: !!r.is_holiday,
        is_weekend: dow === 1 || dow === 7,
        dow: String(dow),
        lactancia_activa: r.lactancia_min != null,
        lactancia_reduccion_min: r.lactancia_min || 0,
      };
      const fired = runtime.evaluate(rules, context);
      for (const f of fired) {
        alerts.push({
          employee_id: r.employee_id, code: r.code, name: r.name, department: r.department,
          date: r.date, rule_id: f.rule_id, rule_name: f.rule_name,
          action_type: f.action_type, action_params: f.action_params,
        });
      }
    }

    res.json({ module, from, to, rules: rules.length, total: alerts.length, data: alerts });
  } catch (e) { next(e); }
});

module.exports = router;
