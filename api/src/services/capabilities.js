'use strict';

/**
 * capabilities.js — capacidades funcionales (módulo × acción).
 *
 * Fuente ÚNICA de la regla que aplica `requirePermission`:
 *   1. super_admin y admin: bypass (política vigente);
 *   2. si existe fila en user_permissions para (usuario, módulo), manda esa
 *      fila — incluida la DENEGACIÓN explícita (flag en 0);
 *   3. si no, el default del rol (services/permissionMatrix).
 *
 * El alcance (departamentos/sedes) es un requisito APARTE: tener empleados en
 * alcance nunca concede una capacidad.
 */

const { sequelize } = require('../config/database');
const { defaultsForRole } = require('./permissionMatrix');

const ACTION_FIELD = {
  view: 'can_view', create: 'can_create', update: 'can_update', delete: 'can_delete',
};
const BYPASS_ROLES = new Set(['super_admin', 'admin']);
const ALL = { view: true, create: true, update: true, delete: true };
const NONE = { view: false, create: false, update: false, delete: false };

function toFlags(row) {
  if (!row) return { ...NONE };
  return {
    view: !!Number(row.can_view || 0),
    create: !!Number(row.can_create || 0),
    update: !!Number(row.can_update || 0),
    delete: !!Number(row.can_delete || 0),
  };
}

/**
 * Flags efectivos por módulo para el usuario.
 * @param {{id:number, role:string}} user
 * @param {string[]} moduleKeys
 * @returns {Promise<Record<string,{view:boolean,create:boolean,update:boolean,delete:boolean}>>}
 */
async function getCapabilityFlags(user, moduleKeys) {
  const out = {};
  if (!user || !user.role) {
    for (const m of moduleKeys) out[m] = { ...NONE };
    return out;
  }
  if (BYPASS_ROLES.has(user.role)) {
    for (const m of moduleKeys) out[m] = { ...ALL };
    return out;
  }
  const ph = moduleKeys.map(() => '?').join(',');
  const [rows] = await sequelize.query(
    `SELECT module, can_view, can_create, can_update, can_delete
       FROM user_permissions WHERE user_id = ? AND module IN (${ph})`,
    { replacements: [user.id, ...moduleKeys] },
  );
  const list = rows || [];
  const byModule = new Map(list.filter((r) => r && r.module != null).map((r) => [r.module, r]));
  // Consulta de un solo módulo: la fila devuelta corresponde a ese módulo.
  if (moduleKeys.length === 1 && !byModule.size && list.length) byModule.set(moduleKeys[0], list[0]);
  const defaults = defaultsForRole(user.role) || {};
  for (const m of moduleKeys) {
    const row = byModule.get(m);
    out[m] = toFlags(row || defaults[m]);
  }
  return out;
}

/** ¿Tiene el usuario la acción sobre el módulo? */
async function hasCapability(user, moduleKey, action) {
  if (!ACTION_FIELD[action]) throw new Error(`Acción inválida: ${action}`);
  const flags = await getCapabilityFlags(user, [moduleKey]);
  return !!flags[moduleKey][action];
}

module.exports = { getCapabilityFlags, hasCapability, ACTION_FIELD, BYPASS_ROLES };
