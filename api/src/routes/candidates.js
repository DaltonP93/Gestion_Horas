/**
 * candidates.js — postulantes y conversión trazable a empleado. FASE F2.
 *
 *   GET   /api/candidates            lista (view sobre 'candidatos')
 *   GET   /api/candidates/:id        detalle
 *   POST  /api/candidates            crear    (writer fail-closed)
 *   PATCH /api/candidates/:id        actualizar (writer fail-closed)
 *   POST  /api/candidates/:id/convert  enlazar a un empleado EXISTENTE (create)
 *
 * Escrituras detrás de PEOPLE_WRITE_ENABLED (fail-closed) + permiso granular
 * en API + validación Joi + auditoría con correlation id. La conversión NO
 * fabrica empleados: exige un employee_id existente.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const people = require('../services/people');
const orgScope = require('../services/orgScope');
const audit = require('../services/audit');

router.use(authenticate);

const STATUSES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];

const createSchema = Joi.object({
  first_name:       Joi.string().trim().min(1).max(100).required(),
  last_name:        Joi.string().trim().min(1).max(100).required(),
  email:            Joi.string().trim().email().max(150).allow(null, ''),
  phone:            Joi.string().trim().max(40).allow(null, ''),
  source:           Joi.string().trim().max(60).allow(null, ''),
  position_applied: Joi.string().trim().max(100).allow(null, ''),
  status:           Joi.string().valid(...STATUSES).default('new'),
  notes:            Joi.string().trim().max(1000).allow(null, ''),
  company_id:       Joi.number().integer().positive().allow(null),
  branch_id:        Joi.number().integer().positive().allow(null),
});

const updateSchema = Joi.object({
  first_name:       Joi.string().trim().min(1).max(100),
  last_name:        Joi.string().trim().min(1).max(100),
  email:            Joi.string().trim().email().max(150).allow(null, ''),
  phone:            Joi.string().trim().max(40).allow(null, ''),
  source:           Joi.string().trim().max(60).allow(null, ''),
  position_applied: Joi.string().trim().max(100).allow(null, ''),
  status:           Joi.string().valid(...STATUSES),
  notes:            Joi.string().trim().max(1000).allow(null, ''),
  company_id:       Joi.number().integer().positive().allow(null),
  branch_id:        Joi.number().integer().positive().allow(null),
}).min(1);

const convertSchema = Joi.object({
  employee_id: Joi.number().integer().positive().required(),
  reason:      Joi.string().trim().max(500).allow(null, ''),
});

const EDITABLE = ['first_name', 'last_name', 'email', 'phone', 'source', 'position_applied', 'status', 'notes', 'company_id', 'branch_id'];

router.get('/', requirePermission('candidatos', 'view'), asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const scope = await orgScope.getOrgScope(req.user);
  res.json({ data: await people.listCandidates({ status }, scope) });
}));

router.get('/:id', requirePermission('candidatos', 'view'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const row = await people.getCandidate(id);
  // Fuera de alcance → 404 (no se filtra existencia entre empresas/sucursales).
  const scope = await orgScope.getOrgScope(req.user);
  if (!row || !orgScope.canSeeCandidateRefs(scope, row)) {
    return res.status(404).json({ error: 'Candidato no encontrado' });
  }
  res.json({ data: row });
}));

router.post('/', requirePermission('candidatos', 'create'), validate(createSchema), asyncHandler(async (req, res) => {
  people.assertWriteEnabled();
  const data = req.body;
  // Validar existencia, ALCANCE y coherencia sucursal → empresa de las
  // referencias de alcance ANTES de crear (403 fuera de alcance, 400 incoherente).
  const scope = await orgScope.getOrgScope(req.user);
  await people.validateCandidateRefs(scope, data);
  const id = await people.createCandidate(data, req.user?.id || null);
  audit.log({
    req, user: req.user,
    action: 'candidate.create', entity: 'candidate', entity_id: id,
    // Sin PII: sólo qué campos se cargaron y el estado (una etiqueta, no un dato
    // personal). Nombre/email/teléfono/notas NO se serializan en la auditoría.
    details: { fields: Object.keys(data), status: data.status || 'new' },
  });
  res.status(201).json({ id });
}));

router.patch('/:id', requirePermission('candidatos', 'update'), validate(updateSchema), asyncHandler(async (req, res) => {
  people.assertWriteEnabled();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const prev = await people.getCandidate(id);
  // Fuera de alcance → 404 (no se filtra existencia).
  const scope = await orgScope.getOrgScope(req.user);
  if (!prev || !orgScope.canSeeCandidateRefs(scope, prev)) {
    return res.status(404).json({ error: 'Candidato no encontrado' });
  }

  const fields = {};
  for (const k of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(req.body, k)) continue;
    const newVal = req.body[k];
    if (String(prev[k] ?? '') === String(newVal ?? '')) continue;
    fields[k] = newVal;
  }
  if (!Object.keys(fields).length) return res.json({ ok: true, changed: false });
  // Si se cambia el alcance, validar existencia/alcance/coherencia del NUEVO
  // alcance (403 fuera de alcance, 400 incoherente). Se evalúa el valor efectivo.
  if ('company_id' in fields || 'branch_id' in fields) {
    await people.validateCandidateRefs(scope, {
      company_id: 'company_id' in fields ? fields.company_id : prev.company_id,
      branch_id: 'branch_id' in fields ? fields.branch_id : prev.branch_id,
    });
  }
  await people.updateCandidate(id, fields);
  audit.log({
    req, user: req.user,
    action: 'candidate.update', entity: 'candidate', entity_id: id,
    // Sin PII: sólo los NOMBRES de los campos cambiados, nunca sus valores.
    details: { fields: Object.keys(fields) },
  });
  res.json({ ok: true, changed: true });
}));

router.post('/:id/convert', requirePermission('candidatos', 'create'), validate(convertSchema), asyncHandler(async (req, res) => {
  people.assertWriteEnabled();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  // Alcance: el candidato (404 si fuera de alcance) y el empleado destino
  // (403 OUT_OF_SCOPE) se verifican dentro de convertCandidate.
  const scope = await orgScope.getOrgScope(req.user);
  const result = await people.convertCandidate(id, req.body.employee_id, scope);
  audit.log({
    req, user: req.user,
    action: 'candidate.convert', entity: 'candidate', entity_id: id,
    // Sin PII ni texto libre: sólo ids y el estado de origen.
    details: { from_status: result.from_status, converted_employee_id: result.converted_employee_id },
  });
  res.json({ ok: true, ...result });
}));

module.exports = router;
