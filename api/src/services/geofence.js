/**
 * geofence.js — Geocerca para marcación móvil.
 *
 * Valida que una marcación con coordenadas caiga dentro del perímetro de la
 * sede del empleado (branches.geo_lat / geo_lng / geo_radius_m). El modo de
 * aplicación es parametrizable vía settings:
 *   - geofence_mode: 'off' (no valida) | 'warn' (registra pero permite) |
 *     'enforce' (rechaza fuera del radio).
 *   - geofence_default_radius_m: radio por defecto si la sede no define uno.
 *
 * Funciones puras (haversine, evaluate) + accesos a config/sede.
 */
const { sequelize } = require('../config/database');

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getConfig() {
  const [rows] = await sequelize.query(
    "SELECT setting_key, setting_value FROM notification_settings WHERE setting_key IN ('geofence_mode','geofence_default_radius_m')"
  );
  const m = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const mode = ['off', 'warn', 'enforce'].includes(m.geofence_mode) ? m.geofence_mode : 'enforce';
  const dr = parseInt(m.geofence_default_radius_m, 10);
  return { mode, default_radius_m: Number.isFinite(dr) && dr > 0 ? dr : 200 };
}

// Perímetro de la sede del empleado (o null si no está configurado).
async function getEmployeeFence(employeeId, defaultRadius) {
  const [[row]] = await sequelize.query(
    `SELECT b.geo_lat AS lat, b.geo_lng AS lng, b.geo_radius_m AS radius, b.name
     FROM employees e JOIN branches b ON b.id = e.branch_id
     WHERE e.id = ? LIMIT 1`,
    { replacements: [employeeId] }
  );
  if (!row || row.lat == null || row.lng == null) return null;
  return { lat: +row.lat, lng: +row.lng, radius: row.radius || defaultRadius || 200, name: row.name };
}

// Evalúa una coordenada contra un perímetro.
// → { status: 'inside'|'outside'|'unknown', distance: number|null }
function evaluate(lat, lng, fence) {
  if (lat == null || lng == null || !fence) return { status: 'unknown', distance: null };
  const dist = Math.round(haversineMeters(+lat, +lng, fence.lat, fence.lng));
  return { status: dist <= fence.radius ? 'inside' : 'outside', distance: dist };
}

// Resuelve todo: config + sede + evaluación para un empleado y coordenada.
// Devuelve { mode, fence, status, distance, blocked }.
async function check(employeeId, lat, lng) {
  const { mode, default_radius_m } = await getConfig();
  const fence = await getEmployeeFence(employeeId, default_radius_m);
  const { status, distance } = evaluate(lat, lng, fence);
  const blocked = mode === 'enforce' && status === 'outside';
  return { mode, fence, status, distance, blocked };
}

module.exports = { haversineMeters, getConfig, getEmployeeFence, evaluate, check };
