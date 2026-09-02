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
 *     (`{ unrestricted: true }`). Es un bypass EXPLÍCITO y documentado; las
 *     pruebas lo verifican.
 *   - Roles con alcance (manager, coordinator, supervisor, gestor): ven sólo
 *     su departamento + descendientes, su sucursal y la empresa de esa
 *     sucursal. Sin empleado/sucursal vinculada ⇒ conjuntos vacíos (nada).
 *   - Cualquier otro rol (p. ej. employee): sin alcance (nada).
 *
 * Los writers usan `assert*InScope` para RECHAZAR referencias fuera de alcance
 * (403), evitando acceso cruzado entre empresas/sucursales/departamentos.
 *
 * Degradación: si `branches.company_id` (migración 076) todavía no existe, la
 * dimensión empresa queda vacía sin romper (se distingue del error real).
 */

const { sequelize } = require('../config/database');
const departmentScope = require('./departmentScope');

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Resuelve el alcance del usuario.
 * @returns {{unrestricted:true}} o
 *          {{unrestricted:false, companyIds:number[], branchIds:number[], departmentIds:number[]}}
 */
async function getOrgScope(user) {
  if (!user || !user.role) {
    return { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] };
  }
  if (departmentScope.isUnrestricted(user.role)) return { unrestricted: true };

  const dept = await departmentScope.getVisibleDepartmentIds(user);
  const departmentIds = dept.unrestricted ? [] : (dept.ids || []);

  let branchIds = [];
  let companyIds = [];
  if (user.employee_id) {
    let branchId = null;
    try {
      const [[row]] = await sequelize.query(
        'SELECT branch_id FROM employees WHERE id = ? LIMIT 1',
        { replacements: [user.employee_id] },
      );
      branchId = row?.branch_id || null;
    } catch { branchId = null; }

    if (branchId) {
      branchIds = [branchId];
      try {
        const [[b]] = await sequelize.query(
          'SELECT company_id FROM branches WHERE id = ? LIMIT 1',
          { replacements: [branchId] },
        );
        if (b?.company_id) companyIds = [b.company_id];
      } catch {
        // branches.company_id aún no existe (076 no aplicada) → sin empresa.
      }
    }
  }
  return { unrestricted: false, companyIds, branchIds, departmentIds };
}

/**
 * Fragmento SQL para filtrar por una dimensión del alcance.
 * unrestricted → sin filtro; conjunto vacío → `AND 1=0`; si no → `AND col IN (...)`.
 * `includeNull` agrega `OR col IS NULL` (para filas sin esa dimensión asignada).
 */
function scopeFilter(ids, col, { unrestricted = false, includeNull = false } = {}) {
  if (unrestricted) return { clause: '', params: [] };
  const list = ids || [];
  if (!list.length) {
    return includeNull ? { clause: `AND ${col} IS NULL`, params: [] } : { clause: 'AND 1=0', params: [] };
  }
  const ph = list.map(() => '?').join(',');
  const nullPart = includeNull ? ` OR ${col} IS NULL` : '';
  return { clause: `AND (${col} IN (${ph})${nullPart})`, params: [...list] };
}

function companyFilter(scope, col = 'id', opts = {}) {
  if (!scope || scope.unrestricted) return { clause: '', params: [] };
  return scopeFilter(scope.companyIds, col, opts);
}

function canSeeCompany(scope, company) {
  if (!scope || scope.unrestricted) return true;
  const id = company?.id ?? null;
  return id != null && (scope.companyIds || []).includes(id);
}

function canSeeCostCenter(scope, cc) {
  if (!scope || scope.unrestricted) return true;
  const cid = cc?.company_id ?? null;
  if (cid == null) return false; // centros sin empresa sólo los ve un rol global
  return (scope.companyIds || []).includes(cid);
}

function assertCompanyInScope(scope, companyId) {
  if (!scope || scope.unrestricted) return;
  if (companyId == null) return; // no referencia empresa → nada que cruzar
  if (!(scope.companyIds || []).includes(companyId)) {
    throw httpError(403, 'OUT_OF_SCOPE', 'La empresa referenciada está fuera de tu alcance');
  }
}

function assertBranchInScope(scope, branchId) {
  if (!scope || scope.unrestricted) return;
  if (branchId == null) return;
  if (!(scope.branchIds || []).includes(branchId)) {
    throw httpError(403, 'OUT_OF_SCOPE', 'La sucursal referenciada está fuera de tu alcance');
  }
}

function assertDepartmentInScope(scope, departmentId) {
  if (!scope || scope.unrestricted) return;
  if (departmentId == null) return;
  if (!(scope.departmentIds || []).includes(departmentId)) {
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
  if (!scope || scope.unrestricted) return true;
  if (!refs) return false;
  const dept = refs.department_id ?? null;
  const branch = refs.branch_id ?? null;
  if (dept != null && (scope.departmentIds || []).includes(dept)) return true;
  if (branch != null && (scope.branchIds || []).includes(branch)) return true;
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
  if (!scope || scope.unrestricted) return true;
  if (!refs) return false;
  const branch = refs.branch_id ?? null;
  const company = refs.company_id ?? null;
  if (branch != null) return (scope.branchIds || []).includes(branch);
  if (company != null) return (scope.companyIds || []).includes(company);
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
  if (!scope || scope.unrestricted) return { clause: '', params: [] };
  const cids = scope.companyIds || [];
  const bids = scope.branchIds || [];
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

module.exports = {
  getOrgScope,
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
};
