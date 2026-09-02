/**
 * payrollBaseRoute.test.js — writer fail-closed, preview no oficial e
 * integraciones apagadas.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_r, _s, n) => n() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const router = require('../src/routes/payrollBase');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No se encontró ${method} ${path}`);
  const s = layer.route.stack;
  return s[s.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}
const USER = { id: 7, username: 'admin', role: 'admin' };
const ORIG = process.env.PAYROLL_WRITE_ENABLED;
beforeEach(() => jest.clearAllMocks());
afterEach(() => { if (ORIG === undefined) delete process.env.PAYROLL_WRITE_ENABLED; else process.env.PAYROLL_WRITE_ENABLED = ORIG; });

test('POST /periods fail-closed → 503, sin DB ni auditoría', async () => {
  delete process.env.PAYROLL_WRITE_ENABLED;
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/periods')(
    { user: USER, body: { code: 'P1', label: 'Enero', period_start: '2026-01-01', period_end: '2026-01-31' }, correlationId: 'c1', headers: {} },
    res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(503);
  expect(sequelize.query).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

test('GET /integrations lista todas apagadas', async () => {
  const res = mkRes();
  await handlerFor('get', '/integrations')({ user: USER }, res, jest.fn());
  const payload = res.json.mock.calls[0][0];
  expect(payload.data.every((a) => a.enabled === false)).toBe(true);
});

test('GET /periods/:id/preview responde NO OFICIAL', async () => {
  sequelize.query
    .mockResolvedValueOnce([[{ id: 1, code: 'P1', status: 'draft' }]]) // getPeriod
    .mockResolvedValueOnce([[{ status: 'active', n: 4 }]]) // headcount
    .mockResolvedValueOnce([[{ kind: 'earning', n: 1 }]]); // conceptCounts
  const res = mkRes();
  await handlerFor('get', '/periods/:id/preview')({ user: USER, params: { id: '1' } }, res, jest.fn());
  const payload = res.json.mock.calls[0][0];
  expect(payload.official).toBe(false);
  expect(payload.disclaimer).toMatch(/NO OFICIAL/i);
});

test('POST /periods/:id/transition inválida propaga 400', async () => {
  process.env.PAYROLL_WRITE_ENABLED = 'true';
  sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'draft' }]]); // getPeriod → draft
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/periods/:id/transition')(
    { user: USER, params: { id: '1' }, body: { to: 'closed' }, correlationId: 'c2', headers: {} }, res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(400);
});
