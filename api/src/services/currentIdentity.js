'use strict';

/**
 * currentIdentity.js — identidad VIGENTE del usuario autenticado.
 *
 * El JWT de acceso vive 1 h: el rol, el estado y el empleado asociado que
 * trae pueden haber cambiado desde que se emitió. `authenticate` lee aquí la
 * fila actual de `users` una vez por solicitud y reemplaza esos campos en
 * `req.user`, de modo que requirePermission, authorize, requireGlobalHR,
 * departmentScope, enforceEmployeeScope y cualquier chequeo de rol posterior
 * decidan con datos de la base y no con los del token.
 *
 * Fail-closed: usuario inexistente o inactivo → sin identidad; error de
 * lectura → la excepción se propaga y el middleware responde 503.
 */

const { sequelize } = require('../config/database');
const { parsePositiveId } = require('../utils/strictId');

/**
 * @param {unknown} rawId  claim `id` del token
 * @returns {Promise<{id:number, username:string, role:string, employee_id:number|null}|null>}
 */
async function loadCurrentIdentity(rawId) {
  const id = parsePositiveId(rawId);
  if (id === null) return null;
  const [rows] = await sequelize.query(
    'SELECT id, username, role, active, employee_id FROM users WHERE id = ? LIMIT 1',
    { replacements: [id] },
  );
  const row = rows && rows[0];
  if (!row || !Number(row.active) || !row.role) return null;
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    employee_id: row.employee_id == null ? null : Number(row.employee_id),
  };
}

module.exports = { loadCurrentIdentity };
