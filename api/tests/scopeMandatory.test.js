/**
 * scopeMandatory.test.js — el alcance es OBLIGATORIO.
 *
 * Un alcance ausente, nulo, mal formado o un literal `{ unrestricted: true }`
 * que no emitió el servidor NO da acceso: filtros sin filas, predicados en
 * false y `assert*` en 403. El global sólo lo emiten los resolutores
 * (departmentScope.getVisibleDepartmentIds / orgScope.getOrgScope para un rol
 * global) y el alcance explícito de tareas internas (departmentScope.systemScope).
 */
const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const { sequelize } = require('../src/config/database');
const scopeGrant = require('../src/services/scopeGrant');
const departmentScope = require('../src/services/departmentScope');
const orgScope = require('../src/services/orgScope');
const governance = require('../src/services/governance');

const INVALID = [
  ['undefined', undefined],
  ['null', null],
  ['literal { unrestricted: true } no emitido', { unrestricted: true }],
  ['objeto vacío', {}],
  ['string', 'admin'],
  ['booleano', true],
  ['ids no numéricos', { unrestricted: false, ids: ['1'], companyIds: ['1'], branchIds: ['1'], departmentIds: ['1'] }],
  ['ids negativos', { unrestricted: false, ids: [-1], companyIds: [-1], branchIds: [-1], departmentIds: [-1] }],
  ['unrestricted ausente', { ids: [1], companyIds: [1], branchIds: [1], departmentIds: [1] }],
];

beforeEach(() => {
  sequelize.query.mockReset();
  sequelize.query.mockResolvedValue([[]]);
});

describe('scopeGrant', () => {
  test('sólo el emitido es global; el literal no', () => {
    const g = scopeGrant.issueGlobal();
    expect(scopeGrant.isGlobal(g)).toBe(true);
    expect(Object.isFrozen(g)).toBe(true);
    expect(scopeGrant.isGlobal({ unrestricted: true })).toBe(false);
    expect(scopeGrant.isGlobal({ ...g })).toBe(false); // una copia no es el emitido
    expect(scopeGrant.isGlobal(null)).toBe(false);
  });

  test('isRestricted exige unrestricted === false y listas de ids positivos', () => {
    expect(scopeGrant.isRestricted({ unrestricted: false, ids: [] }, ['ids'])).toBe(true);
    expect(scopeGrant.isRestricted({ unrestricted: false, ids: [1, 2] }, ['ids'])).toBe(true);
    expect(scopeGrant.isRestricted({ unrestricted: false }, ['ids'])).toBe(false);
    expect(scopeGrant.isRestricted({ unrestricted: 0, ids: [1] }, ['ids'])).toBe(false);
    expect(scopeGrant.isRestricted({ unrestricted: false, ids: [1.5] }, ['ids'])).toBe(false);
  });
});

describe('resolutores: el global lo emite el servidor sólo para roles globales', () => {
  test.each(['super_admin', 'admin', 'gth', 'hr'])('%s → global emitido, sin consultar la base', async (role) => {
    expect(departmentScope.isGlobal(await departmentScope.getVisibleDepartmentIds({ id: 1, role }))).toBe(true);
    expect(orgScope.isGlobal(await orgScope.getOrgScope({ id: 1, role }))).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
  test.each(['manager', 'coordinator', 'supervisor', 'gestor', 'employee', undefined])('%s → nunca global', async (role) => {
    expect(departmentScope.isGlobal(await departmentScope.getVisibleDepartmentIds({ id: 1, role }))).toBe(false);
    expect(orgScope.isGlobal(await orgScope.getOrgScope({ id: 1, role }))).toBe(false);
  });
});

describe.each(INVALID)('alcance inválido (%s) → sin acceso', (_label, bad) => {
  test('departmentScope: filtro sin filas y predicado en false', () => {
    expect(departmentScope.applyDepartmentScope('WHERE 1=1', [], bad).where).toBe('WHERE 1=1 AND 1=0');
    expect(departmentScope.canSeeEmployee(bad, { department_id: 1 })).toBe(false);
    expect(departmentScope.isGlobal(bad)).toBe(false);
  });

  test('orgScope: filtros sin filas, predicados en false', () => {
    expect(orgScope.isGlobal(bad)).toBe(false);
    expect(orgScope.isValidScope(bad)).toBe(false);
    expect(orgScope.companyFilter(bad, 'id').clause).toBe('AND 1=0');
    expect(orgScope.candidateScopeFilter(bad).clause).toBe('AND 1=0');
    expect(orgScope.calendarScopeFilter(bad).clause).toBe('AND 1=0');
    expect(orgScope.canSeeCompany(bad, { id: 1 })).toBe(false);
    expect(orgScope.canSeeCostCenter(bad, { company_id: 1 })).toBe(false);
    expect(orgScope.canSeeEmployeeRefs(bad, { department_id: 1, branch_id: 1 })).toBe(false);
    expect(orgScope.canSeeCandidateRefs(bad, { company_id: 1, branch_id: null })).toBe(false);
    // Tampoco ve los calendarios globales.
    expect(orgScope.canSeeCalendar(bad, { company_id: null, branch_id: null })).toBe(false);
  });

  test('orgScope: todo assert rechaza con 403, incluso sin referencia', () => {
    for (const fn of [orgScope.assertCompanyInScope, orgScope.assertBranchInScope, orgScope.assertDepartmentInScope]) {
      for (const ref of [1, null]) {
        let err;
        try { fn(bad, ref); } catch (e) { err = e; }
        expect(err).toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
      }
    }
    expect(() => orgScope.assertGlobalScope(bad)).toThrow(/global/);
  });

  test('governance: listados sin filas y lecturas por id en null', async () => {
    await governance.listCompanies(bad);
    await governance.listCostCenters(bad);
    for (const [sql] of sequelize.query.mock.calls) expect(sql).toMatch(/AND 1=0/);
    sequelize.query.mockResolvedValue([[{ id: 1, company_id: 1 }]]);
    expect(await governance.getCompany(1, bad)).toBeNull();
    expect(await governance.getCostCenter(1, bad)).toBeNull();
  });
});

describe('controles positivos', () => {
  const GLOBAL = scopeGrant.issueGlobal();
  const A = { unrestricted: false, companyIds: [1], branchIds: [2], departmentIds: [3] };

  test('global emitido: sin filtro y todo visible', async () => {
    expect(orgScope.companyFilter(GLOBAL, 'id').clause).toBe('');
    expect(orgScope.canSeeCompany(GLOBAL, { id: 99 })).toBe(true);
    expect(() => orgScope.assertCompanyInScope(GLOBAL, 99)).not.toThrow();
    expect(() => orgScope.assertGlobalScope(GLOBAL)).not.toThrow();
    expect(departmentScope.applyDepartmentScope('WHERE 1=1', [], GLOBAL).where).toBe('WHERE 1=1');
    await governance.listCompanies(GLOBAL);
    expect(sequelize.query.mock.calls[0][0]).not.toMatch(/1=0|IN \(/);
  });

  test('restringido válido: propio sí, ajeno no', () => {
    expect(orgScope.canSeeCompany(A, { id: 1 })).toBe(true);
    expect(orgScope.canSeeCompany(A, { id: 9 })).toBe(false);
    expect(() => orgScope.assertCompanyInScope(A, 1)).not.toThrow();
    expect(() => orgScope.assertCompanyInScope(A, 9)).toThrow(/alcance/);
    expect(() => orgScope.assertCompanyInScope(A, null)).not.toThrow(); // sin referencia: nada que cruzar
    expect(() => orgScope.assertGlobalScope(A)).toThrow(/global/);
  });
});

describe('guardia estática sobre src/', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  }(SRC));
  const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
  const code = (p) => fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('issueGlobal sólo lo usan los resolutores de alcance', () => {
    const users = files.filter((f) => /issueGlobal\s*\(/.test(code(f))).map(rel).sort();
    expect(users).toEqual(['services/departmentScope.js', 'services/orgScope.js', 'services/scopeGrant.js']);
  });

  test('systemScope sólo lo usa el job interno de reportes programados', () => {
    const users = files.filter((f) => /systemScope\s*\(/.test(code(f))).map(rel).sort();
    expect(users).toEqual(['services/departmentScope.js', 'services/scheduler.js']);
  });

  test('ningún default de alcance global ni bypass por alcance ausente', () => {
    const bad = [];
    const patterns = [
      /=\s*\{\s*unrestricted\s*:\s*true\s*\}/,                // default / asignación de global a mano
      /!\s*scope\s*\|\|\s*scope\.unrestricted/,               // ausente ⇒ global
      /scope\s*&&\s*!\s*scope\.unrestricted/,                 // ausente ⇒ salta el control
      /return\s*\{\s*unrestricted\s*:\s*true\s*\}/,           // resolutor que devuelve un literal
    ];
    for (const f of files) {
      const c = code(f);
      for (const re of patterns) if (re.test(c)) bad.push(`${rel(f)} ~ ${re}`);
    }
    expect(bad).toEqual([]);
  });
});
