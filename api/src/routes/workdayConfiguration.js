'use strict';

/**
 * workdayConfiguration.js — FASE C API.
 *
 * CRUD de snapshots históricos de jornada/perfil y resolución efectiva por
 * empleado+fecha. No toca attendance_logs ni daily_summary.
 *
 * El modelo es deliberadamente único: "horario histórico" y "perfil laboral"
 * viven en el mismo tramo de employee_schedule_history porque comparten la
 * misma vigencia. Los endpoints /profiles son alias semánticos para clientes
 * que editan sólo la parte contractual del mismo snapshot.
 */

const router = require('express').Router();
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const svc = require('../services/workdayConfigurationService');
const audit = require('../services/audit');

router.use(authenticate);
router.use(authorize('super_admin', 'admin', 'gth', 'hr'));

const view = requirePermission('configuracion', 'view');
const update = requirePermission('configuracion', 'update');

function employeeId(req) {
  const id = Number(req.params.employeeId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('employeeId inválido');
    err.status = 400;
    err.code = 'INVALID_EMPLOYEE_ID';
    throw err;
  }
  return id;
}

function historyId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('id inválido');
    err.status = 400;
    err.code = 'INVALID_HISTORY_ID';
    throw err;
  }
  return id;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function auditSnapshot(row) {
  if (!row) return null;
  return {
    employee_id: row.employee_id,
    schedule_id: row.schedule_id ?? null,
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
    check_in: row.check_in ?? null,
    check_out: row.check_out ?? null,
    tolerance_in: row.tolerance_in ?? null,
    tolerance_out: row.tolerance_out ?? null,
    work_days: row.work_days ?? null,
    break_mode: row.break_mode ?? null,
    break_minutes: row.break_minutes ?? null,
    break_after_minutes: row.break_after_minutes ?? null,
    weekly_target_minutes: row.weekly_target_minutes ?? null,
    daily_target_minutes: row.daily_target_minutes ?? null,
    work_regime: row.work_regime ?? null,
    night_start: row.night_start ?? null,
    night_end: row.night_end ?? null,
    rounding_policy: row.rounding_policy ?? null,
    rounding_policy_version: row.rounding_policy_version ?? null,
    overtime_policy: row.overtime_policy ?? null,
    overtime_policy_version: row.overtime_policy_version ?? null,
    snapshot_version: row.snapshot_version ?? null,
  };
}

router.get('/meta', view, (_req, res) => {
  res.json({
    validity: {
      valid_from: 'inclusive',
      valid_to: 'inclusive',
      null_valid_to: 'open',
    },
    work_days: {
      convention: 'mysql_dayofweek',
      values: { 1: 'domingo', 2: 'lunes', 3: 'martes', 4: 'miércoles', 5: 'jueves', 6: 'viernes', 7: 'sábado' },
    },
    break_modes: [...svc.BREAK_MODES],
    work_regimes: [...svc.WORK_REGIMES],
    policies: {
      rounding_policy: 'named/versioned; not applied unless engine implements it explicitly',
      overtime_policy: 'named/versioned; contract excess is not automatically legal overtime',
    },
    precedence: [
      'published_shift_assignment',
      'employee_schedule_history',
      'employee_contract_trace',
      'historical_fallback',
    ],
  });
});

const listHistory = asyncHandler(async (req, res) => {
  const id = employeeId(req);
  const data = await svc.getHistory(id);
  res.json({ ok: true, employee_id: id, data });
});

const createHistory = asyncHandler(async (req, res) => {
  const id = employeeId(req);
  const created = await svc.createHistory(id, req.body || {}, req.user?.id || null);
  audit.log({
    req,
    user: req.user,
    action: 'workday_config.create',
    entity: 'employee_schedule_history',
    entity_id: created.id,
    details: {
      employee_id: id,
      valid_from: created.valid_from,
      valid_to: created.valid_to,
      schedule_id: created.schedule_id,
      snapshot_version: created.snapshot_version,
      reason: created.change_reason || null,
    },
  });
  res.status(201).json({ ok: true, data: created });
});

const updateHistory = asyncHandler(async (req, res) => {
  const id = historyId(req);
  const result = await svc.updateHistory(id, req.body || {}, req.user?.id || null);
  audit.log({
    req,
    user: req.user,
    action: 'workday_config.update',
    entity: 'employee_schedule_history',
    entity_id: id,
    details: {
      employee_id: result.after.employee_id,
      before: auditSnapshot(result.before),
      after: auditSnapshot(result.after),
      reason: req.body?.reason || req.body?.change_reason || null,
    },
  });
  res.json({ ok: true, data: result.after });
});

const closeHistory = asyncHandler(async (req, res) => {
  const id = historyId(req);
  const result = await svc.closeHistory(
    id,
    req.body?.valid_to,
    req.user?.id || null,
    req.body?.reason,
  );
  audit.log({
    req,
    user: req.user,
    action: 'workday_config.close',
    entity: 'employee_schedule_history',
    entity_id: id,
    details: {
      employee_id: result.after.employee_id,
      before_valid_to: result.before.valid_to,
      valid_to: result.after.valid_to,
      reason: req.body?.reason || null,
    },
  });
  res.json({ ok: true, data: result.after });
});

router.get('/employees/:employeeId/history', view, listHistory);
router.post('/employees/:employeeId/history', update, createHistory);
router.put('/history/:id', update, updateHistory);
router.patch('/history/:id', update, updateHistory);
router.post('/history/:id/close', update, closeHistory);

// Alias de perfil: es el mismo snapshot/vigencia, no una segunda tabla.
router.get('/employees/:employeeId/profiles', view, listHistory);
router.post('/employees/:employeeId/profiles', update, createHistory);
router.put('/profiles/:id', update, updateHistory);
router.patch('/profiles/:id', update, updateHistory);
router.post('/profiles/:id/close', update, closeHistory);

router.get('/employees/:employeeId/effective', view, asyncHandler(async (req, res) => {
  const id = employeeId(req);
  const date = String(req.query.date || '');
  const data = await svc.getEffectiveConfiguration(id, date);
  res.json({ ok: true, data });
}));

module.exports = router;
