/**
 * laborCalendars.js — calendarios laborales con vigencia (FASE F3).
 *
 *   GET  /api/labor-calendars                 lista (view 'calendario')
 *   GET  /api/labor-calendars/:id             detalle
 *   POST /api/labor-calendars                 crear calendario (writer fail-closed)
 *   GET  /api/labor-calendars/:id/exceptions  excepciones del calendario
 *   POST /api/labor-calendars/:id/exceptions  upsert de excepción (writer fail-closed)
 *   GET  /api/labor-calendars/:id/effective   calendario efectivo del rango (read-only)
 *   GET  /api/labor-calendars/workday/:empId  jornada vigente del empleado (READ-ONLY)
 *
 * Escrituras detrás de CALENDAR_WRITE_ENABLED (fail-closed) + permiso granular
 * + validación + auditoría con correlation id. Los GET (incluido el resolutor y
 * la lectura de jornada) son de sólo lectura y degradan si faltan migraciones.
 */

const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const calendar = require('../services/calendarService');
const orgScope = require('../services/orgScope');
const audit = require('../services/audit');
const { redactDetails } = require('../utils/redact');

router.use(authenticate);

const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = Joi.object({
  code:       Joi.string().trim().min(1).max(40).required(),
  name:       Joi.string().trim().min(1).max(200).required(),
  company_id: Joi.number().integer().positive().allow(null),
  branch_id:  Joi.number().integer().positive().allow(null),
  timezone:   Joi.string().trim().max(64).default('America/Asuncion'),
  week_start: Joi.number().integer().min(0).max(6).default(0),
  work_days:  Joi.alternatives(
                Joi.string().pattern(/^[1-7](,[1-7]){0,6}$/),
                Joi.array().items(Joi.number().integer().min(1).max(7)),
              ).allow(null, ''),
  active:     Joi.boolean().default(true),
  valid_from: DATE.required(),
  valid_to:   DATE.allow(null),
  reason:     Joi.string().trim().max(500).allow(null, ''),
});

const effectiveScopeSchema = Joi.object({
  company_id: Joi.number().integer().positive().allow(null, ''),
  branch_id:  Joi.number().integer().positive().allow(null, ''),
  from:       DATE.required(),
  to:         DATE.required(),
});

const exceptionSchema = Joi.object({
  day:   DATE.required(),
  kind:  Joi.string().valid('nonworking', 'working', 'special').required(),
  label: Joi.string().trim().max(200).allow(null, ''),
  reason: Joi.string().trim().max(500).allow(null, ''),
});

const effectiveSchema = Joi.object({
  from:      DATE.required(),
  to:        DATE.required(),
  work_days: Joi.string().pattern(/^[1-7](,[1-7]){0,6}$/).allow(null, ''),
});

function idParam(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'id inválido' }); return null; }
  return id;
}

router.get('/', requirePermission('calendario', 'view'), asyncHandler(async (req, res) => {
  const scope = await orgScope.getOrgScope(req.user);
  res.json({ data: await calendar.listCalendars(scope) });
}));

// READ-ONLY: jornada vigente de un empleado (delegada en workdayConfig).
router.get('/workday/:empId', requirePermission('calendario', 'view'), asyncHandler(async (req, res) => {
  const empId = parseInt(req.params.empId, 10);
  if (!Number.isFinite(empId) || empId <= 0) return res.status(400).json({ error: 'empId inválido' });
  const date = typeof req.query.date === 'string' ? req.query.date : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) requerido' });
  // Alcance del EMPLEADO: no se puede consultar la jornada de cualquier empleado.
  // Fuera de alcance → 404 (no se filtra existencia entre departamentos/sucursales).
  const scope = await orgScope.getOrgScope(req.user);
  if (scope && !scope.unrestricted) {
    const refs = await orgScope.loadEmployeeOrgRefs(empId);
    if (!refs || !orgScope.canSeeEmployeeRefs(scope, refs)) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
  }
  res.json({ employee_id: empId, date, ...(await calendar.readWorkdayForDate(empId, date)) });
}));

// Resolutor efectivo POR ALCANCE + fecha (elige la versión aplicable por día).
router.get('/effective', requirePermission('calendario', 'view'), validate(effectiveScopeSchema, 'query'), asyncHandler(async (req, res) => {
  const reqScope = {
    company_id: req.query.company_id ? Number(req.query.company_id) : null,
    branch_id: req.query.branch_id ? Number(req.query.branch_id) : null,
  };
  // El endpoint no debe aceptar empresa/sucursal AJENA al alcance del actor.
  const scope = await orgScope.getOrgScope(req.user);
  try {
    orgScope.assertCompanyInScope(scope, reqScope.company_id);
    orgScope.assertBranchInScope(scope, reqScope.branch_id);
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message, code: err.code });
  }
  try {
    res.json(await calendar.resolveEffectiveByScope(reqScope, req.query.from, req.query.to));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
}));

router.get('/:id', requirePermission('calendario', 'view'), asyncHandler(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const row = await calendar.getCalendar(id);
  const scope = await orgScope.getOrgScope(req.user);
  // Fuera de alcance → 404 (los globales sí son visibles).
  if (!row || !orgScope.canSeeCalendar(scope, row)) {
    return res.status(404).json({ error: 'Calendario no encontrado' });
  }
  res.json({ data: row });
}));

router.get('/:id/exceptions', requirePermission('calendario', 'view'), asyncHandler(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const cal = await calendar.getCalendar(id);
  const scope = await orgScope.getOrgScope(req.user);
  if (!cal || !orgScope.canSeeCalendar(scope, cal)) {
    return res.status(404).json({ error: 'Calendario no encontrado' });
  }
  res.json({ calendar_id: id, data: await calendar.listExceptions(id) });
}));

router.get('/:id/effective', requirePermission('calendario', 'view'), validate(effectiveSchema, 'query'), asyncHandler(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const scope = await orgScope.getOrgScope(req.user);
  // `undefined` (no override) → el servicio usa los work_days PERSISTIDOS del
  // calendario; un query param los sobreescribe explícitamente. El servicio
  // aplica el ALCANCE (calendario fuera de alcance → null → 404).
  const workDays = req.query.work_days
    ? String(req.query.work_days).split(',').map(Number)
    : undefined;
  try {
    const eff = await calendar.resolveEffective(id, req.query.from, req.query.to, { workDays, scope });
    if (!eff) return res.status(404).json({ error: 'Calendario no encontrado' });
    res.json({ calendar_id: id, ...eff });
  } catch (err) {
    if (/Rango|inválid|anterior/i.test(err.message)) return res.status(400).json({ error: err.message });
    throw err;
  }
}));

router.post('/', requirePermission('calendario', 'create'), validate(createSchema), asyncHandler(async (req, res) => {
  calendar.assertWriteEnabled();
  const { reason, ...data } = req.body;
  // Alcance + coherencia sucursal → empresa de las referencias del calendario.
  const scope = await orgScope.getOrgScope(req.user);
  await calendar.validateCalendarRefs(scope, data);
  let id;
  try {
    id = await calendar.createCalendar(data, req.user?.id || null);
  } catch (err) {
    if (calendar.isDupError(err)) return res.status(409).json({ error: 'Ya existe un calendario con ese código' });
    throw err;
  }
  audit.log({
    req, user: req.user,
    action: 'labor_calendar.create', entity: 'labor_calendar', entity_id: id,
    details: redactDetails({ after: { code: data.code, valid_from: data.valid_from }, reason: reason || null }),
  });
  res.status(201).json({ id });
}));

router.post('/:id/exceptions', requirePermission('calendario', 'create'), validate(exceptionSchema), asyncHandler(async (req, res) => {
  calendar.assertWriteEnabled();
  const id = idParam(req, res); if (id == null) return;
  const cal = await calendar.getCalendar(id);
  const scope = await orgScope.getOrgScope(req.user);
  // Sólo se pueden agregar excepciones a un calendario dentro del alcance (los
  // globales cuentan como visibles pero un writer scoped no debería mutarlos: se
  // exige empresa/sucursal en alcance). Fuera de alcance → 404.
  if (!cal || !orgScope.canSeeCalendar(scope, cal)) {
    return res.status(404).json({ error: 'Calendario no encontrado' });
  }
  // Un writer con alcance no puede mutar un calendario GLOBAL (que afecta a todos).
  if (scope && !scope.unrestricted && cal.company_id == null && cal.branch_id == null) {
    return res.status(403).json({ error: 'No podés modificar un calendario global', code: 'OUT_OF_SCOPE' });
  }
  const { reason, ...data } = req.body;
  await calendar.upsertException(id, data, req.user?.id || null);
  audit.log({
    req, user: req.user,
    action: 'calendar_exception.upsert', entity: 'labor_calendar', entity_id: id,
    details: redactDetails({ day: data.day, kind: data.kind, reason: reason || null }),
  });
  res.status(201).json({ ok: true });
}));

module.exports = router;
