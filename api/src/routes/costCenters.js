/**
 * costCenters.js — ABM de centros de costo. FASE F1.
 *
 * Endpoints:
 *   GET    /api/cost-centers        lista (permiso view sobre 'centros_costo')
 *   GET    /api/cost-centers/:id    detalle
 *   POST   /api/cost-centers        crear   (writer fail-closed)
 *   PATCH  /api/cost-centers/:id    actualizar (writer fail-closed)
 *
 * Igual postura que /api/companies: autorización granular en API, escrituras
 * detrás de GOVERNANCE_WRITE_ENABLED (fail-closed), validación Joi y auditoría
 * con correlation id. `company_id` es opcional; si viene, debe existir.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const governance = require('../services/governance');
const orgScope = require('../services/orgScope');
const audit = require('../services/audit');
const { redactDetails } = require('../utils/redact');

router.use(authenticate);

const createSchema = Joi.object({
  company_id: Joi.number().integer().positive().allow(null),
  code:       Joi.string().trim().min(1).max(40).required(),
  name:       Joi.string().trim().min(1).max(200).required(),
  active:     Joi.boolean().default(true),
  reason:     Joi.string().trim().max(500).allow(null, ''),
});

const updateSchema = Joi.object({
  company_id: Joi.number().integer().positive().allow(null),
  code:       Joi.string().trim().min(1).max(40),
  name:       Joi.string().trim().min(1).max(200),
  active:     Joi.boolean(),
  reason:     Joi.string().trim().max(500).allow(null, ''),
}).min(1);

const EDITABLE = ['company_id', 'code', 'name', 'active'];

router.get('/', requirePermission('centros_costo', 'view'), asyncHandler(async (req, res) => {
  const scope = await orgScope.getOrgScope(req.user);
  res.json({ data: await governance.listCostCenters(scope) });
}));

router.get('/:id', requirePermission('centros_costo', 'view'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const scope = await orgScope.getOrgScope(req.user);
  const row = await governance.getCostCenter(id, scope);
  if (!row) return res.status(404).json({ error: 'Centro de costo no encontrado' });
  res.json({ data: row });
}));

router.post('/', requirePermission('centros_costo', 'create'), validate(createSchema), asyncHandler(async (req, res) => {
  governance.assertWriteEnabled();
  const { reason, ...data } = req.body;
  // Alcance: rechaza referenciar una empresa fuera del alcance del usuario.
  orgScope.assertCompanyInScope(await orgScope.getOrgScope(req.user), data.company_id ?? null);
  if (data.company_id != null && !(await governance.companyExists(data.company_id))) {
    return res.status(400).json({ error: 'company_id no corresponde a una empresa existente' });
  }
  let id;
  try {
    id = await governance.createCostCenter(data, req.user?.id || null);
  } catch (err) {
    if (governance.isDupError(err)) return res.status(409).json({ error: 'Ya existe un centro de costo con ese código' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'cost_center.create',
    entity: 'cost_center', entity_id: id,
    details: redactDetails({ after: data, reason: reason || null }),
  });
  res.status(201).json({ id, ...data });
}));

router.patch('/:id', requirePermission('centros_costo', 'update'), validate(updateSchema), asyncHandler(async (req, res) => {
  governance.assertWriteEnabled();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const scope = await orgScope.getOrgScope(req.user);
  const prev = await governance.getCostCenter(id, scope);
  if (!prev) return res.status(404).json({ error: 'Centro de costo no encontrado' });

  const { reason } = req.body;
  if (Object.prototype.hasOwnProperty.call(req.body, 'company_id')) {
    // Alcance: no permitir reasignar a una empresa fuera del alcance.
    orgScope.assertCompanyInScope(scope, req.body.company_id ?? null);
    if (req.body.company_id != null && !(await governance.companyExists(req.body.company_id))) {
      return res.status(400).json({ error: 'company_id no corresponde a una empresa existente' });
    }
  }

  const diff = {};
  const fields = {};
  for (const k of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(req.body, k)) continue;
    const newVal = k === 'active' ? (req.body[k] ? 1 : 0) : req.body[k];
    if (String(prev[k] ?? '') === String(newVal ?? '')) continue;
    fields[k] = newVal;
    diff[k] = { from: prev[k], to: newVal };
  }
  if (!Object.keys(fields).length) return res.json({ ok: true, changed: false });

  try {
    await governance.updateCostCenter(id, fields);
  } catch (err) {
    if (governance.isDupError(err)) return res.status(409).json({ error: 'Ya existe un centro de costo con ese código' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'cost_center.update',
    entity: 'cost_center', entity_id: id,
    details: redactDetails({ diff, reason: reason || null }),
  });
  res.json({ ok: true, changed: true });
}));

module.exports = router;
