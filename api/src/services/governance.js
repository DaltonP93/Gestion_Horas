'use strict';

/**
 * governance.js — FASE F1.
 *
 * Backend de las entidades de gobierno organizacional: `companies` (empresas)
 * y `cost_centers` (centros de costo). Aísla el SQL para que las rutas queden
 * finas y el servicio sea testeable con `sequelize.query` mockeado.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * KILL SWITCH DE ESCRITURA (fail-closed)
 * ─────────────────────────────────────────────────────────────────────────
 * Todo writer nuevo del programa nace apagado. `GOVERNANCE_WRITE_ENABLED`
 * habilita las escrituras SÓLO con el string exacto "true"; ausencia, "false",
 * "1", "TRUE", etc. mantienen el módulo en sólo lectura. Los GET no dependen
 * del switch. Esto es rollout seguro: se despliega el código y se revisa en
 * lectura antes de permitir cambios.
 */

const { sequelize } = require('../config/database');

function isWriteEnabled() {
  return process.env.GOVERNANCE_WRITE_ENABLED === 'true';
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function assertWriteEnabled() {
  if (isWriteEnabled()) return;
  throw httpError(
    503,
    'GOVERNANCE_WRITES_DISABLED',
    'La configuración de gobierno está en modo sólo lectura durante el rollout',
  );
}

function isDupError(err) {
  return String(err?.original?.code || err?.parent?.code || '').startsWith('ER_DUP');
}

// ─── Companies ────────────────────────────────────────────────────────────

async function listCompanies() {
  const [rows] = await sequelize.query(
    `SELECT id, code, legal_name, trade_name, tax_id, active, created_at, updated_at
       FROM companies ORDER BY active DESC, legal_name`,
  );
  return rows;
}

async function getCompany(id) {
  const [rows] = await sequelize.query(
    `SELECT id, code, legal_name, trade_name, tax_id, active, created_at, updated_at
       FROM companies WHERE id = ? LIMIT 1`,
    { replacements: [id] },
  );
  return rows[0] || null;
}

async function createCompany(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO companies (code, legal_name, trade_name, tax_id, active, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    { replacements: [
      data.code, data.legal_name, data.trade_name ?? null, data.tax_id ?? null,
      data.active ? 1 : 0, userId ?? null,
    ] },
  );
  return result.insertId;
}

async function updateCompany(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(k === 'active' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return 0;
  const [result] = await sequelize.query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = ?`,
    { replacements: [...vals, id] },
  );
  return Number(result?.affectedRows ?? 0);
}

// ─── Cost centers ───────────────────────────────────────────────────────────

async function listCostCenters() {
  const [rows] = await sequelize.query(
    `SELECT cc.id, cc.company_id, c.legal_name AS company_name, cc.code, cc.name,
            cc.active, cc.created_at, cc.updated_at
       FROM cost_centers cc
       LEFT JOIN companies c ON c.id = cc.company_id
      ORDER BY cc.active DESC, cc.name`,
  );
  return rows;
}

async function getCostCenter(id) {
  const [rows] = await sequelize.query(
    `SELECT id, company_id, code, name, active, created_at, updated_at
       FROM cost_centers WHERE id = ? LIMIT 1`,
    { replacements: [id] },
  );
  return rows[0] || null;
}

async function companyExists(id) {
  if (id == null) return true; // company_id es opcional
  const [rows] = await sequelize.query('SELECT 1 AS ok FROM companies WHERE id = ? LIMIT 1', {
    replacements: [id],
  });
  return rows.length > 0;
}

async function createCostCenter(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO cost_centers (company_id, code, name, active, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    { replacements: [
      data.company_id ?? null, data.code, data.name, data.active ? 1 : 0, userId ?? null,
    ] },
  );
  return result.insertId;
}

async function updateCostCenter(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(k === 'active' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return 0;
  const [result] = await sequelize.query(
    `UPDATE cost_centers SET ${sets.join(', ')} WHERE id = ?`,
    { replacements: [...vals, id] },
  );
  return Number(result?.affectedRows ?? 0);
}

module.exports = {
  isWriteEnabled,
  assertWriteEnabled,
  isDupError,
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  listCostCenters,
  getCostCenter,
  companyExists,
  createCostCenter,
  updateCostCenter,
};
