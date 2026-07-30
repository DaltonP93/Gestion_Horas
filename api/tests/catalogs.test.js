/**
 * PR-A: contrato del catálogo /api/catalogs/pay-types.
 *
 * Test de handler puro (sin HTTP) para no acoplarnos a supertest — igual que
 * `syncSchedule.test.js` y otros del proyecto. PR-B cambiará la implementación
 * (DB + ABM) pero DEBE respetar este shape para no romper la UI.
 */

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); },
}));

const catalogsRouter = require('../src/routes/catalogs');

function findHandler(routerStack, method, path) {
  for (const layer of routerStack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`handler no encontrado: ${method.toUpperCase()} ${path}`);
}

function invoke(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    try {
      const maybe = handler({ user: { id: 1, role: 'admin' }, ...req }, res, reject);
      if (maybe && typeof maybe.then === 'function') maybe.catch(reject);
    } catch (e) { reject(e); }
  });
}

describe('GET /api/catalogs/pay-types', () => {
  const handler = findHandler(catalogsRouter.stack, 'get', '/pay-types');

  test('devuelve lista con shape { data: [{value,label,active}] }', async () => {
    const res = await invoke(handler);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data) {
      expect(typeof item.value).toBe('string');
      expect(typeof item.label).toBe('string');
    }
  });

  test('incluye los valores canónicos aceptados por el validador', async () => {
    const res = await invoke(handler);
    const values = res.body.data.map(x => x.value);
    expect(values).toEqual(expect.arrayContaining(['mensualizado', 'jornalero']));
  });
});
