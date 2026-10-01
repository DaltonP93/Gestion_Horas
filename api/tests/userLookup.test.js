'use strict';

/**
 * userLookup.test.js — reglas puras de GET /api/users/lookup y la ruta con
 * base simulada. La conducta con MySQL real (sedes, cuentas cruzadas,
 * comodines) está en tests/it/usersLookup.it.test.js.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  authorize: () => (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/config/securityPreflight', () => ({ isDefaultAdminPassword: () => false }));

const { sequelize } = require('../src/config/database');
const scopeGrant = require('../src/services/scopeGrant');
const L = require('../src/services/userLookup');

const ROLES = new Set(['super_admin', 'admin', 'gth', 'hr', 'manager', 'coordinator', 'gestor', 'supervisor', 'employee']);
const GLOBAL = scopeGrant.issueGlobal();
const BRANCH = (...branchIds) => ({ unrestricted: false, ids: [7], branchIds });

beforeEach(() => jest.clearAllMocks());

describe('escapeLike', () => {
  test('%, _ y ! quedan literales con ESCAPE "!"; \\ no es especial', () => {
    expect(L.escapeLike('50%off')).toBe('50!%off');
    expect(L.escapeLike('a_b')).toBe('a!_b');
    expect(L.escapeLike('hola!')).toBe('hola!!');
    expect(L.escapeLike('c\\d')).toBe('c\\d');
    expect(L.escapeLike('normal')).toBe('normal');
  });
});

describe('validateLookupQuery', () => {
  test('sin parámetros, vacíos o válidos', () => {
    expect(L.validateLookupQuery({}, ROLES)).toEqual({ ok: true, value: { roles: null, search: null } });
    expect(L.validateLookupQuery({ role: '', search: '   ' }, ROLES)).toEqual({ ok: true, value: { roles: null, search: null } });
    expect(L.validateLookupQuery({ role: 'manager, hr,manager', search: '  ana  ' }, ROLES))
      .toEqual({ ok: true, value: { roles: ['manager', 'hr'], search: 'ana' } });
    expect(L.validateLookupQuery({ search: 'x'.repeat(L.SEARCH_MAX) }, ROLES).ok).toBe(true);
  });
  test.each([
    ['role arreglo', { role: ['manager', 'hr'] }],
    ['role objeto', { role: { x: 'manager' } }],
    ['role desconocido', { role: 'boss' }],
    ['role con elemento vacío', { role: 'manager,,hr' }],
    ['role con coma final', { role: 'manager,' }],
    ['role con coma inicial', { role: ',manager' }],
    ['role sólo comas', { role: ',' }],
    ['search arreglo', { search: ['a', 'b'] }],
    ['search objeto', { search: { x: 'a' } }],
    ['search demasiado largo', { search: 'x'.repeat(L.SEARCH_MAX + 1) }],
  ])('%s → error', (_l, q) => {
    expect(L.validateLookupQuery(q, ROLES).ok).toBe(false);
  });
});

describe('accountBranchFilter', () => {
  test('global emitido → sin filtro', () => {
    expect(L.accountBranchFilter(GLOBAL)).toEqual({ sql: '', params: [] });
  });
  test('restringido con sedes → por users.branch_id (nunca employee_id)', () => {
    const f = L.accountBranchFilter(BRANCH(3));
    expect(f).toEqual({ sql: ' AND u.branch_id IN (?)', params: [3] });
    expect(f.sql).not.toMatch(/employee/);
  });
  test.each([
    ['sin sede (branchIds vacío)', { unrestricted: false, ids: [], branchIds: [] }],
    ['literal { unrestricted: true } no emitido', { unrestricted: true }],
    ['ausente', undefined],
    ['nulo', null],
    ['sin branchIds', { unrestricted: false, ids: [1] }],
    ['branchIds mal formado', { unrestricted: false, ids: [], branchIds: ['3'] }],
  ])('%s → null (lista vacía, sin fallback global)', (_l, scope) => {
    expect(L.accountBranchFilter(scope)).toBeNull();
  });
});

describe('buildLookupQuery', () => {
  test('rol por sede + role + search: intersección de los tres filtros', () => {
    const q = L.buildLookupQuery(BRANCH(3), { roles: ['manager', 'hr'], search: '50%' });
    expect(q.sql).toMatch(/WHERE u\.active = 1 AND u\.role IN \(\?,\?\) AND \(u\.full_name LIKE \? ESCAPE '!' OR u\.username LIKE \? ESCAPE '!'\) AND u\.branch_id IN \(\?\)/);
    expect(q.sql).toMatch(/SELECT u\.id, u\.full_name, u\.username, u\.role, u\.employee_id\s+FROM users u/);
    expect(q.sql).toMatch(/ORDER BY u\.full_name LIMIT 500$/);
    expect(q.params).toEqual(['manager', 'hr', '%50!%%', '%50!%%', 3]);
  });
  test('global: sin filtro de sede', () => {
    const q = L.buildLookupQuery(GLOBAL, { roles: null, search: null });
    expect(q.sql).not.toMatch(/branch_id/);
    expect(q.params).toEqual([]);
  });
  test('sin alcance → null', () => {
    expect(L.buildLookupQuery({ unrestricted: false, ids: [], branchIds: [] }, { roles: null, search: null })).toBeNull();
  });
});

describe('ruta GET /lookup (base simulada)', () => {
  const router = require('../src/routes/users');
  const handler = () => {
    const layer = router.stack.find((l) => l.route && l.route.path === '/lookup' && l.route.methods.get);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  };
  const mkRes = () => {
    const res = {};
    res.status = jest.fn(function () { return this; });
    res.json = jest.fn(function () { return this; });
    return res;
  };

  test('parámetro inválido → 400 INVALID_INPUT sin consultar la base', async () => {
    const res = mkRes();
    await handler()({ user: { id: 1, role: 'admin' }, query: { role: 'boss' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String), code: 'INVALID_INPUT' });
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('manager sin sede activa → [] sin consultar usuarios', async () => {
    sequelize.query.mockResolvedValueOnce([[]]); // resolución de alcance: sin sede activa
    const res = mkRes();
    await handler()({ user: { id: 5, role: 'manager' }, query: {} }, res);
    expect(res.json).toHaveBeenCalledWith([]);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    expect(sequelize.query.mock.calls[0][0]).not.toMatch(/FROM users u WHERE u\.active = 1/);
  });

  test('manager con sede → filtra por users.branch_id de su sede', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ branch_id: 4 }]])   // sede de la cuenta (activa)
      .mockResolvedValueOnce([[{ id: 9 }]])          // departamentos de la sede
      .mockResolvedValueOnce([[{ id: 11, full_name: 'X', username: 'x', role: 'employee', employee_id: null }]]);
    const res = mkRes();
    await handler()({ user: { id: 5, role: 'manager' }, query: { role: 'employee' } }, res);
    const [sql, opts] = sequelize.query.mock.calls[2];
    expect(sql).toMatch(/AND u\.branch_id IN \(\?\)/);
    expect(opts.replacements).toEqual(['employee', 4]);
    expect(res.json).toHaveBeenCalledWith([{ id: 11, full_name: 'X', username: 'x', role: 'employee', employee_id: null }]);
  });

  test('error de base → 500 genérico', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('ER_SECRET_DETAIL'));
    const res = mkRes();
    await handler()({ user: { id: 1, role: 'admin' }, query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error al buscar usuarios' });
  });
});
