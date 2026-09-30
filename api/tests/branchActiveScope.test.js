/**
 * branchActiveScope.test.js — roles por sede: la sede debe existir y estar ACTIVA.
 *
 * La prueba con MySQL real (tests/it/orgScope.it.test.js) cubre sede
 * inexistente, inactiva y reactivada; acá se fija el contrato de la consulta
 * y el efecto de un alcance vacío sobre los datos organizacionales.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const orgScope = require('../src/services/orgScope');

beforeEach(() => sequelize.query.mockReset());

describe('resolución de la sede de la cuenta', () => {
  test('la consulta exige cuenta activa y sede existente y activa (JOIN branches.active = 1)', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    await departmentScope.getVisibleDepartmentIds({ id: 7, role: 'manager' });
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/FROM users u\s+JOIN branches b ON b\.id = u\.branch_id AND b\.active = 1\s+WHERE u\.id = \? AND u\.active = 1/);
    expect(opts.replacements).toEqual([7]);
  });

  test('sin fila (sin sede, sede inexistente o inactiva) → alcance vacío y no consulta departamentos', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    const s = await departmentScope.getVisibleDepartmentIds({ id: 7, role: 'manager' });
    expect(s).toEqual({ unrestricted: false, ids: [], branchIds: [] });
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  test('sede activa → departamentos activos de esa sede', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ branch_id: 3 }]])
      .mockResolvedValueOnce([[{ id: 10 }, { id: 11 }]]);
    const s = await departmentScope.getVisibleDepartmentIds({ id: 7, role: 'coordinator' });
    expect(s).toEqual({ unrestricted: false, ids: [10, 11], branchIds: [3] });
  });

  test('error de lectura → alcance vacío (fail-closed)', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'));
    expect(await departmentScope.getVisibleDepartmentIds({ id: 7, role: 'manager' }))
      .toEqual({ unrestricted: false, ids: [], branchIds: [] });
  });

  test('roles globales no dependen de la sede (no consultan)', async () => {
    const s = await orgScope.getOrgScope({ id: 1, role: 'admin' });
    expect(orgScope.isGlobal(s)).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('sin sede activa no hay datos organizacionales', () => {
  const EMPTY = { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] };

  test('tampoco ve calendarios globales ni pasa el filtro de calendarios', () => {
    expect(orgScope.canSeeCalendar(EMPTY, { company_id: null, branch_id: null })).toBe(false);
    expect(orgScope.calendarScopeFilter(EMPTY).clause).toBe('AND 1=0');
  });

  test('empresas, centros, candidatos: filtros sin filas y predicados en false', () => {
    expect(orgScope.companyFilter(EMPTY, 'id').clause).toBe('AND 1=0');
    expect(orgScope.candidateScopeFilter(EMPTY).clause).toBe('AND 1=0');
    expect(orgScope.canSeeCompany(EMPTY, { id: 1 })).toBe(false);
    expect(orgScope.canSeeCostCenter(EMPTY, { company_id: 1 })).toBe(false);
    expect(() => orgScope.assertCompanyInScope(EMPTY, 1)).toThrow(/alcance/);
    expect(() => orgScope.assertBranchInScope(EMPTY, 1)).toThrow(/alcance/);
  });

  test('con sede activa el global sigue visible (control)', () => {
    const A = { unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4] };
    expect(orgScope.canSeeCalendar(A, { company_id: null, branch_id: null })).toBe(true);
    expect(orgScope.calendarScopeFilter(A).clause).toMatch(/IS NULL/);
  });
});
