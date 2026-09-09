'use strict';

/**
 * securityPreflight.js — chequeos de seguridad al arranque (FAIL-CLOSED en producción).
 *
 * H1: `database/init.sql` crea un administrador inicial con la contraseña demo
 * conocida. Si ese usuario llega a producción sin rotar es un takeover trivial.
 * Este preflight BLOQUEA el arranque en producción cuando:
 *   (a) detecta que un usuario admin/super_admin usa una contraseña por defecto
 *       conocida (`DEFAULT_ADMIN_CREDENTIAL`), o
 *   (b) NO puede verificarlo (error de consulta / tabla / permiso):
 *       `DEFAULT_ADMIN_CHECK_UNAVAILABLE`. No poder comprobar ≠ estar a salvo.
 *
 * Principios:
 *  - Sólo `NODE_ENV === 'production'` bloquea; dev/test conservan la init reproducible.
 *  - Detección por el MECANISMO DE HASH existente (`bcrypt.compare`), no compara texto plano de la BD.
 *  - NUNCA registra contraseñas, hashes, usuarios ni JWT. Los errores no incluyen la contraseña.
 *  - No modifica ninguna credencial ni base: sólo lee para verificar.
 *  - Evalúa TODOS los admin/super_admin, incluidos los inactivos (un usuario
 *    suspendido con la demo puede reactivarse).
 *  - La lista de contraseñas por defecto es PRIVADA del módulo. `ADMIN_WEAK_PASSWORDS`
 *    sólo puede AÑADIR entradas; nunca reemplaza ni desactiva la comprobación incorporada.
 */

const bcrypt = require('bcrypt');
const logger = require('./logger');

// Contraseñas por defecto conocidas de init.sql. Privadas del módulo: no se
// exportan ni se imprimen. (Son públicas en init.sql; acá sólo se usan para
// DETECTAR la credencial sin rotar.)
const BUILTIN_DEFAULT_PASSWORDS = Object.freeze(['Admin1234!']);

/** Lista efectiva = incorporadas + extras del entorno (ADITIVO, nunca reemplaza). */
function defaultPasswordsToCheck() {
  const extra = String(process.env.ADMIN_WEAK_PASSWORDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...BUILTIN_DEFAULT_PASSWORDS, ...extra];
}

/**
 * ¿La contraseña en texto plano es una de las conocidas por defecto?
 * Evita REINTRODUCIR la credencial demo en tiempo de set (alta/cambio/reset),
 * de modo que el preflight de arranque no sea el único control. Devuelve sólo
 * un booleano: no expone la lista ni la contraseña. Comparación en texto plano
 * (acá la entrada es la contraseña nueva propuesta, no un hash de la BD).
 */
function isDefaultAdminPassword(plaintext) {
  const pw = typeof plaintext === 'string' ? plaintext : '';
  if (!pw) return false;
  return defaultPasswordsToCheck().includes(pw);
}

function blockError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Lanza si en producción no puede garantizar que ningún admin/super_admin usa
 * una contraseña por defecto conocida.
 * @param {{ sequelize: import('sequelize').Sequelize, env?: NodeJS.ProcessEnv }} deps
 * @returns {Promise<{checked:boolean, ok?:boolean, reason?:string}>}
 */
async function assertNoDefaultAdminCredential({ sequelize, env = process.env } = {}) {
  if (env.NODE_ENV !== 'production') {
    return { checked: false, reason: 'non_production' };
  }

  let rows;
  try {
    // TODOS los privilegiados, activos o no.
    const [r] = await sequelize.query(
      "SELECT username, password_hash, active FROM users WHERE role IN ('admin','super_admin')"
    );
    rows = r || [];
  } catch (err) {
    // FAIL-CLOSED: si no se puede verificar, no se arranca. Se registra sólo un
    // código seguro (nunca el detalle del error, que podría traer SQL/valores).
    logger.error('preflight credencial demo: verificación no disponible; arranque bloqueado', {
      event: 'security.preflight.admin_credential',
      error_code: (err && typeof err.code === 'string') ? err.code : 'UNKNOWN',
    });
    throw blockError(
      'ARRANQUE BLOQUEADO (producción): no se pudo verificar la credencial administradora '
      + 'por defecto (error de consulta/esquema/permiso). Revisar la BD y las migraciones, '
      + 'y reintentar (ver docs/security-credential-rotation.md).',
      'DEFAULT_ADMIN_CHECK_UNAVAILABLE'
    );
  }

  const candidates = defaultPasswordsToCheck();
  for (const u of rows) {
    const hash = (u && u.password_hash) || '';
    for (const pw of candidates) {
      let matches = false;
      try { matches = await bcrypt.compare(pw, hash); } catch { matches = false; }
      if (matches) {
        throw blockError(
          'ARRANQUE BLOQUEADO (producción): un usuario administrador usa una contraseña '
          + 'por defecto conocida. Rotala antes de desplegar (ver '
          + 'docs/security-credential-rotation.md). No se registran credenciales.',
          'DEFAULT_ADMIN_CREDENTIAL'
        );
      }
    }
  }

  return { checked: true, ok: true };
}

module.exports = { assertNoDefaultAdminCredential, isDefaultAdminPassword };
