/**
 * calendarScope.test.js — P1-B (F3): ALCANCE en rutas de calendarios y jornada.
 * Un rol con alcance ve calendarios globales + los de su empresa/sucursal, nunca
 * los de otra empresa; no puede consultar la jornada de cualquier empleado ni
 * pedir el resolutor por alcance de empresa ajena.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/workdayConfig', () => ({ loadWorkdayConfig: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_r, _s, n) => n() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const orgScope = require('../src/services/orgScope');
const router = require('../src/routes/laborCalendars');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const s = layer.route.stack;
  return s[s.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}
// Resolución de alcance de un manager (empresa 9 / sucursal 2 / depto 4).
function mockScopeResolution() {
  sequelize.query
    .mockResolvedValueOnce([[{ department_id: 4 }]]) // deptScope: employees.department_id
    .mockResolvedValueOnce([[{ id: 4 }]])            // CTE descendientes
    .mockResolvedValueOnce([[{ branch_id: 2 }]])     // orgScope: employees.branch_id
    .mockResolvedValueOnce([[{ company_id: 9 }]]);   // branches.company_id
}
const MANAGER = { id: 11, role: 'manager', employee_id: 500 };

beforeEach(() => jest.clearAllMocks());

describe('orgScope — visibilidad JERÁRQUICA de calendarios (P1-A)', () => {
  const S = { unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4] };
  test('global visible; sucursal propia visible; sucursal ajena de MISMA empresa NO', () => {
    expect(orgScope.canSeeCalendar(S, { company_id: null, branch_id: null })).toBe(true); // global
    expect(orgScope.canSeeCalendar(S, { company_id: 9, branch_id: 2 })).toBe(true);        // su sucursal
    // FUGA cerrada: sucursal 3 (ajena) de la MISMA empresa 9 → NO visible (sin fallback a empresa).
    expect(orgScope.canSeeCalendar(S, { company_id: 9, branch_id: 3 })).toBe(false);
    expect(orgScope.canSeeCalendar(S, { company_id: 9, branch_id: null })).toBe(true);      // sólo-empresa propia
    expect(orgScope.canSeeCalendar(S, { company_id: 1, branch_id: null })).toBe(false);     // otra empresa
    expect(orgScope.canSeeCalendar({ unrestricted: true }, { company_id: 1, branch_id: 3 })).toBe(true);
  });
  test('calendarScopeFilter: global + sucursal en scope + sólo-empresa (sin fallback branch)', () => {
    const f = orgScope.calendarScopeFilter(S);
    expect(f.clause).toMatch(/company_id IS NULL AND branch_id IS NULL/);      // global
    expect(f.clause).toMatch(/branch_id IN/);                                  // sucursal en scope
    expect(f.clause).toMatch(/branch_id IS NULL AND company_id IN/);           // sólo-empresa (branch NULL)
    expect(f.params).toEqual([2, 9]);
  });
});

describe('rutas — denegaciones por alcance', () => {
  test('GET /:id de otra empresa → 404 (global sí sería visible)', async () => {
    // getCalendar → calendario de empresa 1 (ajena); luego resolución de alcance.
    sequelize.query.mockResolvedValueOnce([[{ id: 5, code: 'X', company_id: 1, branch_id: null }]]);
    mockScopeResolution();
    const res = mkRes();
    await handlerFor('get', '/:id')({ user: MANAGER, params: { id: '5' }, query: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('GET /:id GLOBAL → visible para rol con alcance', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 6, code: 'G', company_id: null, branch_id: null }]]);
    mockScopeResolution();
    const res = mkRes();
    await handlerFor('get', '/:id')({ user: MANAGER, params: { id: '6' }, query: {} }, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id: 6 }) }));
  });

  test('GET /effective con empresa AJENA → 403 OUT_OF_SCOPE', async () => {
    mockScopeResolution();
    const res = mkRes();
    await handlerFor('get', '/effective')(
      { user: MANAGER, query: { company_id: '1', from: '2026-01-05', to: '2026-01-05' } }, res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('OUT_OF_SCOPE');
  });

  test('GET /workday/:empId de empleado fuera de alcance → 404', async () => {
    mockScopeResolution();
    sequelize.query.mockResolvedValueOnce([[{ id: 77, department_id: 99, branch_id: 88 }]]); // loadEmployeeOrgRefs (fuera)
    const res = mkRes();
    await handlerFor('get', '/workday/:empId')(
      { user: MANAGER, params: { empId: '77' }, query: { date: '2026-01-05' } }, res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('POST /:id/exceptions sobre calendario GLOBAL por rol con alcance → 403', async () => {
    process.env.CALENDAR_WRITE_ENABLED = 'true';
    sequelize.query.mockResolvedValueOnce([[{ id: 8, code: 'G', company_id: null, branch_id: null }]]); // getCalendar (global)
    mockScopeResolution();
    const res = mkRes();
    await handlerFor('post', '/:id/exceptions')(
      { user: MANAGER, params: { id: '8' }, body: { day: '2026-01-05', kind: 'nonworking' }, correlationId: 'c', headers: {} }, res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(403);
    delete process.env.CALENDAR_WRITE_ENABLED;
  });
});
