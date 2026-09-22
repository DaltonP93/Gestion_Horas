jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn(async fn => fn({})) },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: jest.fn(() => (_req, _res, next) => next()),
  requirePermission: jest.fn(() => (_req, _res, next) => next()),
}));
jest.mock('../src/services/orgScope', () => ({ getOrgScope: jest.fn() }));
jest.mock('../src/services/governance', () => ({ assertWriteEnabled: jest.fn() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const { requirePermission } = require('../src/middleware/auth');
const { getOrgScope } = require('../src/services/orgScope');
const governance = require('../src/services/governance');
const audit = require('../src/services/audit');
const router = require('../src/routes/branches');
const configuredPermissions = requirePermission.mock.calls.map(args => args);

function handlerFor(method, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error('Route missing: ' + method + ' ' + path);
  return layer.route.stack.at(-1).handle;
}
function response() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}
const actor = { id: 17, role: 'supervisor' };
beforeEach(() => jest.clearAllMocks());

describe('GET /api/branches: alcance por sede', () => {
  test('supervisor sin sede: catálogo vacío sin leer otras sedes', async () => {
    getOrgScope.mockResolvedValue({ unrestricted: false, branchIds: [] });
    const res = response();
    await handlerFor('get', '/')({ user: actor, query: {} }, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith([]);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('supervisor: SQL restringe por su sede aun al pedir activas', async () => {
    getOrgScope.mockResolvedValue({ unrestricted: false, branchIds: [3] });
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: 9 }]]);
    const res = response();
    await handlerFor('get', '/')({ user: actor, query: { active: '1' } }, res, jest.fn());
    const [sql, options] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/b\.id IN \(\?\)/);
    expect(sql).toMatch(/b\.active = \?/);
    expect(options.replacements).toEqual([1, 3]);
    expect(res.json).toHaveBeenCalledWith([{ id: 3, company_id: 9 }]);
  });

  test('global: mantiene catálogo completo', async () => {
    getOrgScope.mockResolvedValue({ unrestricted: true });
    sequelize.query.mockResolvedValueOnce([[{ id: 3 }, { id: 4 }]]);
    const res = response();
    await handlerFor('get', '/')({ user: { role: 'admin' }, query: {} }, res, jest.fn());
    expect(sequelize.query.mock.calls[0][0]).not.toMatch(/b\.id IN/);
    expect(res.json).toHaveBeenCalledWith([{ id: 3 }, { id: 4 }]);
  });

  test('detalle de sede ajena devuelve 404 sin consultar sus datos', async () => {
    getOrgScope.mockResolvedValue({ unrestricted: false, branchIds: [3] });
    const res = response();
    await handlerFor('get', '/:id')({ user: actor, params: { id: '4' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/branches/:id/company: primer vínculo controlado', () => {
  const req = { user: { id: 1, role: 'super_admin' }, params: { id: '3' }, body: { company_id: 9, confirm: 'VINCULAR' } };

  test('exige permiso de empresas y flag de gobierno', async () => {
    expect(configuredPermissions).toContainEqual(['empresas', 'update']);
    const denied = Object.assign(new Error('off'), { status: 503 });
    governance.assertWriteEnabled.mockImplementationOnce(() => { throw denied; });
    const next = jest.fn();
    await handlerFor('patch', '/:id/company')(req, response(), next);
    expect(next).toHaveBeenCalledWith(denied);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('sin confirmación exacta no toca la base', async () => {
    const res = response();
    await handlerFor('patch', '/:id/company')({ ...req, body: { company_id: 9, confirm: 'SI' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('empresa inactiva: rollback sin UPDATE', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: null }]])
      .mockResolvedValueOnce([[]]);
    const res = response();
    await handlerFor('patch', '/:id/company')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.query.mock.calls.some(([sql]) => /^UPDATE branches/.test(sql))).toBe(false);
  });

  test('sede ya vinculada a otra empresa: 409 sin UPDATE', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: 8 }]]);
    const res = response();
    await handlerFor('patch', '/:id/company')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('vincula una sola vez con lock y audita ids/conteo sin PII', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: null }]])
      .mockResolvedValueOnce([[{ id: 9 }]])
      .mockResolvedValueOnce([[{ n: 1203 }]])
      .mockResolvedValueOnce([undefined, 1]);
    const res = response();
    await handlerFor('patch', '/:id/company')(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ ok: true, changed: true, company_id: 9 });
    expect(sequelize.query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
    expect(sequelize.query.mock.calls[1][0]).toMatch(/active = 1 FOR UPDATE/);
    expect(sequelize.query.mock.calls[3][0]).toMatch(/company_id IS NULL/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'branch.company.link', entity_id: 3,
      details: { from: 'unlinked', to: 9, employees: 1203, reason: 'bootstrap' },
    }));
  });

  test('segundo envío a la misma empresa es idempotente', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: 9 }]]);
    const res = response();
    await handlerFor('patch', '/:id/company')(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ ok: true, changed: false, company_id: 9 });
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('POST /api/branches: asociación inicial opcional', () => {
  test('rechaza empresa inexistente antes del INSERT', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    const res = response();
    await handlerFor('post', '/')({
      user: { id: 1, role: 'admin' }, body: { code: 'TEST', name: 'Sede', company_id: 99 },
    }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.query.mock.calls.some(([sql]) => /^INSERT INTO branches/.test(sql))).toBe(false);
  });
  test('alta vinculada valida flag, empresa activa, FK y auditoría', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 9 }]]).mockResolvedValueOnce([42, 1]);
    const res = response();
    await handlerFor('post', '/')({
      user: { id: 1, role: 'admin' }, body: { code: 'TEST', name: 'Sede', company_id: '9' },
    }, res, jest.fn());
    expect(governance.assertWriteEnabled).toHaveBeenCalled();
    expect(sequelize.query.mock.calls[1][1].replacements.at(-1)).toBe(9);
    expect(res.json).toHaveBeenCalledWith({ id: 42, message: 'Sede creada' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'branch.company.link', entity_id: 42 }));
  });
});
