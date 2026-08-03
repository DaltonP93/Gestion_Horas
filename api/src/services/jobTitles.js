/**
 * jobTitles.js — Servicio de acceso al catálogo `job_titles`.
 *
 * Espeja a `paymentTypes.js`, con una diferencia de fondo: acá la clave
 * natural es el NOMBRE, porque `employees.position` guarda el nombre del
 * cargo como texto (ver migración 069). No hay `code` aparte.
 *
 * Cachea la lista completa un rato corto para no consultar en cada
 * validación de update. Cualquier escritura invalida la cache.
 */

const { sequelize } = require('../config/database');

const CACHE_TTL_MS = 30_000;
let _cache = null;
let _cacheAt = 0;

function _now() { return Date.now(); }

async function _loadAll() {
  const [rows] = await sequelize.query(
    'SELECT id, name, description, active, sort_order FROM job_titles ORDER BY sort_order, name'
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

/**
 * Búsqueda por nombre, insensible a may/min y a espacios de los bordes,
 * igual que la UNIQUE de la tabla (collation utf8mb4_unicode_ci). Así
 * "operario " coincide con el cargo "Operario" en lugar de rebotar.
 */
async function findByName(name) {
  if (!name || typeof name !== 'string') return null;
  const needle = name.trim().toLocaleLowerCase();
  if (!needle) return null;
  const rows = await _cached();
  return rows.find(r => String(r.name).trim().toLocaleLowerCase() === needle) || null;
}

async function isActiveName(name) {
  const r = await findByName(name);
  return !!(r && Number(r.active) === 1);
}

/**
 * Devuelve el nombre canónico del catálogo para un texto dado, o null si
 * no existe. Sirve para que al guardar quede escrito tal cual el catálogo
 * y no con la variante que tipeó el usuario.
 */
async function canonicalName(name) {
  const r = await findByName(name);
  return r ? r.name : null;
}

async function countUsage(name) {
  const [[row]] = await sequelize.query(
    'SELECT COUNT(*) AS c FROM employees WHERE position = ?',
    { replacements: [name] }
  );
  return Number(row?.c || 0);
}

module.exports = {
  listAll,
  findByName,
  isActiveName,
  canonicalName,
  countUsage,
  invalidateCache,
};
