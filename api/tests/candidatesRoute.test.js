/**
 * candidatesRoute.test.js — fail-closed, conversión trazable y auditoría.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_r, _s, n) => n() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const router = require('../src/routes/candidates');

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
const ORIG = process.env.PEOPLE_WRITE_ENABLED;
beforeEach(() => jest.clearAllMocks());
afterEach(() => { if (ORIG === undefined) delete process.env.PEOPLE_WRITE_ENABLED; else process.env.PEOPLE_WRITE_ENABLED = ORIG; });

test('POST fail-closed con flag apagado → 503, sin DB ni auditoría', async () => {
  delete process.env.PEOPLE_WRITE_ENABLED;
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/')(
    { user: USER, body: { first_name: 'A', last_name: 'B' }, correlationId: 'c1', headers: {} }, res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(503);
  expect(sequelize.query).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

test('POST /:id/convert enlaza empleado existente y audita', async () => {
  process.env.PEOPLE_WRITE_ENABLED = 'true';
  sequelize.query
    .mockResolvedValueOnce([[{ id: 1, status: 'offer', converted_employee_id: null }]]) // getCandidate
    .mockResolvedValueOnce([[{ ok: 1 }]])  // employeeExists
    .mockResolvedValueOnce([{}]);          // UPDATE
  const res = mkRes();
  await handlerFor('post', '/:id/convert')(
    { user: USER, params: { id: '1' }, body: { employee_id: 50, reason: 'ok' }, correlationId: 'c2', headers: {} },
    res, jest.fn(),
  );
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, converted_employee_id: 50 }));
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(audit.log.mock.calls[0][0].action).toBe('candidate.convert');
});

test('convert con candidato ya convertido → 409 (propaga status del servicio)', async () => {
  process.env.PEOPLE_WRITE_ENABLED = 'true';
  sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'hired', converted_employee_id: 9 }]]);
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/:id/convert')(
    { user: USER, params: { id: '1' }, body: { employee_id: 50 }, correlationId: 'c3', headers: {} }, res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(409);
  expect(audit.log).not.toHaveBeenCalled();
});
