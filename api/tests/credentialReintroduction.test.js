/**
 * credentialReintroduction.test.js — H1 (parte 2): impedir REINTRODUCIR la
 * credencial por defecto conocida en los puntos donde se fija una contraseña.
 *
 * El preflight de arranque (securityPreflight.test.js) es el control de última
 * línea; acá se prueba que ninguna ruta de set (alta / cambio admin / cambio
 * self-service / reset) acepte la contraseña demo, y que rechace ANTES de tocar
 * la BD (no hashea ni escribe). Sin BD real: `sequelize.query` mockeado.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const { isDefaultAdminPassword } = require('../src/config/securityPreflight');
const usersRouter = require('../src/routes/users');
const { changePassword } = require('../src/controllers/authController');
const { resetPassword } = require('../src/controllers/passwordResetController');

// Pública en init.sql; acá sólo se usa para probar el rechazo.
const DEMO = 'Admin1234!';
const STRONG = 'Un4-Cl4v3-Fuerte-2026#';

function handlerFor(method, path) {
  const layer = usersRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  const st = layer.route.stack;
  return st[st.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn().mockReturnThis();
  res.json = jest.fn().mockReturnThis();
  return res;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('isDefaultAdminPassword (helper)', () => {
  test('detecta la contraseña por defecto incorporada', () => {
    expect(isDefaultAdminPassword(DEMO)).toBe(true);
  });
  test('una contraseña fuerte NO es por defecto', () => {
    expect(isDefaultAdminPassword(STRONG)).toBe(false);
  });
  test('entradas vacías / no-string → false (sin lanzar)', () => {
    expect(isDefaultAdminPassword('')).toBe(false);
    expect(isDefaultAdminPassword(undefined)).toBe(false);
    expect(isDefaultAdminPassword(null)).toBe(false);
    expect(isDefaultAdminPassword(12345678)).toBe(false);
  });
  test('ADMIN_WEAK_PASSWORDS AÑADE entradas, no reemplaza la incorporada', () => {
    const OLD = process.env.ADMIN_WEAK_PASSWORDS;
    process.env.ADMIN_WEAK_PASSWORDS = 'otra-clave-debil';
    try {
      expect(isDefaultAdminPassword('otra-clave-debil')).toBe(true);
      expect(isDefaultAdminPassword(DEMO)).toBe(true); // la incorporada sigue
    } finally { process.env.ADMIN_WEAK_PASSWORDS = OLD; }
  });
});

describe('POST /api/users (alta)', () => {
  test('contraseña demo → 400 y NO escribe en la BD', async () => {
    const h = handlerFor('post', '/');
    const req = { body: { username: 'x', email: 'x@y.z', password: DEMO }, user: { role: 'admin' } };
    const res = mkRes();
    await h(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('PUT /api/users/:id/password (cambio por admin)', () => {
  test('contraseña demo → 400 y NO escribe en la BD', async () => {
    const h = handlerFor('put', '/:id/password');
    const req = { params: { id: '2' }, body: { newPassword: DEMO }, user: { id: 1, role: 'admin' } };
    const res = mkRes();
    await h(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/change-password (self-service)', () => {
  test('contraseña demo → 400 y NO escribe en la BD', async () => {
    const req = { body: { currentPassword: 'algoViejo1', newPassword: DEMO }, user: { id: 3 } };
    const res = mkRes();
    await changePassword(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/password/reset', () => {
  test('contraseña demo → 400 y NO consulta el token en la BD', async () => {
    const req = { body: { token: 'tok', newPassword: DEMO } };
    const res = mkRes();
    await resetPassword(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});
