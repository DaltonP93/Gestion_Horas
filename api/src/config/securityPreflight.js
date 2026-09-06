'use strict';

/**
 * securityPreflight.js — chequeos de seguridad al arranque (fail-closed en producción).
 *
 * H1: `database/init.sql` crea un usuario administrador inicial con la contraseña
 * demo `Admin1234!`. Si ese usuario llega a producción sin rotar, es un takeover
 * trivial. Este preflight BLOQUEA el arranque en producción cuando detecta que un
 * usuario admin/super_admin todavía usa esa contraseña por defecto.
 *
 * Principios:
 *  - Sólo actúa con `NODE_ENV === 'production'` (dev/test conservan la init reproducible).
 *  - Detección por el MECANISMO DE HASH existente (`bcrypt.compare`), no compara texto plano de la BD.
 *  - NUNCA registra contraseñas, hashes, usuarios ni JWT. Los logs sólo llevan un código.
 *  - No modifica ninguna credencial ni base: sólo lee para verificar.
 *  - Fail-closed ante DETECCIÓN afirmativa; ante un error de consulta transitorio NO bloquea
 *    (la conexión ya se validó antes; no se tumba la API por un fallo puntual de lectura).
 */

const bcrypt = require('bcrypt');
const logger = require('./logger');

// Contraseña demo que trae init.sql para el admin inicial. NO es un secreto
// (es pública en el repo); se usa sólo para DETECTAR la credencial sin rotar.
// Override por entorno por si el instalador usó otra plantilla conocida.
const DEFAULT_DEMO_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'Admin1234!';

/**
 * Lanza un Error (code `DEFAULT_ADMIN_CREDENTIAL`) si en producción algún
 * admin/super_admin activo conserva la contraseña demo por defecto.
 * @param {{ sequelize: import('sequelize').Sequelize, env?: NodeJS.ProcessEnv }} deps
 * @returns {Promise<{checked:boolean, ok?:boolean, reason?:string}>}
 */
async function assertNoDefaultAdminCredential({ sequelize, env = process.env } = {}) {
  if (env.NODE_ENV !== 'production') {
    return { checked: false, reason: 'non_production' };
  }
  if (!DEFAULT_DEMO_PASSWORD) {
    return { checked: false, reason: 'no_default_configured' };
  }

  let rows;
  try {
    const [r] = await sequelize.query(
      "SELECT username, password_hash FROM users WHERE role IN ('admin','super_admin') AND active = 1"
    );
    rows = r || [];
  } catch (err) {
    // La conexión ya fue validada antes de este preflight; un error acá (p. ej.
    // tabla ausente en un entorno recién inicializado) no debe tumbar la API.
    logger.warn('preflight credencial demo: no verificable, se continúa', { code: err && err.code });
    return { checked: false, reason: 'query_error' };
  }

  for (const u of rows) {
    let matches = false;
    try {
      matches = await bcrypt.compare(DEFAULT_DEMO_PASSWORD, (u && u.password_hash) || '');
    } catch {
      matches = false;
    }
    if (matches) {
      const e = new Error(
        'ARRANQUE BLOQUEADO (producción): un usuario administrador todavía usa la contraseña '
        + 'demo por defecto de database/init.sql. Rotala antes de desplegar '
        + '(ver docs/security-credential-rotation.md). No se registran credenciales.'
      );
      e.code = 'DEFAULT_ADMIN_CREDENTIAL';
      throw e;
    }
  }

  return { checked: true, ok: true };
}

module.exports = { assertNoDefaultAdminCredential, DEFAULT_DEMO_PASSWORD };
