'use strict';

/**
 * userLookup.js — reglas puras de GET /api/users/lookup (selectores de
 * responsables, revisores, etc.).
 *
 * ALCANCE: el de la CUENTA candidata (`users.branch_id`), nunca el del
 * empleado vinculado (`users.employee_id`).
 *   - Alcance global emitido por el servidor (super_admin, admin, gth, hr):
 *     todas las cuentas activas.
 *   - Rol por sede (manager, coordinator, supervisor, gestor): sólo cuentas
 *     activas con `users.branch_id` dentro de los `branchIds` del alcance.
 *   - Alcance ausente, vacío o mal formado (sin sede, sede inexistente o
 *     inactiva): lista vacía. Sin fallback global.
 *
 * BÚSQUEDA: `LIKE ... ESCAPE '!'`. `%`, `_` y el propio `!` se anteponen con
 * `!`; con un carácter de escape explícito `\` deja de ser especial en el
 * patrón, así que los tres son literales sin depender de `sql_mode`.
 */

const scopeGrant = require('./scopeGrant');

const SEARCH_MAX = 100;
const LIKE_ESCAPE_CHAR = '!';

const fail = (error) => ({ ok: false, error });

/** Texto → patrón LIKE literal (para usar con `ESCAPE '!'`). */
function escapeLike(s) {
  return s.replace(/[!%_]/g, (c) => `${LIKE_ESCAPE_CHAR}${c}`);
}

/**
 * `role`: texto único con lista separada por comas, cada elemento de
 * `allowedRoles` (sin elementos vacíos). `''` o ausente → sin filtro.
 * `search`: texto único, recortado, hasta SEARCH_MAX. `''` o ausente → sin filtro.
 * Arreglos (`?role=a&role=b`) y objetos (`?role[x]=a`) → error.
 */
function validateLookupQuery(query, allowedRoles) {
  const q = query || {};
  const value = { roles: null, search: null };
  if (q.role !== undefined) {
    if (typeof q.role !== 'string') return fail('role inválido');
    if (q.role !== '') {
      const parts = q.role.split(',').map((s) => s.trim());
      if (parts.some((p) => !p || !allowedRoles.has(p))) return fail('role inválido');
      value.roles = [...new Set(parts)];
    }
  }
  if (q.search !== undefined) {
    if (typeof q.search !== 'string') return fail('search inválido');
    const s = q.search.trim();
    if (s.length > SEARCH_MAX) return fail(`search inválido (hasta ${SEARCH_MAX} caracteres)`);
    if (s) value.search = s;
  }
  return { ok: true, value };
}

/**
 * Filtro por sede de la CUENTA para un alcance resuelto por el servidor.
 *   → { sql: '', params: [] }               global emitido
 *   → { sql: ' AND u.branch_id IN (…)', … } restringido con sedes
 *   → null                                  sin alcance (lista vacía)
 */
function accountBranchFilter(scope) {
  if (scopeGrant.isGlobal(scope)) return { sql: '', params: [] };
  if (!scopeGrant.isRestricted(scope, ['branchIds']) || !scope.branchIds.length) return null;
  return {
    sql: ` AND u.branch_id IN (${scope.branchIds.map(() => '?').join(',')})`,
    params: [...scope.branchIds],
  };
}

/** SQL completo del lookup, o null si el actor no tiene alcance. */
function buildLookupQuery(scope, { roles, search }) {
  const branch = accountBranchFilter(scope);
  if (!branch) return null;
  let where = 'WHERE u.active = 1';
  const params = [];
  if (roles) { where += ` AND u.role IN (${roles.map(() => '?').join(',')})`; params.push(...roles); }
  if (search) {
    const like = `%${escapeLike(search)}%`;
    where += ` AND (u.full_name LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}' OR u.username LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}')`;
    params.push(like, like);
  }
  where += branch.sql;
  params.push(...branch.params);
  return {
    sql: `SELECT u.id, u.full_name, u.username, u.role, u.employee_id
            FROM users u ${where} ORDER BY u.full_name LIMIT 500`,
    params,
  };
}

module.exports = { SEARCH_MAX, escapeLike, validateLookupQuery, accountBranchFilter, buildLookupQuery };
