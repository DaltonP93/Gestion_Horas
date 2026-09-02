/**
 * assignmentsRoute.test.js — fail-closed, validación de refs/alcance,
 * atomicidad (mock) y auditoría con remuneración redactada.
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
const audit = require('../src/services/audit');
const router = require('../src/routes/assignments');

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

test('GET historial del empleado', async () => {
  sequelize.query.mockResolvedValueOnce([[{ id: 1, employee_id: 50, valid_from: '2025-01-01', valid_to: null }]]);
  const res = mkRes();
  await handlerFor('get', '/employee/:id')({ user: USER, params: { id: '50' } }, res, jest.fn());
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ employee_id: 50 }));
});

test('POST fail-closed → 503 (sin DB)', async () => {
  delete process.env.PEOPLE_WRITE_ENABLED;
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/employee/:id')(
    { user: USER, params: { id: '50' }, body: { valid_from: '2026-01-01' }, correlationId: 'c1', headers: {} }, res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(503);
  expect(sequelize.query).not.toHaveBeenCalled();
});

test('POST válido: valida ref, crea vigencia (201) y audita con salario redactado', async () => {
  process.env.PEOPLE_WRITE_ENABLED = 'true';
  sequelize.query
    .mockResolvedValueOnce([[{ id: 2 }]])   // validateAssignmentRefs: branch existe (admin→sin chequeo de alcance)
    .mockResolvedValueOnce([[{ id: 50 }]])  // createAssignment: employees FOR UPDATE
    .mockResolvedValueOnce([[]])            // SELECT open → ninguna
    .mockResolvedValueOnce([{ insertId: 3 }]); // INSERT
  const res = mkRes();
  await handlerFor('post', '/employee/:id')(
    { user: USER, params: { id: '50' }, body: { valid_from: '2026-01-01', reference_salary: 5000000, branch_id: 2 }, correlationId: 'c2', headers: {} },
    res, jest.fn(),
  );
  expect(res.status).toHaveBeenCalledWith(201);
  expect(audit.log).toHaveBeenCalledTimes(1);
  const details = JSON.stringify(audit.log.mock.calls[0][0].details);
  expect(details).toContain('[REDACTED]');
  expect(details).not.toContain('5000000');
});
