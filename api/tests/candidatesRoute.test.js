/**
 * candidatesRoute.test.js — fail-closed, conversión atómica y auditoría SIN PII.
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
    { user: USER, body: { first_name: 'Ana', last_name: 'Pérez' }, correlationId: 'c1', headers: {} }, res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(503);
  expect(sequelize.query).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

test('POST crea candidato y AUDITA SIN PII (sólo nombres de campos + estado)', async () => {
  process.env.PEOPLE_WRITE_ENABLED = 'true';
  sequelize.query.mockResolvedValueOnce([{ insertId: 12 }]); // createCandidate INSERT
  const res = mkRes();
  await handlerFor('post', '/')(
    { user: USER, body: { first_name: 'Ana', last_name: 'Pérez', email: 'ana@x.com', phone: '0981', status: 'new' }, correlationId: 'c2', headers: {} },
    res, jest.fn(),
  );
  expect(res.status).toHaveBeenCalledWith(201);
  expect(audit.log).toHaveBeenCalledTimes(1);
  const details = audit.log.mock.calls[0][0].details;
  const serial = JSON.stringify(details);
  // Ningún dato personal serializado
  expect(serial).not.toMatch(/Ana|Pérez|ana@x\.com|0981/);
  expect(details.fields).toEqual(expect.arrayContaining(['first_name', 'last_name', 'email', 'phone']));
  expect(details.status).toBe('new');
});

test('POST /:id/convert enlaza empleado existente (atómico) y audita sin PII', async () => {
  process.env.PEOPLE_WRITE_ENABLED = 'true';
  sequelize.query
    .mockResolvedValueOnce([[{ ok: 1 }]])   // employeeExists
    .mockResolvedValueOnce([[{ id: 1, status: 'offer', converted_employee_id: null }]]) // FOR UPDATE
    .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE condicional
  const res = mkRes();
  await handlerFor('post', '/:id/convert')(
    { user: USER, params: { id: '1' }, body: { employee_id: 50, reason: 'texto libre' }, correlationId: 'c3', headers: {} },
    res, jest.fn(),
  );
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, converted_employee_id: 50 }));
  const details = audit.log.mock.calls[0][0].details;
  expect(details).toEqual({ from_status: 'offer', converted_employee_id: 50 });
  expect(JSON.stringify(details)).not.toMatch(/texto libre/); // reason no se persiste
});

test('convert con candidato ya convertido → 409 (sin auditar)', async () => {
  process.env.PEOPLE_WRITE_ENABLED = 'true';
  sequelize.query
    .mockResolvedValueOnce([[{ ok: 1 }]])
    .mockResolvedValueOnce([[{ id: 1, status: 'hired', converted_employee_id: 9 }]]);
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/:id/convert')(
    { user: USER, params: { id: '1' }, body: { employee_id: 50 }, correlationId: 'c4', headers: {} }, res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(409);
  expect(audit.log).not.toHaveBeenCalled();
});
