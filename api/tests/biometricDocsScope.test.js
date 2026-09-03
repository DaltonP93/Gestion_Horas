/**
 * Endurecimiento de alcance en biometría (H-1/H-2) y documentos de RR.HH. (H-3).
 *
 * Ejecuta la cadena real de middlewares de cada ruta (extraída del router de
 * Express) con `getVisibleDepartmentIds` mockeado para fijar el scope y
 * `sequelize.query` mockeado. `canSeeEmployee` es el REAL.
 *
 * Demuestra:
 *   - rol scoped FUERA de alcance → 404 en biometría y documentos (sin ejecutar
 *     la consulta del recurso: no se filtra ni se escribe nada);
 *   - rol global (unrestricted) → el handler corre normalmente (OK).
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
// Auth en modo passthrough: aislamos el alcance del gating por rol.
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => next(),
  authorize: () => (req, _res, next) => next(),
  requirePermission: () => (req, _res, next) => next(),
  requireSuperAdmin: (req, _res, next) => next(),
  authenticateServiceKey: (req, _res, next) => next(),
}));
jest.mock('../src/services/departmentScope', () => {
  const actual = jest.requireActual('../src/services/departmentScope');
  return { ...actual, getVisibleDepartmentIds: jest.fn() };
});
// audit.log no debe tocar nada durante estos tests.
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const faceRouter = require('../src/routes/faceRecognition');
const docsRouter = require('../src/routes/employeeDocuments');

function mkRes(onSend) {
  const res = { statusCode: 200, body: null, headers: {}, _sent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res._sent = true; onSend(); return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = () => { res._sent = true; onSend(); };
  return res;
}

function routeStack(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((l) => l.handle);
    }
  }
  throw new Error(`ruta no encontrada: ${method.toUpperCase()} ${path}`);
}

function runChain(stack, req) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const res = mkRes(() => finish({ res }));
    let i = 0;
    function next(err) {
      if (err) return reject(err);
      const h = stack[i++];
      if (!h) return finish({ res, exhausted: true });
      Promise.resolve(h(req, res, next)).catch(reject);
    }
    next();
  });
}

beforeEach(() => {
  sequelize.query.mockReset();
  departmentScope.getVisibleDepartmentIds.mockReset();
});

describe('H-1 biometría: GET /:employeeId/descriptor', () => {
  const stack = () => routeStack(faceRouter, 'get', '/:employeeId/descriptor');

  test('rol scoped fuera de alcance → 404 y NO consulta el descriptor', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 9 }]]); // lookup de depto
    const { res } = await runChain(stack(), {
      user: { role: 'manager' }, params: { employeeId: '7' },
    });
    expect(res.statusCode).toBe(404);
    // Sólo corrió el lookup de departamento; el SELECT del descriptor no.
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  test('rol global → el handler devuelve el descriptor', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    sequelize.query.mockResolvedValueOnce([[{
      face_descriptor: null, face_photo_url: null, face_enrolled_at: null,
    }]]);
    const { res } = await runChain(stack(), {
      user: { role: 'admin' }, params: { employeeId: '7' },
    });
    expect(res.body).toMatchObject({ ok: true, has_face: false });
  });
});

describe('H-2 biometría: POST /verify', () => {
  const stack = () => routeStack(faceRouter, 'post', '/verify');

  test('rol scoped fuera de alcance → 404 y NO escribe en face_verifications', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 9 }]]);
    const descriptor = new Array(128).fill(0);
    const { res } = await runChain(stack(), {
      user: { role: 'supervisor' }, params: {}, body: { employee_id: 7, descriptor },
      ip: '10.0.0.1',
    });
    expect(res.statusCode).toBe(404);
    // Ninguna otra consulta: ni el SELECT del ref ni el INSERT del log.
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    const sqlTexts = sequelize.query.mock.calls.map((c) => String(c[0]));
    expect(sqlTexts.some((s) => /INSERT INTO face_verifications/i.test(s))).toBe(false);
  });
});

describe('H-3 documentos RR.HH.: GET /:id/documents', () => {
  const stack = () => routeStack(docsRouter, 'get', '/');

  test('rol scoped fuera de alcance → 404 y NO lista documentos', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 9 }]]);
    const { res } = await runChain(stack(), {
      user: { role: 'manager' }, params: { id: '7' },
    });
    expect(res.statusCode).toBe(404);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  test('rol global → lista documentos', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    sequelize.query.mockResolvedValueOnce([[]]); // sin documentos
    const { res } = await runChain(stack(), {
      user: { role: 'hr' }, params: { id: '7' },
    });
    expect(res.body).toMatchObject({ employee_id: 7, count: 0 });
  });
});

describe('wiring: las rutas montan enforceEmployeeScope', () => {
  test('descriptor, verify y documents/list llevan el enforcement', () => {
    const has = (stack) => stack.some((h) => h && h._enforceEmployeeScope === true);
    expect(has(routeStack(faceRouter, 'get', '/:employeeId/descriptor'))).toBe(true);
    expect(has(routeStack(faceRouter, 'post', '/verify'))).toBe(true);
    expect(has(routeStack(docsRouter, 'get', '/'))).toBe(true);
    expect(has(routeStack(docsRouter, 'get', '/:docId/download'))).toBe(true);
  });
});
