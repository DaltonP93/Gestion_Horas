/**
 * permissionsScope.test.js — contención de /api/permissions.
 *
 * Ejecuta la cadena REAL de middlewares/handlers de cada ruta con
 * `sequelize.query` y `getVisibleDepartmentIds` mockeados. `canSeeEmployee`
 * y `permissionAccess` son los reales.
 *
 * Invariantes:
 *   - listado acotado: global RR.HH. → todo; con alcance → deptos + propio;
 *     resto → sólo lo propio (y nada si no hay empleado vinculado);
 *   - detalle fuera de alcance ≡ inexistente (404) y sin leer eventos;
 *   - alta: sólo para sí mismo (employee) o dentro del alcance; 404 si no;
 *   - adjunto: autorización ANTES de multer (no se escribe archivo);
 *   - "propio" sale de users.employee_id (active=1), nunca del JWT.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/departmentScope', () => {
  const actual = jest.requireActual('../src/services/departmentScope');
  return { ...actual, getVisibleDepartmentIds: jest.fn() };
});
jest.mock('../src/services/permissionWorkflow', () => ({
  computeNeedsForNewPermission: jest.fn().mockResolvedValue({
    applied_rule_id: null, needs_level1: 1, needs_level2: 0, needs_final: 1,
  }),
  logEvent: jest.fn().mockResolvedValue(),
  getInboxFor: jest.fn().mockResolvedValue([]),
  canUserActOn: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  notifyPermissionCreated: jest.fn().mockResolvedValue(),
}));

const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const router = require('../src/routes/permissions');

const UNRESTRICTED = { unrestricted: true };
const NONE = { unrestricted: false, ids: [], branchIds: [] };
const DEPTS = (ids) => ({ unrestricted: false, ids, branchIds: [1] });

// Estado del "mundo" que devuelve el mock de la base.
let world;
let calls;
function resetWorld() {
  world = {
    selfByUser: {},                 // user.id → employee_id (usuario activo)
    permissions: {                  // id → fila
      10: { id: 10, employee_id: 100, department_id: 1, approval_state: 'pending' },
      20: { id: 20, employee_id: 200, department_id: 2, approval_state: 'pending' },
    },
    employees: { 100: { id: 100, department_id: 1 }, 200: { id: 200, department_id: 2 } },
  };
  calls = [];
}

function installDb() {
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    calls.push({ sql, rp });
    if (/FROM users WHERE id = \? AND active = 1/.test(sql)) {
      const emp = world.selfByUser[rp[0]];
      return [[emp ? { employee_id: emp } : undefined].filter(Boolean)];
    }
    if (/INSERT INTO permissions/.test(sql)) return [{ insertId: 99 }, 1];
    if (/UPDATE permissions SET approval_state='cancelled'/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM permission_approval_events/.test(sql)) return [[]];
    if (/SELECT id, department_id FROM employees WHERE id = \?/.test(sql)) {
      const e = world.employees[rp[0]];
      return [e ? [e] : []];
    }
    if (/FROM permissions p/.test(sql) && /WHERE p\.id = \?/.test(sql)) {
      const p = world.permissions[rp[0]];
      return [p ? [p] : []];
    }
    if (/FROM permissions p/.test(sql)) return [[]]; // listado
    return [[]];
  });
}

function mkRes(onEnd) {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; onEnd(); return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
function routeStack(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`ruta no encontrada: ${method} ${path}`);
  return layer.route.stack.map((l) => l.handle);
}
function run(method, path, req, { stopAt } = {}) {
  const stack = routeStack(method, path);
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (v) => { if (!finished) { finished = true; resolve(v); } };
    const res = mkRes(() => done({ res, reachedIndex: i }));
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      i += 1;
      if (stopAt != null && i >= stopAt) return done({ res, reachedIndex: i, passed: true });
      if (i >= stack.length) return done({ res, reachedIndex: i });
      Promise.resolve(stack[i](req, res, next)).catch(reject);
    };
    Promise.resolve(stack[0](req, res, next)).catch(reject);
  });
}
const listSql = () => calls.find((c) => /FROM permissions p/.test(c.sql) && /LIMIT 500/.test(c.sql));

beforeEach(() => {
  jest.clearAllMocks();
  resetWorld();
  installDb();
});

describe('GET /api/permissions — listado acotado', () => {
  test('rol global de RR.HH.: sin cláusula de alcance', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(UNRESTRICTED);
    await run('get', '/', { user: { id: 1, role: 'hr' }, query: {} });
    const q = listSql();
    expect(q.sql).not.toMatch(/1=0/);
    expect(q.sql).not.toMatch(/p\.employee_id = \?/);
  });

  test('employee: sólo sus propias solicitudes (employee_id desde la base)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    await run('get', '/', { user: { id: 7, role: 'employee', employee_id: 999 }, query: {} });
    const q = listSql();
    expect(q.sql).toMatch(/AND \(p\.employee_id = \?\)/);
    expect(q.rp).toContain(100);
    expect(q.rp).not.toContain(999); // el claim del JWT no se usa
  });

  test('employee sin empleado vinculado: AND 1=0 (nada)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    await run('get', '/', { user: { id: 8, role: 'employee' }, query: {} });
    expect(listSql().sql).toMatch(/AND 1=0/);
  });

  test('rol con alcance: deptos visibles + lo propio', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(DEPTS([1, 3]));
    world.selfByUser[5] = 300;
    await run('get', '/', { user: { id: 5, role: 'supervisor' }, query: {} });
    const q = listSql();
    expect(q.sql).toMatch(/e\.department_id IN \(\?,\?\) OR p\.employee_id = \?/);
    expect(q.rp).toEqual(expect.arrayContaining([1, 3, 300]));
  });

  test('los filtros del cliente se intersectan con el alcance (no lo amplían)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    await run('get', '/', { user: { id: 7, role: 'employee' }, query: { employeeId: '200' } });
    const q = listSql();
    expect(q.sql).toMatch(/AND p\.employee_id = \? AND \(p\.employee_id = \?\)/);
    expect(q.rp).toEqual(['200', 100]);
  });

  test('error de base → 500 genérico, sin detalle interno', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(UNRESTRICTED);
    sequelize.query.mockRejectedValueOnce(new Error("ER_BAD_FIELD_ERROR: Unknown column 'x'"));
    const { res } = await run('get', '/', { user: { id: 1, role: 'hr' }, query: {} });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ER_BAD_FIELD|column/);
  });
});

describe('GET /api/permissions/:id — detalle', () => {
  test('employee sobre solicitud ajena → 404 y no lee eventos', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const { res } = await run('get', '/:id', { user: { id: 7, role: 'employee' }, params: { id: '20' } });
    expect(res.statusCode).toBe(404);
    expect(calls.some((c) => /permission_approval_events/.test(c.sql))).toBe(false);
  });

  test('ajena e inexistente responden igual (sin oráculo)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const a = await run('get', '/:id', { user: { id: 7, role: 'employee' }, params: { id: '20' } });
    const b = await run('get', '/:id', { user: { id: 7, role: 'employee' }, params: { id: '12345' } });
    expect(a.res.statusCode).toBe(b.res.statusCode);
    expect(a.res.body).toEqual(b.res.body);
  });

  test('employee sobre solicitud propia → 200', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const { res } = await run('get', '/:id', { user: { id: 7, role: 'employee' }, params: { id: '10' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(10);
  });

  test('rol con alcance fuera de su depto → 404; dentro → 200', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(DEPTS([1]));
    const out = await run('get', '/:id', { user: { id: 5, role: 'manager' }, params: { id: '20' } });
    const inn = await run('get', '/:id', { user: { id: 5, role: 'manager' }, params: { id: '10' } });
    expect(out.res.statusCode).toBe(404);
    expect(inn.res.statusCode).toBe(200);
  });
});

describe('POST /api/permissions — alta', () => {
  const body = (employee_id) => ({ employee_id, type: 'personal', date_from: '2026-10-01', date_to: '2026-10-01' });

  test('employee a nombre de otro → 404 y sin INSERT', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const { res } = await run('post', '/', { user: { id: 7, role: 'employee' }, body: body(200) });
    expect(res.statusCode).toBe(404);
    expect(calls.some((c) => /INSERT INTO permissions/.test(c.sql))).toBe(false);
  });

  test('employee para sí mismo → 201', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const { res } = await run('post', '/', { user: { id: 7, role: 'employee' }, body: body(100) });
    expect(res.statusCode).toBe(201);
  });

  test('rol con alcance para empleado fuera de alcance → 404', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(DEPTS([1]));
    const { res } = await run('post', '/', { user: { id: 5, role: 'coordinator' }, body: body(200) });
    expect(res.statusCode).toBe(404);
    expect(calls.some((c) => /INSERT INTO permissions/.test(c.sql))).toBe(false);
  });

  test('rol global con empleado inexistente → 404', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(UNRESTRICTED);
    const { res } = await run('post', '/', { user: { id: 1, role: 'admin' }, body: body(424242) });
    expect(res.statusCode).toBe(404);
  });

  test('rol global con empleado existente → 201', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(UNRESTRICTED);
    const { res } = await run('post', '/', { user: { id: 1, role: 'admin' }, body: body(200) });
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /api/permissions/:id/attachment — autorización antes de guardar', () => {
  test('la autorización corre ANTES que multer en la cadena', () => {
    const stack = routeStack('post', '/:id/attachment');
    expect(stack[0].name).toBe('authorizeAttachment');
    expect(stack.length).toBeGreaterThanOrEqual(3);
  });

  test('employee sobre solicitud ajena → 404 y multer no se ejecuta', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const r = await run('post', '/:id/attachment', { user: { id: 7, role: 'employee' }, params: { id: '20' } }, { stopAt: 1 });
    expect(r.res.statusCode).toBe(404);
    expect(r.passed).toBeUndefined();
  });

  test('supervisor con la solicitud en alcance pero sin rol de adjunto → 403', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(DEPTS([1]));
    const r = await run('post', '/:id/attachment', { user: { id: 5, role: 'supervisor' }, params: { id: '10' } }, { stopAt: 1 });
    expect(r.res.statusCode).toBe(403);
  });

  test('coordinator fuera de alcance → 404', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(DEPTS([1]));
    const r = await run('post', '/:id/attachment', { user: { id: 5, role: 'coordinator' }, params: { id: '20' } }, { stopAt: 1 });
    expect(r.res.statusCode).toBe(404);
  });

  test('coordinator en alcance y dueño (desde la base) pasan al upload', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue(DEPTS([1]));
    const coord = await run('post', '/:id/attachment', { user: { id: 5, role: 'coordinator' }, params: { id: '10' } }, { stopAt: 1 });
    expect(coord.passed).toBe(true);

    departmentScope.getVisibleDepartmentIds.mockResolvedValue(NONE);
    world.selfByUser[7] = 100;
    const owner = await run('post', '/:id/attachment', { user: { id: 7, role: 'employee' }, params: { id: '10' } }, { stopAt: 1 });
    expect(owner.passed).toBe(true);
  });
});

describe('POST /api/permissions/:id/cancel — dueño desde la base', () => {
  test('claim employee_id del JWT desactualizado no otorga ser dueño', async () => {
    world.selfByUser[7] = 100;               // vínculo real
    const { res } = await run('post', '/:id/cancel', {
      user: { id: 7, role: 'employee', employee_id: 200 },  // claim viejo apunta a 200
      params: { id: '20' },
    });
    expect(res.statusCode).toBe(403);
  });

  test('dueño real (users.employee_id) puede cancelar aunque el JWT no traiga employee_id', async () => {
    world.selfByUser[7] = 100;
    const { res } = await run('post', '/:id/cancel', {
      user: { id: 7, role: 'employee', employee_id: null },
      params: { id: '10' },
    });
    expect(res.statusCode).toBe(200);
  });

  test('la resolución exige usuario activo (active = 1)', async () => {
    await run('post', '/:id/cancel', { user: { id: 7, role: 'employee' }, params: { id: '10' } });
    expect(calls.some((c) => /FROM users WHERE id = \? AND active = 1/.test(c.sql))).toBe(true);
  });
});
