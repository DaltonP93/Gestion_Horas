'use strict';

/**
 * faseE.js — CONSOLA DE ACTIVACIÓN GUIADA de FASE E (rollout del motor de jornada).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DOBLE COMPUERTA (defensa en profundidad) para TODO lo mutante
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   (a) RBAC: `requireSuperAdmin` en TODA la ruta (lectura y mutante). Sin
 *       bypass de admin/gth.
 *   (b) master-flag: env `FASE_E_ACTIVATION_ENABLED`. Con el flag apagado (el
 *       default en todos lados, incluido el repo), TODA acción mutante responde
 *       503 y sólo funciona lo de SOLO LECTURA. Además, cada acción mutante
 *       exige confirmación TIPEADA y, cuando corresponde, confirmación de backup.
 *
 * SOLO LECTURA (siempre disponible para super_admin):
 *   GET  /status            estado de migraciones, cerrojos y GO/NO-GO
 *   POST /impact            impacto dry-run legacy vs motor (no escribe)
 *   POST /recalc/dryrun     igual que /impact, acotado al paso de recálculo
 *   GET  /batches           lotes de recálculo (para RESTORE)
 *
 * MUTANTE (doble compuerta + confirmación tipeada):
 *   POST /migrations/apply  corre el runner real acotado a 075
 *   POST /forward/enable     flip del setting fase_e_forward_enabled → true
 *   POST /forward/disable    flip → false (reversa segura)
 *   POST /recalc/apply       recálculo histórico acotado, con respaldo previo
 *   POST /recalc/restore     restaura un lote por batch_id
 *
 * El PRIMER click real en producción lo da el dueño: nada acá activa nada por sí
 * solo. No conoce ATT2000. Auditoría SIN PII (ids/acciones/rango/batch/counts).
 */

const router = require('express').Router();
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const svc = require('../services/faseEConsoleService');
const audit = require('../services/audit');

// (a) RBAC estricto: sólo super_admin, para lectura Y mutación.
router.use(authenticate);
router.use(requireSuperAdmin);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// (b) master-flag: 503 fail-closed. SÓLO se aplica a endpoints mutantes.
function requireActivation(req, res, next) {
  if (!svc.isActivationEnabled()) {
    return res.status(503).json({
      error: 'FASE E deshabilitada: el master-flag FASE_E_ACTIVATION_ENABLED no está en "true". '
        + 'Sólo funcionan los endpoints de solo lectura.',
      code: 'FASE_E_ACTIVATION_DISABLED',
    });
  }
  next();
}

// Confirmación TIPEADA: el body.confirm debe coincidir EXACTAMENTE con la frase.
function requireTypedConfirm(expected) {
  return (req, res, next) => {
    const got = String(req.body?.confirm ?? '').trim();
    if (got !== expected) {
      return res.status(400).json({
        error: `Confirmación tipeada requerida: escribí exactamente "${expected}".`,
        code: 'TYPED_CONFIRM_REQUIRED',
        expected,
      });
    }
    next();
  };
}

// Confirmación explícita de BACKUP verificable antes de cualquier sobrescritura.
function requireBackupConfirmed(req, res, next) {
  if (req.body?.backup_confirmed !== true) {
    return res.status(400).json({
      error: 'Debés confirmar un backup verificable (backup_confirmed=true) antes de este paso.',
      code: 'BACKUP_CONFIRMATION_REQUIRED',
    });
  }
  next();
}

function auditLog(req, action, details) {
  audit.log({ req, user: req.user, action, entity: 'fase_e', details });
}

// ─── SOLO LECTURA ────────────────────────────────────────────────────────
router.get('/status', asyncHandler(async (req, res) => {
  const status = await svc.getStatus();
  res.json({ ok: true, ...status });
}));

router.post('/impact', asyncHandler(async (req, res) => {
  const { from, to, scope_kind, scope_id } = req.body || {};
  const report = await svc.getImpact({ from, to, scopeKind: scope_kind || 'all', scopeId: scope_id ?? null });
  res.json({ ok: true, ...report });
}));

router.post('/recalc/dryrun', asyncHandler(async (req, res) => {
  const { from, to, scope_kind, scope_id } = req.body || {};
  const report = await svc.getImpact({ from, to, scopeKind: scope_kind || 'all', scopeId: scope_id ?? null });
  res.json({ ok: true, dry_run: true, ...report });
}));

router.get('/batches', asyncHandler(async (req, res) => {
  const batches = await svc.listBatches({ limit: req.query.limit });
  res.json({ ok: true, batches });
}));

// ─── MUTANTE: migraciones (runner real, acotado a 075) ───────────────────
router.post('/migrations/apply',
  requireActivation,
  requireBackupConfirmed,
  requireTypedConfirm('APLICAR MIGRACIONES'),
  asyncHandler(async (req, res) => {
    const result = svc.applyMigrations();
    auditLog(req, 'fase_e.migrations.apply', { upto: result.upto, ok: result.ok, exit_code: result.exit_code });
    const status = await svc.getStatus();
    res.status(result.ok ? 200 : 500).json({ ok: result.ok, result, migrations: status.migrations });
  }),
);

// ─── MUTANTE: activación hacia adelante (reversible con un click) ─────────
router.post('/forward/enable',
  requireActivation,
  requireBackupConfirmed,
  requireTypedConfirm('ACTIVAR MOTOR'),
  asyncHandler(async (req, res) => {
    const state = await svc.setForwardEnabled(true);
    auditLog(req, 'fase_e.forward.enable', state);
    res.json({ ok: true, ...state });
  }),
);

router.post('/forward/disable',
  requireActivation, // reversa segura: sólo master-flag, sin backup/typed-confirm
  asyncHandler(async (req, res) => {
    const state = await svc.setForwardEnabled(false);
    auditLog(req, 'fase_e.forward.disable', state);
    res.json({ ok: true, ...state });
  }),
);

// ─── MUTANTE: recálculo histórico acotado, con respaldo previo ───────────
router.post('/recalc/apply',
  requireActivation,
  requireBackupConfirmed,
  requireTypedConfirm('RECALCULAR'),
  asyncHandler(async (req, res) => {
    const { from, to, scope_kind, scope_id } = req.body || {};
    const result = await svc.recalcApply({
      from, to, scopeKind: scope_kind || 'all', scopeId: scope_id ?? null,
      userId: req.user?.id || null,
    });
    auditLog(req, 'fase_e.recalc.apply', {
      batch_id: result.batch_id, period: result.period, scope: result.scope,
      employees: result.employees, rows_backed_up: result.rows_backed_up, rows_written: result.rows_written,
    });
    res.json({ ok: true, ...result });
  }),
);

router.post('/recalc/restore',
  requireActivation,
  requireTypedConfirm('RESTAURAR'),
  asyncHandler(async (req, res) => {
    const batchId = String(req.body?.batch_id || '').trim();
    if (!batchId) {
      return res.status(400).json({ error: 'batch_id requerido', code: 'BATCH_ID_REQUIRED' });
    }
    const result = await svc.restoreBatch({ batchId, userId: req.user?.id || null });
    auditLog(req, 'fase_e.recalc.restore', result);
    res.json({ ok: true, ...result });
  }),
);

// Manejo de errores locales del módulo (status/code de badRequest del servicio).
router.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Error en consola FASE E', code: err.code || 'FASE_E_ERROR' });
});

module.exports = router;
