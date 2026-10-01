'use strict';

/**
 * appraisalAccess.test.js — reglas puras de acceso a evaluaciones y filtro
 * del listado. La conducta con MySQL real está en tests/it/appraisals.it.test.js.
 */
const scopeGrant = require('../src/services/scopeGrant');
const { canSeeAppraisal, listScope } = require('../src/services/appraisalAccess');

const GLOBAL = scopeGrant.issueGlobal();
const SCOPE_A = { unrestricted: false, ids: [10, 11], branchIds: [1] };
const NO_SCOPE = { unrestricted: false, ids: [], branchIds: [] };
const empA = { id: 100, department_id: 10 };
const empB = { id: 200, department_id: 20 };
const sup = (extra = {}) => ({ id: 7, role: 'supervisor', employee_id: null, ...extra });
const ap = (employee_id, reviewer_id = null) => ({ employee_id, reviewer_id });
const BASE = 'WHERE 1=1 AND a.status = ?';

describe('canSeeAppraisal — supervisor', () => {
  test('asignada dentro del alcance → sí; fuera del alcance → no', () => {
    expect(canSeeAppraisal(sup(), SCOPE_A, ap(100, 7), empA)).toBe(true);
    expect(canSeeAppraisal(sup(), SCOPE_A, ap(200, 7), empB)).toBe(false);
  });
  test('propia → sí, aun sin alcance o con el empleado en otra sede', () => {
    expect(canSeeAppraisal(sup({ employee_id: 200 }), NO_SCOPE, ap(200, 99), empB)).toBe(true);
    expect(canSeeAppraisal(sup({ employee_id: 200 }), SCOPE_A, ap(200, 99), empB)).toBe(true);
  });
  test('ni propia ni asignada → no, aunque el empleado esté en su alcance', () => {
    expect(canSeeAppraisal(sup({ employee_id: 300 }), SCOPE_A, ap(100, 99), empA)).toBe(false);
  });
  test('alcance mal formado: sólo la propia', () => {
    expect(canSeeAppraisal(sup({ employee_id: 100 }), { unrestricted: true }, ap(100, 99), empA)).toBe(true);
    expect(canSeeAppraisal(sup(), { unrestricted: true }, ap(100, 7), empA)).toBe(false);
  });
});

describe('listScope — supervisor', () => {
  test('con employee_id: (propia OR (asignada AND alcance)) aplicada sobre los filtros previos', () => {
    const r = listScope(sup({ employee_id: 55 }), SCOPE_A, BASE, ['self_pending']);
    expect(r.where).toBe(`${BASE} AND (a.employee_id = ? OR (a.reviewer_id = ? AND e.department_id IN (?,?)))`);
    expect(r.params).toEqual(['self_pending', 55, 7, 10, 11]);
  });
  test('sin employee_id: sólo la rama asignada', () => {
    const r = listScope(sup(), SCOPE_A, BASE, ['x']);
    expect(r.where).toBe(`${BASE} AND ((a.reviewer_id = ? AND e.department_id IN (?,?)))`);
    expect(r.params).toEqual(['x', 7, 10, 11]);
  });
  test('sin alcance: la rama asignada es 1=0 y la propia se conserva', () => {
    const r = listScope(sup({ employee_id: 55 }), NO_SCOPE, BASE, ['x']);
    expect(r.where).toBe(`${BASE} AND (a.employee_id = ? OR (a.reviewer_id = ? AND 1=0))`);
    expect(r.params).toEqual(['x', 55, 7]);
  });
  test('sin alcance ni employee_id: 0 filas (nunca global)', () => {
    const r = listScope(sup(), NO_SCOPE, BASE, ['x']);
    expect(r.where).toBe(`${BASE} AND ((a.reviewer_id = ? AND 1=0))`);
  });
  test('un literal { unrestricted: true } no es global para el supervisor', () => {
    const r = listScope(sup(), { unrestricted: true }, BASE, []);
    expect(r.where).toMatch(/1=0/);
  });
});

describe('listScope — resto de roles sin cambios', () => {
  test('global: sin filtro', () => {
    expect(listScope({ id: 1, role: 'hr' }, GLOBAL, BASE, ['x'])).toEqual({ where: BASE, params: ['x'] });
  });
  test('manager: departamentos de su alcance', () => {
    expect(listScope({ id: 2, role: 'manager' }, SCOPE_A, BASE, ['x']))
      .toEqual({ where: `${BASE} AND e.department_id IN (?,?)`, params: ['x', 10, 11] });
  });
  test('employee: sólo lo propio; sin vínculo → 0 filas', () => {
    expect(listScope({ id: 3, role: 'employee', employee_id: 9 }, NO_SCOPE, BASE, []))
      .toEqual({ where: `${BASE} AND a.employee_id = ?`, params: [9] });
    expect(listScope({ id: 3, role: 'employee', employee_id: null }, NO_SCOPE, BASE, []).where).toMatch(/1=0$/);
  });
});
