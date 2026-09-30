/**
 * contracts.js — Ingresos / Egresos (contratos laborales).
 *
 *   GET  /api/contracts/config              → tipos y días de alerta (parametrizable)
 *   PUT  /api/contracts/config              → guardar config (admin/gth/hr)
 *   GET  /api/contracts/alerts              → contratos por vencer / fin de prueba
 *   GET  /api/contracts/employee/:id        → historial de contratos del empleado
 *   POST /api/contracts                     → alta de contrato
 *   PUT  /api/contracts/:id                 → editar contrato
 *   DELETE /api/contracts/:id               → eliminar contrato
 *   POST /api/contracts/egreso              → registrar egreso (baja del empleado)
 *
 * Gobernado por el permiso 'ingresos' (sección gestión). La config y el egreso
 * requieren RRHH/admin.
 *
 * ALCANCE POR EMPLEADO (services/departmentScope, la misma fuente que el
 * listado de empleados): los roles por sede sólo ven y operan contratos de
 * empleados de los departamentos activos de su sede; los roles globales de
 * RR.HH. conservan el acceso actual. Fuera de alcance e inexistente responden
 * el MISMO 404, sin datos del contrato ni del empleado, sin escritura y sin
 * auditoría. En PUT/DELETE el empleado se resuelve desde el contrato GUARDADO,
 * nunca desde el body.
 */
const router = require('express').Router();
const { insertId } = require('../utils/insertId');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const audit = require('../services/audit');
const { getVisibleDepartmentIds, applyDepartmentScope, canSeeEmployee, isGlobal } = require('../services/departmentScope');
const { parsePositiveId } = require('../utils/strictId');

router.use(authenticate);

const DEFAULT_TYPES = ['Indefinido', 'Plazo fijo', 'Pasantía', 'Aprendizaje', 'Temporal', 'Comisión'];

async function getConfig() {
  const [rows] = await sequelize.query(
    "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('contract_types','contract_expiry_alert_days','probation_alert_days')"
  );
  const m = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const types = String(m.contract_types || '').split(',').map(s => s.trim()).filter(Boolean);
  const expiry = parseInt(m.contract_expiry_alert_days, 10);
  const prob = parseInt(m.probation_alert_days, 10);
  return {
    contract_types: types.length ? types : DEFAULT_TYPES,
    expiry_alert_days: Number.isFinite(expiry) && expiry >= 0 ? expiry : 30,
    probation_alert_days: Number.isFinite(prob) && prob >= 0 ? prob : 7,
  };
}

// ── Config ─────────────────────────────────────────────────────
router.get('/config', requirePermission('ingresos', 'view'), async (req, res, next) => {
  try { res.json(await getConfig()); } catch (e) { next(e); }
});

router.put('/config', authorize('admin', 'super_admin', 'gth', 'hr'), async (req, res, next) => {
  try {
    const entries = {};
    if (Array.isArray(req.body.contract_types)) entries.contract_types = req.body.contract_types.join(', ');
    else if (typeof req.body.contract_types === 'string') entries.contract_types = req.body.contract_types;
    if (req.body.expiry_alert_days != null) entries.contract_expiry_alert_days = String(parseInt(req.body.expiry_alert_days, 10) || 0);
    if (req.body.probation_alert_days != null) entries.probation_alert_days = String(parseInt(req.body.probation_alert_days, 10) || 0);
    for (const [k, v] of Object.entries(entries)) {
      await sequelize.query(
        `INSERT INTO notification_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        { replacements: [k, v] }
      );
    }
    res.json({ ok: true, ...(await getConfig()) });
  } catch (e) { next(e); }
});

/**
 * ¿El empleado es visible para el alcance? Global → sí (sin consulta: el
 * handler resuelve su propio "no encontrado"). Restringido → el empleado debe
 * existir y su departamento estar en el alcance. Alcance ausente/inválido → no.
 */
async function employeeInScope(scope, employeeId) {
  if (isGlobal(scope)) return true;
  const [[emp]] = await sequelize.query(
    'SELECT department_id FROM employees WHERE id = ? LIMIT 1', { replacements: [employeeId] }
  );
  return !!emp && canSeeEmployee(scope, emp);
}

/**
 * Contrato GUARDADO + visibilidad de su empleado. Devuelve la fila sólo si el
 * contrato existe y su empleado está en el alcance; si no, null (→ 404).
 */
async function loadContractInScope(req, contractId) {
  const [[row]] = await sequelize.query(
    'SELECT id, employee_id FROM employee_contracts WHERE id = ? LIMIT 1', { replacements: [contractId] }
  );
  if (!row) return null;
  const scope = await getVisibleDepartmentIds(req.user);
  return (await employeeInScope(scope, Number(row.employee_id))) ? row : null;
}

const NOT_FOUND = { error: 'Contrato no encontrado' };
const EMP_NOT_FOUND = { error: 'Empleado no encontrado' };

// ── Alertas: contratos por vencer / fin de período de prueba ───
router.get('/alerts', requirePermission('ingresos', 'view'), async (req, res, next) => {
  try {
    const cfg = await getConfig();
    // Mismo filtro de alcance para ambas listas (global: sin filtro).
    const scoped = applyDepartmentScope('', [], await getVisibleDepartmentIds(req.user), 'e.department_id');
    const [expiring] = await sequelize.query(`
      SELECT c.id, c.employee_id, c.type, c.end_date,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code,
             DATEDIFF(c.end_date, CURDATE()) AS days_left
      FROM employee_contracts c
      JOIN employees e ON e.id = c.employee_id
      WHERE c.status = 'active' AND e.status = 'active'
        AND c.end_date IS NOT NULL
        AND c.end_date >= CURDATE()
        AND DATEDIFF(c.end_date, CURDATE()) <= ?
        ${scoped.where}
      ORDER BY c.end_date
    `, { replacements: [cfg.expiry_alert_days, ...scoped.params] });

    const [probation] = await sequelize.query(`
      SELECT c.id, c.employee_id, c.type, c.probation_end_date,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.code,
             DATEDIFF(c.probation_end_date, CURDATE()) AS days_left
      FROM employee_contracts c
      JOIN employees e ON e.id = c.employee_id
      WHERE c.status = 'active' AND e.status = 'active'
        AND c.probation_end_date IS NOT NULL
        AND c.probation_end_date >= CURDATE()
        AND DATEDIFF(c.probation_end_date, CURDATE()) <= ?
        ${scoped.where}
      ORDER BY c.probation_end_date
    `, { replacements: [cfg.probation_alert_days, ...scoped.params] });

    res.json({ config: cfg, expiring, probation });
  } catch (e) { next(e); }
});

// ── Historial de contratos de un empleado ──────────────────────
router.get('/employee/:id', requirePermission('ingresos', 'view'), async (req, res, next) => {
  try {
    const employeeId = parsePositiveId(req.params.id);
    if (employeeId === null) return res.status(400).json({ error: 'Identificador de empleado inválido' });
    if (!(await employeeInScope(await getVisibleDepartmentIds(req.user), employeeId))) {
      return res.status(404).json(EMP_NOT_FOUND);
    }
    const [rows] = await sequelize.query(`
      SELECT c.*, u.full_name AS created_by_name
      FROM employee_contracts c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.employee_id = ?
      ORDER BY c.start_date DESC, c.id DESC
    `, { replacements: [employeeId] });
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});

function contractFromBody(body) {
  const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
  return {
    // Id canónico (utils/strictId): '1e2', '0x10', '7abc' → null → 400.
    employee_id: parsePositiveId(body.employee_id),
    type: String(body.type || '').trim(),
    start_date: body.start_date || null,
    end_date: body.end_date || null,
    probation_end_date: body.probation_end_date || null,
    salary: num(body.salary),
    status: body.status === 'ended' ? 'ended' : 'active',
    note: body.note ? String(body.note).slice(0, 255) : null,
  };
}

function validateContract(c) {
  if (!c.employee_id) return 'employee_id requerido';
  if (!c.type) return 'Tipo de contrato requerido';
  if (!c.start_date) return 'Fecha de inicio requerida';
  if (c.end_date && c.end_date < c.start_date) return 'La fecha de fin no puede ser anterior al inicio';
  if (c.probation_end_date && c.probation_end_date < c.start_date) return 'El fin de prueba no puede ser anterior al inicio';
  return null;
}

// ── Alta ───────────────────────────────────────────────────────
router.post('/', requirePermission('ingresos', 'create'), async (req, res, next) => {
  try {
    const c = contractFromBody(req.body || {});
    const err = validateContract(c);
    if (err) return res.status(400).json({ error: err });
    // El empleado del body debe estar en el alcance ANTES de escribir.
    if (!(await employeeInScope(await getVisibleDepartmentIds(req.user), c.employee_id))) {
      return res.status(404).json(EMP_NOT_FOUND);
    }
    const [r] = await sequelize.query(
      `INSERT INTO employee_contracts
         (employee_id, type, start_date, end_date, probation_end_date, salary, status, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      { replacements: [c.employee_id, c.type, c.start_date, c.end_date, c.probation_end_date, c.salary, c.status, c.note, req.user?.id || null] }
    );
    audit.log({ req, user: req.user, action: 'contract_create', entity: 'employee_contracts', entity_id: insertId(r), details: { employee_id: c.employee_id, type: c.type } });
    res.status(201).json({ id: insertId(r) });
  } catch (e) { next(e); }
});

// ── Editar ─────────────────────────────────────────────────────
router.put('/:id', requirePermission('ingresos', 'update'), async (req, res, next) => {
  try {
    const contractId = parsePositiveId(req.params.id);
    if (contractId === null) return res.status(400).json({ error: 'Identificador de contrato inválido' });
    const body = req.body || {};
    // El empleado sale del contrato GUARDADO. El body puede repetirlo (la web
    // reenvía la fila), pero no cambiarlo: un valor distinto es 400 y nunca
    // se usa para decidir el alcance.
    const stored = await loadContractInScope(req, contractId);
    if (!stored) return res.status(404).json(NOT_FOUND);
    const c = contractFromBody({ ...body, employee_id: stored.employee_id });
    if (body.employee_id !== undefined && body.employee_id !== null && body.employee_id !== '') {
      const claimed = parsePositiveId(body.employee_id);
      if (claimed === null || claimed !== Number(stored.employee_id)) {
        return res.status(400).json({ error: 'El contrato no puede cambiar de empleado' });
      }
    }
    const err = validateContract(c);
    if (err) return res.status(400).json({ error: err });
    const [r] = await sequelize.query(
      `UPDATE employee_contracts SET
         type=?, start_date=?, end_date=?, probation_end_date=?, salary=?, status=?, note=?
       WHERE id=? AND employee_id=?`,
      { replacements: [c.type, c.start_date, c.end_date, c.probation_end_date, c.salary, c.status, c.note, contractId, stored.employee_id] }
    );
    if (!r.affectedRows) return res.status(404).json(NOT_FOUND);
    audit.log({ req, user: req.user, action: 'contract_update', entity: 'employee_contracts', entity_id: contractId, details: { employee_id: Number(stored.employee_id) } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Eliminar ───────────────────────────────────────────────────
router.delete('/:id', requirePermission('ingresos', 'delete'), async (req, res, next) => {
  try {
    const contractId = parsePositiveId(req.params.id);
    if (contractId === null) return res.status(400).json({ error: 'Identificador de contrato inválido' });
    const stored = await loadContractInScope(req, contractId);
    if (!stored) return res.status(404).json(NOT_FOUND);
    const [r] = await sequelize.query(
      'DELETE FROM employee_contracts WHERE id = ? AND employee_id = ?',
      { replacements: [contractId, stored.employee_id] }
    );
    if (!r.affectedRows) return res.status(404).json(NOT_FOUND);
    audit.log({ req, user: req.user, action: 'contract_delete', entity: 'employee_contracts', entity_id: contractId, details: { employee_id: Number(stored.employee_id) } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Egreso: baja del empleado + cierre de contratos vigentes ───
router.post('/egreso', authorize('admin', 'super_admin', 'gth', 'hr'), requirePermission('ingresos', 'update'), async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { employee_id, termination_date, reason } = req.body || {};
    if (!employee_id || !termination_date) {
      await t.rollback(); return res.status(400).json({ error: 'employee_id y termination_date requeridos' });
    }
    const [r] = await sequelize.query(
      `UPDATE employees SET status='inactive', termination_date=?, termination_reason=? WHERE id=?`,
      { replacements: [termination_date, reason || null, employee_id], transaction: t }
    );
    if (!r.affectedRows) { await t.rollback(); return res.status(404).json({ error: 'Empleado no encontrado' }); }
    // Cerrar contratos vigentes; fijar fin en la fecha de egreso si no tenían.
    await sequelize.query(
      `UPDATE employee_contracts
         SET status='ended', end_date = COALESCE(end_date, ?)
       WHERE employee_id=? AND status='active'`,
      { replacements: [termination_date, employee_id], transaction: t }
    );
    await t.commit();
    // La auditoría no serializa el motivo (texto libre): sólo deja constancia de
    // que se dio uno. El motivo queda en la columna employees.termination_reason.
    audit.log({ req, user: req.user, action: 'employee_egreso', entity: 'employees', entity_id: employee_id, details: { termination_date, reason_provided: !!reason } });
    res.json({ ok: true });
  } catch (e) { await t.rollback(); next(e); }
});

module.exports = router;
