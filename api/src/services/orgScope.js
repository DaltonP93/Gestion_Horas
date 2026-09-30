'use strict';

/**
 * orgScope.js — alcance organizacional (empresa / sucursal / departamento).
 *
 * Extiende `departmentScope.js` (departamentos + descendientes) con las
 * dimensiones de EMPRESA y SUCURSAL, para aplicar autorización de ALCANCE en
 * la API — no sólo módulo/acción.
 *
 * Reglas:
 *   - Roles NO restringidos (super_admin, admin, gth, hr): alcance global
 *     EMITIDO por el servidor (scopeGrant.issueGlobal). Es el único bypass: un
 *     objeto armado a mano con `unrestricted: true` no cuenta.
 *   - Roles con alcance (manager, coordinator, supervisor, gestor): la SEDE
 *     configurada en users.branch_id define el universo visible. El empleado
 *     vinculado es independiente y no participa en autorización.
 *     Sin sede, o con sede inexistente o INACTIVA ⇒ conjuntos vacíos
 *     (fail-closed): no consulta ni modifica datos organizacionales, tampoco
 *     los calendarios globales. Reactivar la sede recupera el alcance.
 *   - Cualquier otro rol (p. ej. employee): sin alcance (nada).
 *
 * Los writers usan `assert*InScope` para RECHAZAR referencias fuera de alcance
 * (403), evitando acceso cruzado entre empresas/sucursales/departamentos.
 *
 * Alcance OBLIGATORIO: todo helper exige un alcance. Ausente, `null` o mal
 * formado ⇒ filtros sin filas, predicados en `false` y `assert*` en 403.
 *
 * Degradación: si `branches.company_id` (migración 076) todavía no existe, la
 * dimensión empresa queda vacía sin romper (se distingue del error real).
 */

const { sequelize } = require('../config/database');
const departmentScope = require('./departmentScope');
const scopeGrant = require('./scopeGrant');

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Resuelve el alcance del usuario.
 * @returns alcance global emitido (scopeGrant) o
 *          {{unrestricted:false, companyIds:number[], branchIds:number[], departmentIds:number[]}}
 */
async function getOrgScope(user) {
  if (!user || !user.role) {
    return { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] };
  }
  if (departmentScope.isUnrestricted(user.role)) return scopeGrant.issueGlobal();

  const dept = await departmentScope.getVisibleDepartmentIds(user);
  // Un rol con alcance nunca recibe el global de departmentScope; si llegara a
  // pasar, no se hereda: los conjuntos quedan vacíos (fail-closed).
  const restricted = scopeGrant.isRestricted(dept, ['ids'], ['branchIds']);
  const departmentIds = restricted ? dept.ids : [];
  const branchIds = restricted ? (dept.branchIds || []) : [];

  let companyIds = [];
  const branchId = branchIds[0] || null;
  if (branchId) {
    try {
      const [[b]] = await sequelize.query(
        'SELECT company_id FROM branches WHERE id = ? LIMIT 1',
        { replacements: [branchId] },
      );
      if (b?.company_id) companyIds = [Number(b.company_id)];
    } catch {
      // branches.company_id aún no existe (076 no aplicada) → sin empresa.
    }
  }
  return { unrestricted: false, companyIds, branchIds, departmentIds };
}

/** ¿Alcance global emitido por el servidor? (no basta `unrestricted: true`). */
function isGlobal(scope) {
  return scopeGrant.isGlobal(scope);
}

const EMPTY = Object.freeze({ companyIds: [], branchIds: [], departmentIds: [] });

/**
 * Conjuntos de un alcance RESTRINGIDO bien formado. Ausente, nulo, literal
 * `unrestricted: true` no emitido o mal formado ⇒ conjuntos vacíos.
 */
function sets(scope) {
  if (scopeGrant.isRestricted(scope, ['companyIds', 'branchIds', 'departmentIds'])) return scope;
  return EMPTY;
}

/** ¿El valor recibido es un alcance válido (global emitido o restringido bien formado)? */
function isValidScope(scope) {
  return isGlobal(scope) || sets(scope) !== EMPTY;
}

/**
 * Exige alcance GLOBAL emitido (operaciones que por definición no caben en un
 * alcance acotado, p. ej. crear una empresa nueva). Si no → 403.
 */
function assertGlobalScope(scope) {
  if (isGlobal(scope)) return;
  throw httpError(403, 'OUT_OF_SCOPE', 'La operación requiere alcance global');
}

function assertValidScope(scope) {
  if (!isValidScope(scope)) throw httpError(403, 'OUT_OF_SCOPE', 'Alcance ausente o inválido');
}

/**
 * Fragmento SQL para filtrar por una lista de ids del alcance.
 * Conjunto vacío → `AND 1=0`; si no → `AND col IN (...)`.
 * `includeNull` agrega `OR col IS NULL` (para filas sin esa dimensión asignada).
 * No decide el bypass global: eso lo hace el llamador con `isGlobal`.
 */
function scopeFilter(ids, col, { includeNull = false } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) {
    return includeNull ? { clause: `AND ${col} IS NULL`, params: [] } : { clause: 'AND 1=0', params: [] };
  }
  const ph = list.map(() => '?').join(',');
  const nullPart = includeNull ? ` OR ${col} IS NULL` : '';
  return { clause: `AND (${col} IN (${ph})${nullPart})`, params: [...list] };
}

/**
 * Filtro por empresa del alcance. El alcance se valida ANTES de `includeNull`:
 * ausente, nulo, mal formado, literal global no emitido o vacío (sin sede
 * activa) → `AND 1=0`; nunca habilita las filas sin empresa.
 */
function companyFilter(scope, col = 'id', opts = {}) {
  if (isGlobal(scope)) return { clause: '', params: [] };
  if (!isValidScope(scope)) return { clause: 'AND 1=0', params: [] };
  const { companyIds, branchIds } = sets(scope);
  if (!companyIds.length && !branchIds.length) return { clause: 'AND 1=0', params: [] };
  return scopeFilter(companyIds, col, opts);
}

function canSeeCompany(scope, company) {
  if (isGlobal(scope)) return true;
  const id = company?.id ?? null;
  return id != null && sets(scope).companyIds.includes(id);
}

function canSeeCostCenter(scope, cc) {
  if (isGlobal(scope)) return true;
  const cid = cc?.company_id ?? null;
  if (cid == null) return false; // centros sin empresa sólo los ve un rol global
  return sets(scope).companyIds.includes(cid);
}

// Los assert*: global emitido → pasa; alcance ausente/inválido → 403 siempre;
// alcance restringido válido sin referencia (null) → nada que cruzar.
function assertCompanyInScope(scope, companyId) {
  if (isGlobal(scope)) return;
  assertValidScope(scope);
  if (companyId == null) return; // no referencia empresa → nada que cruzar
  if (!sets(scope).companyIds.includes(companyId)) {
    throw httpError(403, 'OUT_OF_SCOPE', 'La empresa referenciada está fuera de tu alcance');
  }
}

function assertBranchInScope(scope, branchId) {
  if (isGlobal(scope)) return;
  assertValidScope(scope);
  if (branchId == null) return;
  if (!sets(scope).branchIds.includes(branchId)) {
    throw httpError(403, 'OUT_OF_SCOPE', 'La sucursal referenciada está fuera de tu alcance');
  }
}

function assertDepartmentInScope(scope, departmentId) {
  if (isGlobal(scope)) return;
  assertValidScope(scope);
  if (departmentId == null) return;
  if (!sets(scope).departmentIds.includes(departmentId)) {
    throw httpError(403, 'OUT_OF_SCOPE', 'El departamento referenciado está fuera de tu alcance');
  }
}

// ─── Alcance por EMPLEADO (departamento o sucursal del actor) ────────────────

/** Lee las referencias de alcance de un empleado. `null` si no existe. */
async function loadEmployeeOrgRefs(employeeId) {
  const [[row]] = await sequelize.query(
    'SELECT id, department_id, branch_id FROM employees WHERE id = ? LIMIT 1',
    { replacements: [employeeId] },
  );
  return row || null;
}

/**
 * ¿El actor puede ver a este empleado? Unrestricted → sí. Si no, el empleado es
 * visible cuando su departamento está en el alcance departamental O su sucursal
 * está en el alcance de sucursales del actor. Un empleado sin depto NI sucursal
 * sólo lo ve un rol global.
 */
function canSeeEmployeeRefs(scope, refs) {
  if (isGlobal(scope)) return true;
  if (!refs) return false;
  const { departmentIds, branchIds } = sets(scope);
  const dept = refs.department_id ?? null;
  const branch = refs.branch_id ?? null;
  if (dept != null && departmentIds.includes(dept)) return true;
  if (branch != null && branchIds.includes(branch)) return true;
  return false;
}

// ─── Alcance por CANDIDATO (empresa o sucursal) ──────────────────────────────

/**
 * ¿El actor puede ver este candidato? Regla JERÁRQUICA y fail-closed (P1-A):
 *   - Unrestricted (RR.HH. global) → sí siempre.
 *   - Candidato CON `branch_id` → visible sólo si esa sucursal está entre las
 *     sucursales visibles del actor. NO hay fallback a empresa: un manager de la
 *     sucursal A NO ve un candidato de la sucursal B aunque ambas sean de la
 *     misma empresa (evita fuga de PII entre sucursales).
 *   - Candidato SIN `branch_id` pero CON `company_id` → visible si esa empresa
 *     está entre las empresas visibles del actor.
 *   - Candidato SIN alcance (ambos NULL) → sólo un rol global de RR.HH.
 */
function canSeeCandidateRefs(scope, refs) {
  if (isGlobal(scope)) return true;
  if (!refs) return false;
  const { companyIds, branchIds } = sets(scope);
  const branch = refs.branch_id ?? null;
  const company = refs.company_id ?? null;
  if (branch != null) return branchIds.includes(branch);
  if (company != null) return companyIds.includes(company);
  return false; // sin alcance → sólo global
}

/**
 * Fragmento SQL (`{clause, params}`) para filtrar candidatos por alcance con la
 * MISMA regla jerárquica que `canSeeCandidateRefs`:
 *   (branch_id IS NOT NULL AND branch_id IN <sucursales>)
 *   OR (branch_id IS NULL AND company_id IN <empresas>)
 * Un candidato con `branch_id` de otra sucursal queda fuera aunque su empresa
 * coincida; los de alcance NULL quedan fuera para roles con alcance (sólo los ve
 * un rol global). Unrestricted → sin filtro.
 */
function candidateScopeFilter(scope, { companyCol = 'company_id', branchCol = 'branch_id' } = {}) {
  if (isGlobal(scope)) return { clause: '', params: [] };
  const { companyIds: cids, branchIds: bids } = sets(scope);
  const ors = [];
  const params = [];
  if (bids.length) {
    ors.push(`(${branchCol} IS NOT NULL AND ${branchCol} IN (${bids.map(() => '?').join(',')}))`);
    params.push(...bids);
  }
  if (cids.length) {
    ors.push(`(${branchCol} IS NULL AND ${companyCol} IN (${cids.map(() => '?').join(',')}))`);
    params.push(...cids);
  }
  if (!ors.length) return { clause: 'AND 1=0', params: [] };
  return { clause: `AND (${ors.join(' OR ')})`, params };
}

// ─── Alcance de CALENDARIOS (global visible + empresa/sucursal) ──────────────

/**
 * ¿El actor puede ver este calendario? Regla JERÁRQUICA y fail-closed (P1-A),
 * análoga a los candidatos pero con el GLOBAL visible para todos:
 *   - Unrestricted (RR.HH. global) → sí siempre.
 *   - Calendario GLOBAL (company_id y branch_id NULL) → visible (aplica a todos).
 *   - Calendario CON `branch_id` → visible sólo si esa sucursal está en
 *     `scope.branchIds`. **NUNCA** hay fallback por empresa: un actor de la
 *     sucursal A1 NO ve (ni edita excepciones de) un calendario de la sucursal A2
 *     aunque compartan empresa.
 *   - Calendario SIN `branch_id` pero CON `company_id` → visible por `companyIds`.
 */
function canSeeCalendar(scope, cal) {
  if (isGlobal(scope)) return true;
  if (!cal || !isValidScope(scope)) return false;          // sin alcance válido no ve ni los globales
  const { companyIds, branchIds } = sets(scope);
  if (!companyIds.length && !branchIds.length) return false; // sin sede activa: sin datos organizacionales
  const branch = cal.branch_id ?? null;
  const company = cal.company_id ?? null;
  if (branch == null && company == null) return true;     // global aplica a todos
  if (branch != null) return branchIds.includes(branch);  // sin fallback a empresa
  return companyIds.includes(company);                    // branch NULL, company no NULL
}

/**
 * Fragmento SQL para filtrar calendarios por alcance con la MISMA regla
 * jerárquica que `canSeeCalendar` (INCLUYE los globales):
 *   (company_id IS NULL AND branch_id IS NULL)             -- global
 *   OR (branch_id IN <sucursales>)                          -- sucursal en alcance
 *   OR (branch_id IS NULL AND company_id IN <empresas>)     -- sólo-empresa
 * Un calendario con `branch_id` de otra sucursal queda fuera aunque su empresa
 * coincida. Unrestricted → sin filtro.
 */
function calendarScopeFilter(scope, { companyCol = 'company_id', branchCol = 'branch_id' } = {}) {
  if (isGlobal(scope)) return { clause: '', params: [] };
  if (!isValidScope(scope)) return { clause: 'AND 1=0', params: [] };
  const { companyIds: cids, branchIds: bids } = sets(scope);
  if (!cids.length && !bids.length) return { clause: 'AND 1=0', params: [] }; // sin sede activa
  const ors = [`(${companyCol} IS NULL AND ${branchCol} IS NULL)`]; // global siempre visible
  const params = [];
  if (bids.length) {
    ors.push(`${branchCol} IN (${bids.map(() => '?').join(',')})`);
    params.push(...bids);
  }
  if (cids.length) {
    ors.push(`(${branchCol} IS NULL AND ${companyCol} IN (${cids.map(() => '?').join(',')}))`);
    params.push(...cids);
  }
  return { clause: `AND (${ors.join(' OR ')})`, params };
}

module.exports = {
  getOrgScope,
  isGlobal,
  isValidScope,
  assertGlobalScope,
  scopeFilter,
  companyFilter,
  canSeeCompany,
  canSeeCostCenter,
  assertCompanyInScope,
  assertBranchInScope,
  assertDepartmentInScope,
  loadEmployeeOrgRefs,
  canSeeEmployeeRefs,
  canSeeCandidateRefs,
  candidateScopeFilter,
  canSeeCalendar,
  calendarScopeFilter,
};
