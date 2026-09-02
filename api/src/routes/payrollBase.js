/**
 * payrollBase.js — base de nómina SANDBOX NO OFICIAL (FASE F4).
 *
 *   GET  /api/payroll-base/concepts            catálogo versionado (view 'nomina')
 *   POST /api/payroll-base/concepts            crear concepto (writer fail-closed)
 *   GET  /api/payroll-base/periods             períodos
 *   GET  /api/payroll-base/periods/:id         detalle
 *   POST /api/payroll-base/periods             crear período (draft)
 *   POST /api/payroll-base/periods/:id/transition   cambiar estado (máquina de estados)
 *   GET  /api/payroll-base/periods/:id/preview previsualización NO OFICIAL
 *   GET  /api/payroll-base/analytics/headcount agregado sin PII
 *   GET  /api/payroll-base/integrations        adaptadores (todos apagados)
 *
 * NO es liquidación oficial ni pago. Escrituras detrás de PAYROLL_WRITE_ENABLED
 * (fail-closed) + permiso granular + validación + auditoría con correlation id.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requirePermission, requireGlobalHR } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const payroll = require('../services/payrollBase');
const audit = require('../services/audit');
const { redactDetails } = require('../utils/redact');
const { parseCivilDate } = require('../utils/civilDate');

router.use(authenticate);
// F4 es una base de nómina SANDBOX GLOBAL (no segmentada por empresa): expone
// conteos, preview y períodos a nivel global. Por eso, ADEMÁS del permiso de
// módulo, exige un rol GLOBAL de RR.HH. (super_admin/admin/gth/hr). Un manager,
// coordinator, supervisor, gestor o employee NO accede —ni con override—: la
// guarda decide por rol, no por user_permissions. Hasta que exista un modelo y
// aprobación explícita para nómina por empresa, no se habilita acceso segmentado.
router.use(requireGlobalHR);

// Fecha civil REAL (no sólo formato): rechaza 2025-02-29, 2026-13-01, etc.
const DATE = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((v, helpers) => (parseCivilDate(v) ? v : helpers.error('any.invalid')));

const conceptSchema = Joi.object({
  code:         Joi.string().trim().min(1).max(40).required(),
  name:         Joi.string().trim().min(1).max(200).required(),
  kind:         Joi.string().valid('earning', 'deduction').required(),
  formula_hint: Joi.string().trim().max(500).allow(null, ''),
  version:      Joi.number().integer().min(1).default(1),
  active:       Joi.boolean().default(true),
  valid_from:   DATE.required(),
  valid_to:     DATE.allow(null),
});

const periodSchema = Joi.object({
  code:         Joi.string().trim().min(1).max(40).required(),
  label:        Joi.string().trim().min(1).max(200).required(),
  period_start: DATE.required(),
  period_end:   DATE.required(),
});

const transitionSchema = Joi.object({
  to:     Joi.string().valid('draft', 'preview', 'locked', 'closed').required(),
  reason: Joi.string().trim().max(500).allow(null, ''),
});

function idParam(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'id inválido' }); return null; }
  return id;
}

// ── Conceptos ──────────────────────────────────────────────────────────────
router.get('/concepts', requirePermission('nomina', 'view'), asyncHandler(async (_req, res) => {
  res.json({ data: await payroll.listConcepts() });
}));

router.post('/concepts', requirePermission('nomina', 'create'), validate(conceptSchema), asyncHandler(async (req, res) => {
  payroll.assertWriteEnabled();
  let id;
  try {
    id = await payroll.createConcept(req.body, req.user?.id || null);
  } catch (err) {
    if (payroll.isDupError(err)) return res.status(409).json({ error: 'Ya existe ese concepto en esa versión' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'payroll_concept.create', entity: 'payroll_concept', entity_id: id,
    details: redactDetails({ code: req.body.code, kind: req.body.kind, version: req.body.version ?? 1 }),
  });
  res.status(201).json({ id });
}));

// ── Períodos ───────────────────────────────────────────────────────────────
router.get('/periods', requirePermission('nomina', 'view'), asyncHandler(async (_req, res) => {
  res.json({ data: await payroll.listPeriods() });
}));

router.get('/periods/:id', requirePermission('nomina', 'view'), asyncHandler(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const row = await payroll.getPeriod(id);
  if (!row) return res.status(404).json({ error: 'Período no encontrado' });
  res.json({ data: row });
}));

router.get('/periods/:id/preview', requirePermission('nomina', 'view'), asyncHandler(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  res.json(await payroll.computePreview(id));
}));

// Evidencia de cierre (sólo lectura): snapshot AGREGADO persistido al cerrar
// (sin PII). 404 si el período no tiene snapshot (no cerrado / no generado).
router.get('/periods/:id/snapshot', requirePermission('nomina', 'view'), asyncHandler(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const snap = await payroll.getSnapshot(id);
  if (!snap) return res.status(404).json({ error: 'Snapshot no encontrado' });
  res.json({ official: false, ...snap });
}));

router.post('/periods', requirePermission('nomina', 'create'), validate(periodSchema), asyncHandler(async (req, res) => {
  payroll.assertWriteEnabled();
  let id;
  try {
    id = await payroll.createPeriod(req.body, req.user?.id || null);
  } catch (err) {
    if (payroll.isDupError(err)) return res.status(409).json({ error: 'Ya existe un período con ese código' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'payroll_period.create', entity: 'payroll_period', entity_id: id,
    details: redactDetails({ code: req.body.code, period_start: req.body.period_start, period_end: req.body.period_end }),
  });
  res.status(201).json({ id, status: 'draft', is_official: 0 });
}));

router.post('/periods/:id/transition', requirePermission('nomina', 'update'), validate(transitionSchema), asyncHandler(async (req, res) => {
  payroll.assertWriteEnabled();
  const id = idParam(req, res); if (id == null) return;
  const result = await payroll.transition(id, req.body.to, req.user?.id || null);
  audit.log({
    req, user: req.user,
    action: 'payroll_period.transition', entity: 'payroll_period', entity_id: id,
    details: redactDetails({ to: req.body.to, reason: req.body.reason || null, snapshot_created: !!result.snapshot_created }),
  });
  res.json({ ok: true, ...result });
}));

// ── Analytics agregado (sin PII) ─────────────────────────────────────────────
router.get('/analytics/headcount', requirePermission('nomina', 'view'), asyncHandler(async (_req, res) => {
  res.json({ official: false, ...(await payroll.headcount()), concepts: await payroll.conceptCounts() });
}));

// ── Integraciones (todas apagadas en F4) ─────────────────────────────────────
router.get('/integrations', requirePermission('nomina', 'view'), asyncHandler(async (_req, res) => {
  res.json({ note: 'Adaptadores planificados; ninguno habilitado en esta etapa.', data: payroll.integrationsStatus() });
}));

module.exports = router;
