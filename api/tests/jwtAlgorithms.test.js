/**
 * jwtAlgorithms.test.js — H10: TODAS las verificaciones de JWT deben fijar
 * `{ algorithms: ['HS256'] }`, para que un atacante no pueda forzar `alg:none`
 * ni otro algoritmo (p. ej. HS384) al presentar el token.
 *
 * Cubre:
 *   - socket handshake (src/socket/socketServer.js)
 *   - refresh de tokens (src/controllers/authController.js)
 *   - middleware HTTP (src/middleware/auth.js) — ya lo tenía, se deja verificado.
 */
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_para_hs256_0000000000';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_hs256_00000000000';

// ─── socketServer: capturamos el middleware de auth mockeando socket.io ──────
const captured = {};
jest.mock('socket.io', () => ({
  Server: class {
    constructor() {}
    use(fn) { captured.authMw = fn; }
    on() {}
    to() { return this; }
    emit() {}
  },
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// ─── authController: mockeamos BD/servicios para aislar el verify ────────────
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/services/totp', () => ({ verifyCode: jest.fn() }));

const { initSocket } = require('../src/socket/socketServer');
const { sequelize } = require('../src/config/database');
const authController = require('../src/controllers/authController');

function mkRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('socketServer — jwt.verify con algorithms HS256', () => {
  beforeAll(() => initSocket({}));
  afterEach(() => jest.restoreAllMocks());

  test('invoca jwt.verify con { algorithms: ["HS256"] }', () => {
    const spy = jest.spyOn(jwt, 'verify');
    const token = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const next = jest.fn();
    captured.authMw({ handshake: { auth: { token } } }, next);
    expect(spy).toHaveBeenCalledWith(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    expect(next).toHaveBeenCalledWith(); // sin error
  });

  test('rechaza un token firmado con HS384 (alg no permitido)', () => {
    const token = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS384' });
    const next = jest.fn();
    captured.authMw({ handshake: { auth: { token } } }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('Token inválido');
  });
});

describe('authController.refresh — jwt.verify con algorithms HS256', () => {
  beforeEach(() => { sequelize.query.mockReset(); });
  afterEach(() => jest.restoreAllMocks());

  test('invoca jwt.verify con { algorithms: ["HS256"] }', async () => {
    const spy = jest.spyOn(jwt, 'verify');
    const refreshToken = jwt.sign({ id: 1 }, process.env.JWT_REFRESH_SECRET, { algorithm: 'HS256' });
    // 1) SELECT refresh_tokens → fila válida  2) SELECT users → usuario activo
    // 3) DELETE  4) INSERT
    sequelize.query
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([[{ id: 1, username: 'u', email: 'u@x', full_name: 'U', role: 'admin' }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);
    const res = mkRes();
    await authController.refresh({ body: { refreshToken }, headers: {} }, res);
    expect(spy).toHaveBeenCalledWith(refreshToken, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.any(String) }));
  });

  test('rechaza (401) un refresh token firmado con HS384', async () => {
    const refreshToken = jwt.sign({ id: 1 }, process.env.JWT_REFRESH_SECRET, { algorithm: 'HS384' });
    const res = mkRes();
    await authController.refresh({ body: { refreshToken }, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    // No debió llegar a consultar la BD (verify falla antes).
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('middleware/auth — ya fija algorithms HS256', () => {
  test('el código fuente incluye { algorithms: [\'HS256\'] }', () => {
    const src = require('fs').readFileSync(require.resolve('../src/middleware/auth.js'), 'utf8');
    expect(src).toMatch(/jwt\.verify\([^)]*algorithms:\s*\[\s*['"]HS256['"]\s*\]/s);
  });
});
