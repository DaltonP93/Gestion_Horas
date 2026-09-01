/**
 * companies.js — ABM de empresas (personas jurídicas empleadoras). FASE F1.
 *
 * Endpoints:
 *   GET    /api/companies        lista (lectura: permiso view sobre 'empresas')
 *   GET    /api/companies/:id    detalle
 *   POST   /api/companies        crear   (writer fail-closed)
 *   PATCH  /api/companies/:id    actualizar (writer fail-closed)
 *
 * Autorización EN API (no sólo UI): requirePermission('empresas', <accion>)
 * sobre user_permissions/defaults de rol. Las escrituras además exigen el
 * feature flag GOVERNANCE_WRITE_ENABLED (fail-closed) vía governance.assertWriteEnabled().
 *
 * Auditoría: cada cambio registra actor, entidad, antes/después redactado
 * (tax_id), motivo opcional, y el correlation id de la request.
 *
 * NOTA: no se expone DELETE. Una empresa referenciada por sucursales/centros
 * no debe borrarse; se desactiva (active=0). El borrado destructivo de
 * gobierno queda fuera del alcance de F1.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const governance = require('../services/governance');
const audit = require('../services/audit');
const { redactDetails } = require('../utils/redact');

router.use(authenticate);

const createSchema = Joi.object({
  code:       Joi.string().trim().min(1).max(40).required(),
  legal_name: Joi.string().trim().min(1).max(200).required(),
  trade_name: Joi.string().trim().max(200).allow(null, ''),
  tax_id:     Joi.string().trim().max(40).allow(null, ''),
  active:     Joi.boolean().default(true),
  reason:     Joi.string().trim().max(500).allow(null, ''),
});

const updateSchema = Joi.object({
  code:       Joi.string().trim().min(1).max(40),
  legal_name: Joi.string().trim().min(1).max(200),
  trade_name: Joi.string().trim().max(200).allow(null, ''),
  tax_id:     Joi.string().trim().max(40).allow(null, ''),
  active:     Joi.boolean(),
  reason:     Joi.string().trim().max(500).allow(null, ''),
}).min(1);

const EDITABLE = ['code', 'legal_name', 'trade_name', 'tax_id', 'active'];

router.get('/', requirePermission('empresas', 'view'), asyncHandler(async (_req, res) => {
  res.json({ data: await governance.listCompanies() });
}));

router.get('/:id', requirePermission('empresas', 'view'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const row = await governance.getCompany(id);
  if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ data: row });
}));

router.post('/', requirePermission('empresas', 'create'), validate(createSchema), asyncHandler(async (req, res) => {
  governance.assertWriteEnabled();
  const { reason, ...data } = req.body;
  let id;
  try {
    id = await governance.createCompany(data, req.user?.id || null);
  } catch (err) {
    if (governance.isDupError(err)) return res.status(409).json({ error: 'Ya existe una empresa con ese código' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'company.create',
    entity: 'company', entity_id: id,
    details: redactDetails({ after: data, reason: reason || null }),
  });
  res.status(201).json({ id, ...data });
}));

router.patch('/:id', requirePermission('empresas', 'update'), validate(updateSchema), asyncHandler(async (req, res) => {
  governance.assertWriteEnabled();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const prev = await governance.getCompany(id);
  if (!prev) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { reason } = req.body;
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
    await governance.updateCompany(id, fields);
  } catch (err) {
    if (governance.isDupError(err)) return res.status(409).json({ error: 'Ya existe una empresa con ese código' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'company.update',
    entity: 'company', entity_id: id,
    details: redactDetails({ diff, reason: reason || null }),
  });
  res.json({ ok: true, changed: true });
}));

module.exports = router;
