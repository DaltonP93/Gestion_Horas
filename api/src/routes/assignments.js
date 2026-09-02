/**
 * assignments.js — historial de asignación organizativa con vigencia efectiva.
 * FASE F2.
 *
 *   GET  /api/assignments/employee/:id   historial del empleado (view 'asignaciones')
 *   POST /api/assignments/employee/:id   nueva vigencia (append-only, writer fail-closed)
 *
 * Append-only: crear una vigencia cierra la anterior sin borrarla. Escrituras
 * detrás de PEOPLE_WRITE_ENABLED (fail-closed) + permiso granular + validación
 * + auditoría con correlation id (remuneración de referencia redactada).
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const people = require('../services/people');
const audit = require('../services/audit');
const { redactDetails } = require('../utils/redact');

router.use(authenticate);

const createSchema = Joi.object({
  branch_id:        Joi.number().integer().positive().allow(null),
  department_id:    Joi.number().integer().positive().allow(null),
  cost_center_id:   Joi.number().integer().positive().allow(null),
  job_title:        Joi.string().trim().max(100).allow(null, ''),
  reference_salary: Joi.number().min(0).allow(null),
  valid_from:       Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  change_reason:    Joi.string().trim().max(500).allow(null, ''),
});

function employeeIdParam(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'employee id inválido' });
    return null;
  }
  return id;
}

router.get('/employee/:id', requirePermission('asignaciones', 'view'), asyncHandler(async (req, res) => {
  const id = employeeIdParam(req, res);
  if (id == null) return;
  res.json({ employee_id: id, data: await people.listAssignments(id) });
}));

router.post('/employee/:id', requirePermission('asignaciones', 'create'), validate(createSchema), asyncHandler(async (req, res) => {
  people.assertWriteEnabled();
  const id = employeeIdParam(req, res);
  if (id == null) return;
  const result = await people.createAssignment(id, req.body, req.user?.id || null);
  audit.log({
    req, user: req.user,
    action: 'assignment.create', entity: 'employee_assignment', entity_id: result.id,
    details: redactDetails({
      employee_id: id,
      valid_from: req.body.valid_from,
      closed_previous: result.closed_previous,
      after: {
        branch_id: req.body.branch_id ?? null,
        department_id: req.body.department_id ?? null,
        cost_center_id: req.body.cost_center_id ?? null,
        job_title: req.body.job_title ?? null,
        reference_salary: req.body.reference_salary ?? null,
      },
      reason: req.body.change_reason || null,
    }),
  });
  res.status(201).json({ ok: true, ...result });
}));

module.exports = router;
