/**
 * orgScope.test.js — alcance organizacional (unitario, DB mockeada).
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/departmentScope', () => ({
  isUnrestricted: (r) => new Set(['super_admin', 'admin', 'gth', 'hr']).has(r),
  isScoped: (r) => new Set(['manager', 'coordinator', 'supervisor', 'gestor']).has(r),
  getVisibleDepartmentIds: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const orgScope = require('../src/services/orgScope');

beforeEach(() => jest.clearAllMocks());

describe('getOrgScope', () => {
  test('roles no restringidos → unrestricted (bypass explícito, sin DB)', async () => {
    for (const role of ['super_admin', 'admin', 'gth', 'hr']) {
      const s = await orgScope.getOrgScope({ role, employee_id: 1 });
      expect(s).toEqual({ unrestricted: true });
    }
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('rol con alcance deriva deptos + sede + empresa desde users.branch_id', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValueOnce({
      unrestricted: false, ids: [4, 5], branchIds: [2],
    });
    sequelize.query.mockResolvedValueOnce([[{ company_id: 9 }]]); // branches.company_id
    const s = await orgScope.getOrgScope({ id: 7, role: 'manager', employee_id: null });
    expect(s).toEqual({ unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4, 5] });
    expect(String(sequelize.query.mock.calls[0][0])).not.toMatch(/FROM employees/i);
  });

  test('rol sin sede → conjuntos vacíos', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValueOnce({
      unrestricted: false, ids: [], branchIds: [],
    });
    const s = await orgScope.getOrgScope({ id: 7, role: 'manager', employee_id: 999 });
    expect(s).toEqual({ unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] });
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('empleado común → sin alcance', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValueOnce({ unrestricted: false, ids: [] });
    const s = await orgScope.getOrgScope({ role: 'employee', employee_id: 3 });
    expect(s.unrestricted).toBe(false);
    expect(s.companyIds).toEqual([]);
  });

  test('degrada si branches.company_id no existe (076 no aplicada)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValueOnce({
      unrestricted: false, ids: [1], branchIds: [2],
    });
    sequelize.query.mockRejectedValueOnce(Object.assign(new Error('no col'), { code: 'ER_BAD_FIELD_ERROR' }));
    const s = await orgScope.getOrgScope({ id: 7, role: 'manager', employee_id: null });
    expect(s.branchIds).toEqual([2]);
    expect(s.companyIds).toEqual([]);
  });
});

describe('filtros y asserts', () => {
  const scope = { unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4, 5] };

  test('companyFilter sin alcance → sin cláusula', () => {
    expect(orgScope.companyFilter({ unrestricted: true }, 'id')).toEqual({ clause: '', params: [] });
  });

  test('companyFilter con alcance → IN (...)', () => {
    const f = orgScope.companyFilter(scope, 'cc.company_id');
    expect(f.clause).toMatch(/AND \(cc\.company_id IN \(\?\)\)/);
    expect(f.params).toEqual([9]);
  });

  test('companyFilter con conjunto vacío → 1=0', () => {
    const f = orgScope.companyFilter({ unrestricted: false, companyIds: [] }, 'id');
    expect(f.clause).toBe('AND 1=0');
  });

  test('assertCompanyInScope: dentro pasa, fuera 403, null pasa, unrestricted pasa', () => {
    expect(() => orgScope.assertCompanyInScope(scope, 9)).not.toThrow();
    expect(() => orgScope.assertCompanyInScope(scope, null)).not.toThrow();
    expect(() => orgScope.assertCompanyInScope({ unrestricted: true }, 999)).not.toThrow();
    try { orgScope.assertCompanyInScope(scope, 999); throw new Error('no lanzó'); }
    catch (e) { expect(e.status).toBe(403); expect(e.code).toBe('OUT_OF_SCOPE'); }
  });

  test('assertDepartmentInScope y assertBranchInScope', () => {
    expect(() => orgScope.assertDepartmentInScope(scope, 4)).not.toThrow();
    expect(() => orgScope.assertBranchInScope(scope, 2)).not.toThrow();
    expect(() => orgScope.assertDepartmentInScope(scope, 99)).toThrow(/alcance/i);
    expect(() => orgScope.assertBranchInScope(scope, 99)).toThrow(/alcance/i);
  });

  test('canSeeCostCenter: por empresa; sin empresa sólo global', () => {
    expect(orgScope.canSeeCostCenter(scope, { company_id: 9 })).toBe(true);
    expect(orgScope.canSeeCostCenter(scope, { company_id: 1 })).toBe(false);
    expect(orgScope.canSeeCostCenter(scope, { company_id: null })).toBe(false);
    expect(orgScope.canSeeCostCenter({ unrestricted: true }, { company_id: null })).toBe(true);
  });
});
