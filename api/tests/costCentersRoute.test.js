/**
 * costCentersRoute.test.js — writer fail-closed, validación de company_id y
 * auditoría del ABM de centros de costo.
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
const router = require('../src/routes/costCenters');

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

test('GET lista centros de costo', async () => {
  sequelize.query.mockResolvedValueOnce([[{ id: 1, code: 'CC1', name: 'Admin', company_id: null }]]);
  const res = mkRes();
  await handlerFor('get', '/')({ user: USER }, res, jest.fn());
  expect(res.json).toHaveBeenCalledWith({ data: [{ id: 1, code: 'CC1', name: 'Admin', company_id: null }] });
});

test('POST fail-closed con flag apagado → 503', async () => {
  delete process.env.GOVERNANCE_WRITE_ENABLED;
  const res = mkRes();
  const next = jest.fn();
  await handlerFor('post', '/')(
    { user: USER, body: { code: 'CC1', name: 'Admin', active: true }, correlationId: 'c1', headers: {} },
    res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(503);
  expect(sequelize.query).not.toHaveBeenCalled();
});

test('POST con company_id inexistente → 400', async () => {
  process.env.GOVERNANCE_WRITE_ENABLED = 'true';
  sequelize.query.mockResolvedValueOnce([[]]); // companyExists → no existe
  const res = mkRes();
  await handlerFor('post', '/')(
    { user: USER, body: { company_id: 99, code: 'CC1', name: 'Admin', active: true }, correlationId: 'c2', headers: {} },
    res, jest.fn(),
  );
  expect(res.status).toHaveBeenCalledWith(400);
  expect(audit.log).not.toHaveBeenCalled();
});

test('POST válido inserta, 201 y audita', async () => {
  process.env.GOVERNANCE_WRITE_ENABLED = 'true';
  sequelize.query.mockResolvedValueOnce([3, 1]); // createCostCenter, forma REAL [insertId, affectedRows] (company_id null → sin lookup)
  const res = mkRes();
  await handlerFor('post', '/')(
    { user: USER, body: { company_id: null, code: 'CC1', name: 'Admin', active: true }, correlationId: 'c3', headers: {} },
    res, jest.fn(),
  );
  expect(res.status).toHaveBeenCalledWith(201);
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(audit.log.mock.calls[0][0].action).toBe('cost_center.create');
});
