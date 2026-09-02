'use strict';

/**
 * payrollBase.js — FASE F4. BASE de nómina, SANDBOX NO OFICIAL.
 *
 * Provee conceptos versionados, períodos con máquina de estados y snapshots de
 * cierre. NO calcula liquidación oficial, NO evalúa fórmulas, NO paga ni
 * integra con IPS/MTESS/bancos. Todo período es `is_official = 0`.
 *
 * Kill switch fail-closed: `PAYROLL_WRITE_ENABLED` (sólo "true" habilita).
 *
 * INMUTABILIDAD: un período 'closed' es terminal; toda escritura sobre él se
 * rechaza. Al cerrar se persiste un snapshot AGREGADO para trazabilidad, de
 * modo que modificaciones posteriores no cambien lo ya cerrado.
 */

const { sequelize } = require('../config/database');

// Transiciones permitidas de la máquina de estados.
const TRANSITIONS = {
  draft:   ['preview'],
  preview: ['draft', 'locked'],
  locked:  ['preview', 'closed'],
  closed:  [],
};

// Adaptadores de integración futura — TODOS apagados en F4. Cada uno lee su
// propio flag; ausencia/valor != "true" ⇒ deshabilitado (fail-closed).
const INTEGRATION_ADAPTERS = [
  { key: 'ips',           label: 'IPS (aportes)',            flag: 'IPS_INTEGRATION_ENABLED' },
  { key: 'mtess_reop',    label: 'MTESS / REOP',             flag: 'MTESS_INTEGRATION_ENABLED' },
  { key: 'firma',         label: 'Firma electrónica',        flag: 'ESIGN_INTEGRATION_ENABLED' },
  { key: 'bancos',        label: 'Pagos bancarios',          flag: 'BANK_INTEGRATION_ENABLED' },
  { key: 'notificaciones', label: 'Notificaciones multicanal', flag: 'MULTICHANNEL_NOTIF_ENABLED' },
  { key: 'pagos',         label: 'Pasarela de pagos',        flag: 'PAYMENTS_INTEGRATION_ENABLED' },
];

function isWriteEnabled() {
  return process.env.PAYROLL_WRITE_ENABLED === 'true';
}
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
function assertWriteEnabled() {
  if (isWriteEnabled()) return;
  throw httpError(503, 'PAYROLL_WRITES_DISABLED', 'La base de nómina está en modo sólo lectura durante el rollout');
}
function isDupError(err) {
  return String(err?.original?.code || err?.parent?.code || '').startsWith('ER_DUP');
}

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function integrationsStatus() {
  return INTEGRATION_ADAPTERS.map((a) => ({
    key: a.key, label: a.label,
    enabled: process.env[a.flag] === 'true', // en F4: siempre false por defecto
    flag: a.flag,
  }));
}

// ─── Conceptos (versionados) ────────────────────────────────────────────────

async function listConcepts() {
  const [rows] = await sequelize.query(
    `SELECT id, code, name, kind, formula_hint, version, active, valid_from, valid_to
       FROM payroll_concepts ORDER BY code, version DESC`,
  );
  return rows;
}

async function createConcept(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO payroll_concepts (code, name, kind, formula_hint, version, active, valid_from, valid_to, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [
      data.code, data.name, data.kind, data.formula_hint ?? null,
      data.version ?? 1, data.active ? 1 : 0, data.valid_from, data.valid_to ?? null, userId ?? null,
    ] },
  );
  return result.insertId;
}

// ─── Períodos ───────────────────────────────────────────────────────────────

async function listPeriods() {
  const [rows] = await sequelize.query(
    `SELECT id, code, label, period_start, period_end, status, is_official, closed_at
       FROM payroll_periods ORDER BY period_start DESC`,
  );
  return rows;
}

async function getPeriod(id) {
  const [rows] = await sequelize.query(
    `SELECT id, code, label, period_start, period_end, status, is_official, closed_at
       FROM payroll_periods WHERE id = ? LIMIT 1`,
    { replacements: [id] },
  );
  return rows[0] || null;
}

async function createPeriod(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO payroll_periods (code, label, period_start, period_end, status, is_official, created_by)
     VALUES (?, ?, ?, ?, 'draft', 0, ?)`,
    { replacements: [data.code, data.label, data.period_start, data.period_end, userId ?? null] },
  );
  return result.insertId;
}

/** Cuenta agregada de empleados activos (sin PII) para el snapshot/preview. */
async function headcount() {
  const [rows] = await sequelize.query(
    "SELECT status, COUNT(*) AS n FROM employees GROUP BY status",
  );
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return { by_status: byStatus, active: byStatus.active || 0 };
}

async function conceptCounts() {
  const [rows] = await sequelize.query(
    "SELECT kind, COUNT(*) AS n FROM payroll_concepts WHERE active = 1 GROUP BY kind",
  );
  const m = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  return { earnings: m.earning || 0, deductions: m.deduction || 0 };
}

/**
 * Previsualización SANDBOX. Devuelve un resumen AGREGADO explícitamente marcado
 * como NO OFICIAL. No calcula montos ni liquidación: hacerlo requeriría fuente
 * normativa verificable y aprobación humana.
 */
async function computePreview(periodId) {
  const period = await getPeriod(periodId);
  if (!period) throw httpError(404, 'PERIOD_NOT_FOUND', 'Período no encontrado');
  const [hc, cc] = await Promise.all([headcount(), conceptCounts()]);
  return {
    official: false,
    disclaimer: 'PREVISUALIZACIÓN NO OFICIAL. No es una liquidación legal ni un cálculo de haberes.',
    period: { id: period.id, code: period.code, status: period.status },
    headcount: hc,
    active_concepts: cc,
  };
}

/**
 * Cambia el estado del período respetando la máquina de estados. Al cerrar,
 * persiste un snapshot agregado. Un período cerrado es inmutable.
 */
async function transition(periodId, to, userId) {
  const period = await getPeriod(periodId);
  if (!period) throw httpError(404, 'PERIOD_NOT_FOUND', 'Período no encontrado');
  if (period.status === 'closed') {
    throw httpError(409, 'PERIOD_CLOSED', 'El período está cerrado y no puede modificarse');
  }
  if (!canTransition(period.status, to)) {
    throw httpError(400, 'INVALID_TRANSITION', `Transición no permitida: ${period.status} → ${to}`);
  }

  if (to === 'closed') {
    const [hc, cc] = await Promise.all([headcount(), conceptCounts()]);
    const snapshot = {
      closed_from: period.status,
      period: { id: period.id, code: period.code, period_start: period.period_start, period_end: period.period_end },
      headcount: hc,
      active_concepts: cc,
      official: false,
    };
    const tx = await sequelize.transaction();
    try {
      await sequelize.query(
        "UPDATE payroll_periods SET status = 'closed', closed_at = NOW(), closed_by = ? WHERE id = ? AND status <> 'closed'",
        { replacements: [userId ?? null, periodId], transaction: tx },
      );
      await sequelize.query(
        'INSERT INTO payroll_period_snapshots (period_id, snapshot_json, created_by) VALUES (?, ?, ?)',
        { replacements: [periodId, JSON.stringify(snapshot), userId ?? null], transaction: tx },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    return { id: periodId, status: 'closed', snapshot_created: true };
  }

  await sequelize.query(
    'UPDATE payroll_periods SET status = ? WHERE id = ?',
    { replacements: [to, periodId] },
  );
  return { id: periodId, status: to };
}

module.exports = {
  TRANSITIONS,
  isWriteEnabled,
  assertWriteEnabled,
  isDupError,
  canTransition,
  integrationsStatus,
  listConcepts,
  createConcept,
  listPeriods,
  getPeriod,
  createPeriod,
  headcount,
  conceptCounts,
  computePreview,
  transition,
};
