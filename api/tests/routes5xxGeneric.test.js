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
jest.mock('exceljs', () => ({
  Workbook: jest.fn().mockImplementation(() => ({
    addWorksheet: () => ({
      columns: [],
      getRow: () => ({ font: {}, fill: {} }),
      addRow: () => {},
    }),
    xlsx: { write: jest.fn().mockRejectedValue(new Error('client disconnected')) },
  })),
}));
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

// Error "de base" con TODO lo que no debe filtrarse: mensaje con contraseña,
// SQL con valores, sqlMessage y un stack reconocible.
const SENTINELS = ['hunter2', 'Unknown column', 'SELECT secreta', '/app/secret.js'];
function dbError() {
  const e = new Error("Unknown column 'e.secreta' — password=hunter2");
  e.name = 'SequelizeDatabaseError';
  e.code = 'ER_BAD_FIELD_ERROR';
  e.sql = "SELECT secreta FROM users WHERE pass='hunter2'";
  e.sqlMessage = "Unknown column 'e.secreta'";
  e.stack = "Error: password=hunter2\n    at Object.<anonymous> (/app/secret.js:1:1)";
  return e;
}

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

const OLD_ENV = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV, NODE_ENV: 'production' };
  delete process.env.LOG_ERROR_DETAIL;
});
afterAll(() => { process.env = OLD_ENV; });

function expectGeneric500(res) {
  expect(res.statusCode).toBe(500);
  expect(res.body).toEqual({ error: 'Error interno' });
  // No filtra el detalle interno al cliente...
  expect(JSON.stringify(res.body)).not.toContain('hunter2');
  expect(JSON.stringify(res.body)).not.toContain('Unknown column');
  // ...pero SÍ lo registra en servidor.
  expect(logger.error).toHaveBeenCalled();
  // ...y NI SIQUIERA los argumentos enviados al logger contienen el secreto,
  // el SQL, la contraseña ni el stack (el detalle no llega al log interno).
  const logged = JSON.stringify(logger.error.mock.calls);
  for (const s of SENTINELS) expect(logged).not.toContain(s);
}

describe('selfCheckin.js — 500 genérico', () => {
  test('POST /mark oculta err.message', async () => {
    sequelize.query.mockRejectedValue(dbError());
    const h = handlerFor(selfCheckin, 'post', '/mark');
    const res = await invoke(h, { user: { id: 1 }, body: { type: 'in' } });
    expectGeneric500(res);
  });

  test('GET /geofence oculta err.message', async () => {
    sequelize.query.mockRejectedValue(dbError());
    const h = handlerFor(selfCheckin, 'get', '/geofence');
    const res = await invoke(h, { user: { id: 1 } });
    expectGeneric500(res);
  });
});

describe('embed.js — 500 genérico', () => {
  test('GET público /data/:token oculta err.message', async () => {
    sequelize.query.mockRejectedValue(dbError());
    const h = handlerFor(embed.publicRouter, 'get', '/data/:token');
    const res = await invoke(h, { params: { token: 'abc' } });
    expectGeneric500(res);
  });

  test('GET / (listado) oculta err.message', async () => {
    sequelize.query.mockRejectedValue(dbError());
    const h = handlerFor(embed, 'get', '/');
    const res = await invoke(h);
    expectGeneric500(res);
  });
});

describe('reportsBuilder.js — 500 genérico en fallo de BD, 400 en validación', () => {
  test('POST /preview: fallo de BD → 500 genérico', async () => {
    sequelize.query.mockRejectedValue(dbError());
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

describe('logInternalError (helper) — sólo metadatos seguros', () => {
  const { logInternalError } = require('../src/utils/logInternalError');

  test('producción: event + route + error_code + error_class (+request_id); sin message/stack/detail', () => {
    process.env.NODE_ENV = 'production';
    const log = { error: jest.fn() };
    logInternalError(log, {
      event: 'reports.export', route: 'POST /api/reports-builder/export',
      err: dbError(), req: { headers: { 'x-request-id': 'req-1' } },
    });
    const [msg, meta] = log.error.mock.calls[0];
    expect(msg).toBe('reports.export');
    expect(meta).toEqual({
      event: 'reports.export',
      route: 'POST /api/reports-builder/export',
      error_code: 'ER_BAD_FIELD_ERROR',
      error_class: 'SequelizeDatabaseError',
      request_id: 'req-1',
    });
    const logged = JSON.stringify(log.error.mock.calls);
    for (const s of SENTINELS) expect(logged).not.toContain(s);
    expect(logged).not.toContain('stack');
    expect(logged).not.toContain('sqlMessage');
  });

  test('dev + LOG_ERROR_DETAIL=true: adjunta detalle YA sanitizado (sin la contraseña ni el SQL crudo)', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_ERROR_DETAIL = 'true';
    const log = { error: jest.fn() };
    logInternalError(log, { event: 'x.y', err: dbError() });
    const [, meta] = log.error.mock.calls[0];
    expect(meta.detail).toBeDefined();
    const logged = JSON.stringify(log.error.mock.calls);
    // serializeError redacta la contraseña, el SQL y la ruta secreta del stack.
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('SELECT secreta');
  });

  test('dev SIN el flag: no adjunta detalle', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOG_ERROR_DETAIL;
    const log = { error: jest.fn() };
    logInternalError(log, { event: 'x.y', err: dbError() });
    expect(log.error.mock.calls[0][1].detail).toBeUndefined();
  });
});


describe('reportsBuilder /export — fallo DESPUÉS de enviar headers', () => {
  test('destruye la conexión en vez de responder JSON', async () => {
    sequelize.query.mockResolvedValue([[{ code: 'A' }]]); // filas ok; falla en el write (mock)
    const h = handlerFor(reportsBuilder, 'post', '/export');
    const destroy = jest.fn();
    let jsonCalled = false;
    const res = {
      headersSent: false,
      setHeader() { this.headersSent = true; return this; },
      status() { return this; },
      json() { jsonCalled = true; return this; },
      send() { return this; },
      end() { return this; },
      destroy,
    };
    await h(
      { user: { id: 1, role: 'admin' }, headers: {}, query: {}, params: {}, body: { source: 'employees', fields: ['code'] } },
      res, () => {},
    );
    expect(res.headersSent).toBe(true);
    expect(destroy).toHaveBeenCalled();
    expect(jsonCalled).toBe(false);
  });
});
