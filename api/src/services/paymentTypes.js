/**
 * paymentTypes.js — Servicio de acceso al catálogo `payment_types`.
 *
 * Cachea la lista completa por un rato corto para no consultar en cada
 * validación de update. La cache se invalida en cualquier escritura.
 */

const { sequelize } = require('../config/database');

const CACHE_TTL_MS = 30_000;
let _cache = null;
let _cacheAt = 0;

function _now() { return Date.now(); }

async function _loadAll() {
  const [rows] = await sequelize.query(
    'SELECT id, code, name, description, active, sort_order FROM payment_types ORDER BY sort_order, name'
  );
  return rows;
}

async function _cached() {
  if (_cache && _now() - _cacheAt < CACHE_TTL_MS) return _cache;
  _cache = await _loadAll();
  _cacheAt = _now();
  return _cache;
}

function invalidateCache() { _cache = null; _cacheAt = 0; }

async function listAll({ activeOnly = false } = {}) {
  const rows = await _cached();
  return activeOnly ? rows.filter(r => Number(r.active) === 1) : rows;
}

async function findByCode(code) {
  if (!code || typeof code !== 'string') return null;
  const rows = await _cached();
  return rows.find(r => r.code === code) || null;
}

async function isActiveCode(code) {
  const r = await findByCode(code);
  return !!(r && Number(r.active) === 1);
}

async function countUsage(paymentTypeCode) {
  const [[row]] = await sequelize.query(
    'SELECT COUNT(*) AS c FROM employees WHERE pay_type = ?',
    { replacements: [paymentTypeCode] }
  );
  return Number(row?.c || 0);
}

module.exports = {
  listAll,
  findByCode,
  isActiveCode,
  countUsage,
  invalidateCache,
};
