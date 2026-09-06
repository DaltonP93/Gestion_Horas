/**
 * routes5xxGeneric.test.js — H7: en errores 500, las rutas afectadas NO deben
 * devolver `err.message` crudo al cliente (fuga de detalles internos: SQL,
 * columnas, rutas). Deben responder un mensaje genérico y loguear el detalle
 * SOLO en servidor. Los 4xx de validación SÍ deben seguir informando.
 *
 * Rutas: selfCheckin.js, embed.js, reportsBuilder.js
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.user || { id: 1, role: 'admin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

const { sequelize } = require('../src/config/database');
const logger = require('../src/config/logger');

const selfCheckin = require('../src/routes/selfCheckin');
const embed = require('../src/routes/embed');
const reportsBuilder = require('../src/routes/reportsBuilder');

const SECRET_DB_ERROR = "Unknown column 'e.secreta' in 'field list' — password=hunter2";

function handlerFor(router, method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function invoke(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; this.headersSent = true; resolve(this); return this; },
      send(payload) { this.body = payload; this.headersSent = true; resolve(this); return this; },
      setHeader() { return this; },
    };
    try {
      const maybe = handler({ user: { id: 1, role: 'admin' }, headers: {}, query: {}, params: {}, body: {}, ...req }, res, reject);
      if (maybe && typeof maybe.then === 'function') maybe.catch(reject);
    } catch (e) { reject(e); }
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

function expectGeneric500(res) {
  expect(res.statusCode).toBe(500);
  expect(res.body).toEqual({ error: 'Error interno' });
  // No filtra el detalle interno al cliente...
  expect(JSON.stringify(res.body)).not.toContain('hunter2');
  expect(JSON.stringify(res.body)).not.toContain('Unknown column');
  // ...pero SÍ lo registra en servidor.
  expect(logger.error).toHaveBeenCalled();
}

describe('selfCheckin.js — 500 genérico', () => {
  test('POST /mark oculta err.message', async () => {
    sequelize.query.mockRejectedValue(new Error(SECRET_DB_ERROR));
    const h = handlerFor(selfCheckin, 'post', '/mark');
    const res = await invoke(h, { user: { id: 1 }, body: { type: 'in' } });
    expectGeneric500(res);
  });

  test('GET /geofence oculta err.message', async () => {
    sequelize.query.mockRejectedValue(new Error(SECRET_DB_ERROR));
    const h = handlerFor(selfCheckin, 'get', '/geofence');
    const res = await invoke(h, { user: { id: 1 } });
    expectGeneric500(res);
  });
});

describe('embed.js — 500 genérico', () => {
  test('GET público /data/:token oculta err.message', async () => {
    sequelize.query.mockRejectedValue(new Error(SECRET_DB_ERROR));
    const h = handlerFor(embed.publicRouter, 'get', '/data/:token');
    const res = await invoke(h, { params: { token: 'abc' } });
    expectGeneric500(res);
  });

  test('GET / (listado) oculta err.message', async () => {
    sequelize.query.mockRejectedValue(new Error(SECRET_DB_ERROR));
    const h = handlerFor(embed, 'get', '/');
    const res = await invoke(h);
    expectGeneric500(res);
  });
});

describe('reportsBuilder.js — 500 genérico en fallo de BD, 400 en validación', () => {
  test('POST /preview: fallo de BD → 500 genérico', async () => {
    sequelize.query.mockRejectedValue(new Error(SECRET_DB_ERROR));
    const h = handlerFor(reportsBuilder, 'post', '/preview');
    const res = await invoke(h, { body: { source: 'employees', fields: ['code'] } });
    expectGeneric500(res);
  });

  test('POST /preview: source inválido → 400 con mensaje de validación', async () => {
    const h = handlerFor(reportsBuilder, 'post', '/preview');
    const res = await invoke(h, { body: { source: 'inexistente' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/source inválido/i);
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
