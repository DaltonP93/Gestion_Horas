/**
 * peopleScope.test.js — P1-A (F2): AISLAMIENTO real de candidatos y
 * asignaciones por alcance organizacional. Cubre denegaciones cross-scope con
 * la DB mockeada; la variante contra MySQL real está en tests/it/people.it.test.js.
 */
jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const tx = { commit: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue() };
  const transaction = jest.fn().mockResolvedValue(tx);
  return { sequelize: { query, transaction, __tx: tx } };
});
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_r, _s, n) => n() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const orgScope = require('../src/services/orgScope');
const people = require('../src/services/people');
const audit = require('../src/services/audit');

// Alcance de un manager: empresa 9, sucursal 2, depto 4.
const SCOPED = { unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4] };

afterEach(() => jest.clearAllMocks());

describe('orgScope — visibilidad JERÁRQUICA de candidatos (P1-A v2)', () => {
  test('branch_id manda: NO hay fallback a empresa (anti-fuga entre sucursales)', () => {
    // Candidato de sucursal 3 (empresa 9, MISMA empresa que el actor) → NO visible:
    // el actor sólo tiene la sucursal 2. Antes se filtraba por empresa y fugaba.
    expect(orgScope.canSeeCandidateRefs(SCOPED, { company_id: 9, branch_id: 3 })).toBe(false);
    expect(orgScope.canSeeCandidateRefs(SCOPED, { company_id: 9, branch_id: 2 })).toBe(true);  // su sucursal
    // Sin sucursal: cae a empresa.
    expect(orgScope.canSeeCandidateRefs(SCOPED, { company_id: 9, branch_id: null })).toBe(true);
    expect(orgScope.canSeeCandidateRefs(SCOPED, { company_id: 1, branch_id: null })).toBe(false); // otra empresa
    // Sin alcance → sólo global.
    expect(orgScope.canSeeCandidateRefs(SCOPED, { company_id: null, branch_id: null })).toBe(false);
    expect(orgScope.canSeeCandidateRefs({ unrestricted: true }, { company_id: null, branch_id: null })).toBe(true);
  });

  test('empleado: visible por departamento o sucursal', () => {
    expect(orgScope.canSeeEmployeeRefs(SCOPED, { department_id: 4, branch_id: null })).toBe(true);
    expect(orgScope.canSeeEmployeeRefs(SCOPED, { department_id: null, branch_id: 2 })).toBe(true);
    expect(orgScope.canSeeEmployeeRefs(SCOPED, { department_id: 99, branch_id: 99 })).toBe(false);
    expect(orgScope.canSeeEmployeeRefs(SCOPED, null)).toBe(false);
  });

  test('candidateScopeFilter: mismo criterio jerárquico en SQL', () => {
    const f = orgScope.candidateScopeFilter(SCOPED, { companyCol: 'c.company_id', branchCol: 'c.branch_id' });
    // (branch NOT NULL AND branch IN (…)) OR (branch NULL AND company IN (…))
    expect(f.clause).toMatch(/c\.branch_id IS NOT NULL AND c\.branch_id IN/);
    expect(f.clause).toMatch(/c\.branch_id IS NULL AND c\.company_id IN/);
    expect(f.params).toEqual([2, 9]);
    // unrestricted → sin filtro
    expect(orgScope.candidateScopeFilter({ unrestricted: true }).clause).toBe('');
    // sin ids → 1=0 (nada)
    expect(orgScope.candidateScopeFilter({ unrestricted: false, companyIds: [], branchIds: [] }).clause).toBe('AND 1=0');
  });
});

describe('listCandidates — filtra por alcance en SQL', () => {
  test('rol con alcance: agrega cláusula de sucursal/empresa y sus params', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    await people.listCandidates({}, SCOPED);
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/c\.branch_id IN/);
    expect(sql).toMatch(/c\.company_id IN/);
    expect(opts.replacements).toEqual(expect.arrayContaining([2, 9]));
  });

  test('unrestricted: sin cláusula de alcance', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    await people.listCandidates({}, { unrestricted: true });
    expect(sequelize.query.mock.calls[0][0]).not.toMatch(/IN \(/);
  });
});

describe('convertCandidate — denegaciones cross-scope', () => {
  test('empleado destino fuera de alcance → 403 (sin abrir transacción)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])                       // employeeExists
      .mockResolvedValueOnce([[{ department_id: 99, branch_id: 99 }]]); // loadEmployeeOrgRefs (fuera)
    await expect(people.convertCandidate(1, 50, SCOPED)).rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('candidato fuera de alcance → 404 (no filtra existencia)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])                       // employeeExists
      .mockResolvedValueOnce([[{ department_id: 4, branch_id: 2 }]]) // empleado en alcance
      .mockResolvedValueOnce([[{ id: 1, status: 'offer', company_id: 1, branch_id: 3, converted_employee_id: null }]]); // FOR UPDATE, candidato de otra empresa
    await expect(people.convertCandidate(1, 50, SCOPED)).rejects.toMatchObject({ status: 404, code: 'CANDIDATE_NOT_FOUND' });
    expect(sequelize.__tx.rollback).toHaveBeenCalled();
  });

  test('en alcance: convierte (feliz)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])
      .mockResolvedValueOnce([[{ department_id: 4, branch_id: 2 }]])
      .mockResolvedValueOnce([[{ id: 1, status: 'offer', company_id: 9, branch_id: 2, converted_employee_id: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const r = await people.convertCandidate(1, 50, SCOPED);
    expect(r).toMatchObject({ candidate_id: 1, converted_employee_id: 50 });
  });
});

describe('validateCandidateRefs — existencia, alcance y coherencia', () => {
  test('sucursal fuera de alcance → 403', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: 1 }]]);
    await expect(people.validateCandidateRefs(SCOPED, { branch_id: 3 })).rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
  });

  test('sucursal que no pertenece a la empresa indicada → 400 INCOHERENT_SCOPE', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 2, company_id: 9 }]]); // branch 2 → empresa 9
    await expect(people.validateCandidateRefs(SCOPED, { branch_id: 2, company_id: 5 }))
      .rejects.toMatchObject({ status: 400, code: 'INCOHERENT_SCOPE' });
  });

  test('refs coherentes y en alcance → ok', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 2, company_id: 9 }]]) // branch en alcance, coherente
      .mockResolvedValueOnce([[{ id: 9 }]]);               // company existe/en alcance
    await expect(people.validateCandidateRefs(SCOPED, { branch_id: 2, company_id: 9 })).resolves.toBeUndefined();
  });

  test('actor con alcance NO puede crear candidato SIN alcance (ambos NULL) → 403', async () => {
    await expect(people.validateCandidateRefs(SCOPED, { company_id: null, branch_id: null }))
      .rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('rol global SÍ puede crear candidato sin alcance', async () => {
    await expect(people.validateCandidateRefs({ unrestricted: true }, { company_id: null, branch_id: null }))
      .resolves.toBeUndefined();
  });
});

describe('rutas — denegación cross-scope (integración de handler)', () => {
  function handlerFor(router, method, path) {
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
  // getOrgScope de un manager consulta employees.branch_id y branches.company_id.
  function mockScopeResolution({ branchId = 2, companyId = 9 } = {}) {
    // departmentScope.getVisibleDepartmentIds → SELECT department_id; luego CTE.
    sequelize.query
      .mockResolvedValueOnce([[{ department_id: 4 }]])   // employees.department_id (deptScope)
      .mockResolvedValueOnce([[{ id: 4 }]])              // CTE descendientes
      .mockResolvedValueOnce([[{ branch_id: branchId }]]) // employees.branch_id (orgScope)
      .mockResolvedValueOnce([[{ company_id: companyId }]]); // branches.company_id
  }
  const MANAGER = { id: 11, role: 'manager', employee_id: 500 };

  test('GET /candidates/:id de otra empresa → 404', async () => {
    const candidates = require('../src/routes/candidates');
    sequelize.query.mockResolvedValueOnce([[{ id: 1, company_id: 1, branch_id: 3 }]]); // getCandidate (otra empresa)
    mockScopeResolution();
    const res = mkRes();
    await handlerFor(candidates, 'get', '/:id')({ user: MANAGER, params: { id: '1' }, query: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('POST /assignments/employee/:id fuera de alcance → 403 OUT_OF_SCOPE', async () => {
    process.env.PEOPLE_WRITE_ENABLED = 'true';
    const assignments = require('../src/routes/assignments');
    mockScopeResolution();
    sequelize.query.mockResolvedValueOnce([[{ id: 77, department_id: 99, branch_id: 88 }]]); // loadEmployeeOrgRefs (fuera)
    const res = mkRes(); const next = jest.fn();
    await handlerFor(assignments, 'post', '/employee/:id')(
      { user: MANAGER, params: { id: '77' }, body: { valid_from: '2026-01-01' }, correlationId: 'c', headers: {} }, res, next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('OUT_OF_SCOPE');
    delete process.env.PEOPLE_WRITE_ENABLED;
  });

  test('GET /assignments/employee/:id fuera de alcance → 404 (no audita nada)', async () => {
    const assignments = require('../src/routes/assignments');
    mockScopeResolution();
    sequelize.query.mockResolvedValueOnce([[{ id: 77, department_id: 99, branch_id: 88 }]]); // loadEmployeeOrgRefs (fuera)
    const res = mkRes();
    await handlerFor(assignments, 'get', '/employee/:id')({ user: MANAGER, params: { id: '77' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
