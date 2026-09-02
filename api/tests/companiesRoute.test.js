/**
 * companiesRoute.test.js — ABM de empresas: lectura, writer fail-closed,
 * auditoría y manejo de duplicados. DB mockeada; governance/redact reales.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_req, _res, next) => next() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const router = require('../src/routes/companies');

function handlerFor(method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}
const USER = { id: 7, username: 'admin', role: 'admin' };
const ORIG = process.env.GOVERNANCE_WRITE_ENABLED;

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  if (ORIG === undefined) delete process.env.GOVERNANCE_WRITE_ENABLED;
  else process.env.GOVERNANCE_WRITE_ENABLED = ORIG;
});

describe('GET /api/companies', () => {
  test('devuelve la lista', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, code: 'A', legal_name: 'ACME' }]]);
    const res = mkRes();
    await handlerFor('get', '/')({ user: USER }, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ data: [{ id: 1, code: 'A', legal_name: 'ACME' }] });
  });
});

describe('POST /api/companies — writer fail-closed', () => {
  test('con el flag apagado rechaza con 503 y NO inserta ni audita', async () => {
    delete process.env.GOVERNANCE_WRITE_ENABLED;
    const res = mkRes();
    const next = jest.fn();
    await handlerFor('post', '/')(
      { user: USER, body: { code: 'A', legal_name: 'ACME', active: true }, correlationId: 'c1', headers: {} },
      res, next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].status).toBe(503);
    expect(next.mock.calls[0][0].code).toBe('GOVERNANCE_WRITES_DISABLED');
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('con el flag encendido inserta, responde 201 y audita', async () => {
    process.env.GOVERNANCE_WRITE_ENABLED = 'true';
    sequelize.query.mockResolvedValueOnce([55, 1]); // forma REAL: [insertId, affectedRows]
    const res = mkRes();
    await handlerFor('post', '/')(
      { user: USER, body: { code: 'A', legal_name: 'ACME', tax_id: '80012345-6', active: true, reason: 'alta' }, correlationId: 'c2', headers: {} },
      res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const call = audit.log.mock.calls[0][0];
    expect(call.action).toBe('company.create');
    expect(call.entity_id).toBe(55);
    // tax_id redactado en la auditoría
    expect(JSON.stringify(call.details)).toContain('[REDACTED]');
    expect(JSON.stringify(call.details)).not.toContain('80012345-6');
  });

  test('duplicado → 409', async () => {
    process.env.GOVERNANCE_WRITE_ENABLED = 'true';
    const dup = Object.assign(new Error('dup'), { original: { code: 'ER_DUP_ENTRY' } });
    sequelize.query.mockRejectedValueOnce(dup);
    const res = mkRes();
    await handlerFor('post', '/')(
      { user: USER, body: { code: 'A', legal_name: 'ACME', active: true }, correlationId: 'c3', headers: {} },
      res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/companies/:id', () => {
  test('404 si no existe', async () => {
    process.env.GOVERNANCE_WRITE_ENABLED = 'true';
    sequelize.query.mockResolvedValueOnce([[]]); // getCompany → vacío
    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { user: USER, params: { id: '9' }, body: { legal_name: 'X' }, correlationId: 'c4', headers: {} },
      res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('sin cambios reales responde changed:false y no audita', async () => {
    process.env.GOVERNANCE_WRITE_ENABLED = 'true';
    sequelize.query.mockResolvedValueOnce([[{ id: 9, code: 'A', legal_name: 'ACME', trade_name: null, tax_id: null, active: 1 }]]);
    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { user: USER, params: { id: '9' }, body: { legal_name: 'ACME' }, correlationId: 'c5', headers: {} },
      res, jest.fn(),
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true, changed: false });
    expect(audit.log).not.toHaveBeenCalled();
  });
});
