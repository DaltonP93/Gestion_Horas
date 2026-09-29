/**
 * authenticateIdentity.test.js — authenticate usa la identidad VIGENTE.
 *
 * El token sólo prueba quién es el usuario; rol, estado y empleado se leen de
 * `users` en cada solicitud. Cuenta inexistente/inactiva → 401; error de
 * lectura → 503 (nunca se decide con los datos del token).
 */

process.env.JWT_SECRET = 'test-secret-authenticate-identity-0123';

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));

const jwt = require('jsonwebtoken');
const { authenticate } = require('../src/middleware/auth');

function run({ header, query, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const req = { headers: header ? { authorization: header } : {}, query: query || {}, method };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ req, res: this, body: b, next: false }); return this; },
    };
    authenticate(req, res, () => resolve({ req, res, next: true }));
  });
}
const bearer = (claims) => `Bearer ${jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;

beforeEach(() => mockQuery.mockReset());

test('sin token → 401 sin consultar la base', async () => {
  const r = await run();
  expect(r.res.statusCode).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

test('firma inválida → 401 sin consultar la base', async () => {
  const bad = jwt.sign({ id: 1, role: 'admin' }, 'otro-secreto', { algorithm: 'HS256' });
  const r = await run({ header: `Bearer ${bad}` });
  expect(r.res.statusCode).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

test('rol, empleado y username salen de la base, no del token', async () => {
  mockQuery.mockResolvedValue([[{ id: 5, username: 'real', role: 'employee', active: 1, employee_id: 40 }]]);
  const r = await run({ header: bearer({ id: 5, role: 'admin', username: 'viejo', employee_id: null }) });
  expect(r.next).toBe(true);
  expect(r.req.user).toMatchObject({ id: 5, role: 'employee', employee_id: 40, username: 'real' });
  expect(mockQuery.mock.calls[0][1].replacements).toEqual([5]);
});

test.each([
  ['cuenta inexistente', []],
  ['cuenta inactiva', [{ id: 5, username: 'u', role: 'hr', active: 0, employee_id: null }]],
  ['fila sin rol', [{ id: 5, username: 'u', role: null, active: 1, employee_id: null }]],
])('%s → 401 SESSION_REVOKED', async (_n, rows) => {
  mockQuery.mockResolvedValue([rows]);
  const r = await run({ header: bearer({ id: 5, role: 'hr' }) });
  expect(r.res.statusCode).toBe(401);
  expect(r.body.code).toBe('SESSION_REVOKED');
  expect(r.next).toBe(false);
});

test.each([['cadena no canónica', '5abc'], ['cero', 0], ['ausente', undefined], ['objeto', { a: 1 }]])(
  'claim id %s → 401 sin consultar la base',
  async (_n, id) => {
    const r = await run({ header: bearer({ id, role: 'admin' }) });
    expect(r.res.statusCode).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  },
);

test('error al leer la identidad → 503 y no continúa', async () => {
  mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
  const r = await run({ header: bearer({ id: 5, role: 'admin' }) });
  expect(r.res.statusCode).toBe(503);
  expect(r.next).toBe(false);
});

test('access_token por query (descargas GET) pasa por la misma verificación', async () => {
  mockQuery.mockResolvedValue([[{ id: 5, username: 'u', role: 'hr', active: 0, employee_id: null }]]);
  const tok = jwt.sign({ id: 5, role: 'hr' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const r = await run({ query: { access_token: tok } });
  expect(r.res.statusCode).toBe(401);
});
