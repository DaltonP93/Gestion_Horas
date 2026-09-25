/**
 * permissionsScope.test.js — capacidad funcional + alcance en /api/permissions.
 *
 * Cadena REAL de cada ruta; `sequelize.query` y `getVisibleDepartmentIds`
 * mockeados. Son REALES: permissionAccess, capabilities (defaults por rol +
 * overrides de user_permissions, incluida la denegación explícita) y
 * canSeeEmployee.
 *
 * Invariantes:
 *   - propio → `mis_permisos`; otras personas → `permisos` + alcance;
 *   - el alcance nunca concede la capacidad; la denegación explícita manda;
 *   - identidad (rol, activo, employee_id) desde la base, no del JWT;
 *   - usuario inactivo → 403; fuera de alcance a nivel objeto → 404;
 *   - adjuntos: autorización antes de multer.
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

let world;
let calls;

// Usuarios de prueba (id → fila de users). El rol del JWT puede diferir.
const U = {
  EMP: 7,        // employee con empleado 100
  EMP_NOLINK: 8, // employee sin empleado vinculado
  EMP_OFF: 9,    // employee inactivo (empleado 100)
  MGR: 5,        // manager (alcance depto 1)
  SUP: 6,        // supervisor (alcance depto 1)
  COORD: 4,      // coordinator (alcance depto 1)
  HR: 2,         // hr (global)
  GTH: 3,        // gth (global)
  ADMIN: 1,      // admin (bypass)
};

function resetWorld() {
  world = {
    users: {
      [U.EMP]: { id: U.EMP, role: 'employee', active: 1, employee_id: 100 },
      [U.EMP_NOLINK]: { id: U.EMP_NOLINK, role: 'employee', active: 1, employee_id: null },
      [U.EMP_OFF]: { id: U.EMP_OFF, role: 'employee', active: 0, employee_id: 100 },
      [U.MGR]: { id: U.MGR, role: 'manager', active: 1, employee_id: 300 },
      [U.SUP]: { id: U.SUP, role: 'supervisor', active: 1, employee_id: null },
      [U.COORD]: { id: U.COORD, role: 'coordinator', active: 1, employee_id: null },
      [U.HR]: { id: U.HR, role: 'hr', active: 1, employee_id: null },
      [U.GTH]: { id: U.GTH, role: 'gth', active: 1, employee_id: 400 },
      [U.ADMIN]: { id: U.ADMIN, role: 'admin', active: 1, employee_id: null },
    },
    overrides: {}, // `${userId}:${module}` → fila user_permissions
    scopes: {},    // userId → resultado de getVisibleDepartmentIds
    permissions: {
      10: { id: 10, employee_id: 100, department_id: 1, approval_state: 'pending', attachment_url: null },
      20: { id: 20, employee_id: 200, department_id: 2, approval_state: 'pending', attachment_url: null },
      30: { id: 30, employee_id: 300, department_id: 1, approval_state: 'pending', attachment_url: null },
    },
    employees: {
      100: { id: 100, department_id: 1 }, 200: { id: 200, department_id: 2 },
      300: { id: 300, department_id: 1 }, 400: { id: 400, department_id: 2 },
    },
  };
  calls = [];
}

const SCOPED = { unrestricted: false, ids: [1], branchIds: [1] };
const NONE = { unrestricted: false, ids: [], branchIds: [] };

function installMocks() {
  departmentScope.getVisibleDepartmentIds.mockImplementation(async (actor) => {
    if (world.scopes[actor.id]) return world.scopes[actor.id];
    if (['super_admin', 'admin', 'gth', 'hr'].includes(actor.role)) return { unrestricted: true };
    if (['manager', 'coordinator', 'supervisor', 'gestor'].includes(actor.role)) return SCOPED;
    return NONE;
  });
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    calls.push({ sql, rp });
    if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) {
      const u = world.users[rp[0]];
      return [u ? [u] : []];
    }
    if (/FROM user_permissions/.test(sql)) {
      const [uid, ...mods] = rp;
      return [mods.map((m) => world.overrides[`${uid}:${m}`] && { module: m, ...world.overrides[`${uid}:${m}`] }).filter(Boolean)];
    }
    if (/INSERT INTO permissions/.test(sql)) return [{ insertId: 99 }, 1];
    if (/UPDATE permissions SET approval_state='cancelled'/.test(sql)) return [{ affectedRows: 1 }];
    if (/UPDATE permissions SET\s+attachment_url\s+= NULL/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM permission_approval_events/.test(sql)) return [[]];
    if (/SELECT id, department_id FROM employees WHERE id = \?/.test(sql)) {
      const e = world.employees[rp[0]];
      return [e ? [e] : []];
    }
    if (/FROM permissions p/.test(sql) && /WHERE p\.id = \?/.test(sql)) {
      const p = world.permissions[rp[0]];
      return [p ? [p] : []];
    }
    return [[]];
  });
}

const deny = (uid, module, flags) => { world.overrides[`${uid}:${module}`] = { can_view: 0, can_create: 0, can_update: 0, can_delete: 0, ...flags }; };
const grant = (uid, module, flags) => { world.overrides[`${uid}:${module}`] = { can_view: 0, can_create: 0, can_update: 0, can_delete: 0, ...flags }; };

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
    const res = { statusCode: 200, body: undefined, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; done({ res }); return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      i += 1;
      if (stopAt != null && i >= stopAt) return done({ res, passed: true });
      if (i >= stack.length) return done({ res });
      Promise.resolve(stack[i](req, res, next)).catch(reject);
    };
    Promise.resolve(stack[0](req, res, next)).catch(reject);
  });
}
const listSql = () => calls.find((c) => /FROM permissions p/.test(c.sql) && /LIMIT 500/.test(c.sql));
const inserted = () => calls.some((c) => /INSERT INTO permissions/.test(c.sql));
const u = (id, jwtRole) => ({ id, role: jwtRole || world.users[id].role });
const body = (employee_id) => ({ employee_id, type: 'personal', date_from: '2026-10-01', date_to: '2026-10-01' });

beforeEach(() => {
  jest.clearAllMocks();
  resetWorld();
  installMocks();
});

describe('propietario legítimo (employee con empleado vinculado)', () => {
  test('listado: sólo lo propio (mis_permisos.view), employee_id desde la base', async () => {
    await run('get', '/', { user: { id: U.EMP, role: 'employee', employee_id: 999 }, query: {} });
    const q = listSql();
    expect(q.sql).toMatch(/AND \(p\.employee_id = \?\)/);
    expect(q.rp).toContain(100);
    expect(q.rp).not.toContain(999);
  });
  test('detalle propio → 200; ajeno → 404 y sin leer eventos', async () => {
    const own = await run('get', '/:id', { user: u(U.EMP), params: { id: '10' } });
    expect(own.res.statusCode).toBe(200);
    calls = [];
    const other = await run('get', '/:id', { user: u(U.EMP), params: { id: '20' } });
    expect(other.res.statusCode).toBe(404);
    expect(calls.some((c) => /permission_approval_events/.test(c.sql))).toBe(false);
  });
  test('alta propia → 201; para otra persona → 403 (no tiene permisos.create) sin INSERT', async () => {
    const own = await run('post', '/', { user: u(U.EMP), body: body(100) });
    expect(own.res.statusCode).toBe(201);
    calls = [];
    const other = await run('post', '/', { user: u(U.EMP), body: body(200) });
    expect(other.res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });
  test('cancelar propia → 200 aunque el JWT traiga otro employee_id', async () => {
    const r = await run('post', '/:id/cancel', { user: { id: U.EMP, role: 'employee', employee_id: 200 }, params: { id: '10' } });
    expect(r.res.statusCode).toBe(200);
  });
  test('cancelar ajena → 403', async () => {
    const r = await run('post', '/:id/cancel', { user: u(U.EMP), params: { id: '20' } });
    expect(r.res.statusCode).toBe(403);
  });
  test('adjuntar en la propia → pasa al upload; en ajena → 404 sin llegar a multer', async () => {
    const own = await run('post', '/:id/attachment', { user: u(U.EMP), params: { id: '10' } }, { stopAt: 1 });
    expect(own.passed).toBe(true);
    const other = await run('post', '/:id/attachment', { user: u(U.EMP), params: { id: '20' } }, { stopAt: 1 });
    expect(other.res.statusCode).toBe(404);
    expect(other.passed).toBeUndefined();
  });
  test('denegación explícita de mis_permisos bloquea el autoservicio', async () => {
    deny(U.EMP, 'mis_permisos', {});
    const list = await run('get', '/', { user: u(U.EMP), query: {} });
    expect(list.res.statusCode).toBe(403);
    const det = await run('get', '/:id', { user: u(U.EMP), params: { id: '10' } });
    expect(det.res.statusCode).toBe(404);
    const create = await run('post', '/', { user: u(U.EMP), body: body(100) });
    expect(create.res.statusCode).toBe(403);
  });
});

describe('usuario sin empleado asociado', () => {
  test('listado vacío (AND 1=0) y alta para otro → 403', async () => {
    await run('get', '/', { user: u(U.EMP_NOLINK), query: {} });
    expect(listSql().sql).toMatch(/AND 1=0/);
    const r = await run('post', '/', { user: u(U.EMP_NOLINK), body: body(100) });
    expect(r.res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });
});

describe('usuario inactivo', () => {
  test.each([
    ['get', '/', { query: {} }],
    ['get', '/:id', { params: { id: '10' } }],
    ['post', '/', { body: body(100) }],
    ['post', '/:id/cancel', { params: { id: '10' } }],
    ['post', '/:id/attachment', { params: { id: '10' } }],
    ['get', '/:id/attachment', { params: { id: '10' } }],
  ])('%s %s → 403', async (method, path, extra) => {
    const r = await run(method, path, { user: u(U.EMP_OFF), ...extra }, { stopAt: path === '/:id/attachment' && method === 'post' ? 1 : undefined });
    expect(r.res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });
  test('usuario inexistente → 403', async () => {
    const r = await run('get', '/', { user: { id: 4242, role: 'hr' }, query: {} });
    expect(r.res.statusCode).toBe(403);
  });
});

describe('gestor (manager) dentro y fuera de alcance', () => {
  test('listado: deptos en alcance + lo propio sólo si tiene mis_permisos', async () => {
    await run('get', '/', { user: u(U.MGR), query: {} });
    const q = listSql();
    // manager: permisos.view por defecto; mis_permisos (portal) = 0 → sin cláusula propia
    expect(q.sql).toMatch(/AND \(e\.department_id IN \(\?\)\)/);
    expect(q.rp).toEqual([1]);
  });
  test('detalle en alcance → 200; fuera → 404', async () => {
    expect((await run('get', '/:id', { user: u(U.MGR), params: { id: '10' } })).res.statusCode).toBe(200);
    expect((await run('get', '/:id', { user: u(U.MGR), params: { id: '20' } })).res.statusCode).toBe(404);
  });
  test('alta para otro: sin permisos.create → 403 aunque esté en alcance', async () => {
    const r = await run('post', '/', { user: u(U.MGR), body: body(100) });
    expect(r.res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });
  test('con override permisos.create: en alcance → 201; fuera → 404', async () => {
    grant(U.MGR, 'permisos', { can_view: 1, can_create: 1 });
    expect((await run('post', '/', { user: u(U.MGR), body: body(100) })).res.statusCode).toBe(201);
    calls = [];
    const out = await run('post', '/', { user: u(U.MGR), body: body(200) });
    expect(out.res.statusCode).toBe(404);
    expect(inserted()).toBe(false);
  });
});

describe('gestor sin capacidad funcional', () => {
  test('supervisor con denegación explícita de permisos: listado 403 y detalle en alcance 404', async () => {
    deny(U.SUP, 'permisos', {});
    expect((await run('get', '/', { user: u(U.SUP), query: {} })).res.statusCode).toBe(403);
    expect((await run('get', '/:id', { user: u(U.SUP), params: { id: '10' } })).res.statusCode).toBe(404);
  });
  test('coordinator en alcance sin permisos.update (default) no puede adjuntar → 403', async () => {
    const r = await run('post', '/:id/attachment', { user: u(U.COORD), params: { id: '10' } }, { stopAt: 1 });
    expect(r.res.statusCode).toBe(403);
  });
  test('coordinator con permisos.update: en alcance pasa; fuera de alcance 404', async () => {
    grant(U.COORD, 'permisos', { can_view: 1, can_update: 1 });
    expect((await run('post', '/:id/attachment', { user: u(U.COORD), params: { id: '10' } }, { stopAt: 1 })).passed).toBe(true);
    expect((await run('post', '/:id/attachment', { user: u(U.COORD), params: { id: '20' } }, { stopAt: 1 })).res.statusCode).toBe(404);
  });
  test('supervisor con permisos.update sigue sin poder adjuntar (rol no habilitado) → 403', async () => {
    grant(U.SUP, 'permisos', { can_view: 1, can_update: 1 });
    const r = await run('post', '/:id/attachment', { user: u(U.SUP), params: { id: '10' } }, { stopAt: 1 });
    expect(r.res.statusCode).toBe(403);
  });
});

describe('roles globales y denegación explícita', () => {
  test('hr: listado sin cláusula de alcance', async () => {
    await run('get', '/', { user: u(U.HR), query: {} });
    const q = listSql();
    expect(q.sql).not.toMatch(/1=0|department_id IN|p\.employee_id = \?\)/);
  });
  test('admin: alta para cualquier empleado existente → 201; inexistente → 404', async () => {
    expect((await run('post', '/', { user: u(U.ADMIN), body: body(200) })).res.statusCode).toBe(201);
    expect((await run('post', '/', { user: u(U.ADMIN), body: body(424242) })).res.statusCode).toBe(404);
  });
  test('gth con denegación explícita de permisos.view: pierde la vista global', async () => {
    deny(U.GTH, 'permisos', {});
    expect((await run('get', '/', { user: u(U.GTH), query: {} })).res.statusCode).toBe(403);
    expect((await run('get', '/:id', { user: u(U.GTH), params: { id: '20' } })).res.statusCode).toBe(404);
  });
  test('gth con permisos denegado pero mis_permisos otorgado: sólo lo propio', async () => {
    deny(U.GTH, 'permisos', {});
    grant(U.GTH, 'mis_permisos', { can_view: 1 });
    await run('get', '/', { user: u(U.GTH), query: {} });
    const q = listSql();
    expect(q.sql).toMatch(/AND \(p\.employee_id = \?\)/);
    expect(q.rp).toContain(400);
  });
  test('cancelar ajena: gth (global) con permisos.update → 200; hr (no es rol de cancelación) → 403', async () => {
    expect((await run('post', '/:id/cancel', { user: u(U.GTH), params: { id: '20' } })).res.statusCode).toBe(200);
    expect((await run('post', '/:id/cancel', { user: u(U.HR), params: { id: '20' } })).res.statusCode).toBe(403);
  });
  test('borrar adjunto: hr permitido; hr con permisos.update denegado → 404', async () => {
    world.permissions[20].attachment_url = null;
    expect((await run('delete', '/:id/attachment', { user: u(U.HR), params: { id: '20' } })).res.statusCode).toBe(200);
    deny(U.HR, 'permisos', { can_view: 1 });
    expect((await run('delete', '/:id/attachment', { user: u(U.HR), params: { id: '20' } })).res.statusCode).toBe(404);
  });
});

describe('identidad desde la base', () => {
  test('un JWT que dice "hr" para un usuario que en la base es employee no da vista global', async () => {
    await run('get', '/', { user: { id: U.EMP, role: 'hr' }, query: {} });
    const q = listSql();
    expect(q.sql).toMatch(/AND \(p\.employee_id = \?\)/);
    expect(q.rp).toEqual([100]);
  });
  test('employee_id inválido en el alta → 400 (id estricto)', async () => {
    const r = await run('post', '/', { user: u(U.ADMIN), body: body('1e2') });
    expect(r.res.statusCode).toBe(400);
    expect(inserted()).toBe(false);
  });
  test('los filtros del cliente se intersectan con lo visible', async () => {
    await run('get', '/', { user: u(U.EMP), query: { employeeId: '200' } });
    const q = listSql();
    expect(q.sql).toMatch(/AND p\.employee_id = \? AND \(p\.employee_id = \?\)/);
    expect(q.rp).toEqual(['200', 100]);
  });
  test('error de base → 500 genérico, sin detalle interno', async () => {
    sequelize.query.mockRejectedValueOnce(new Error("ER_BAD_FIELD_ERROR: Unknown column 'x'"));
    const { res } = await run('get', '/', { user: u(U.HR), query: {} });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ER_BAD_FIELD|column/);
  });
});

describe('orden de la cadena de adjuntos', () => {
  test('la autorización corre ANTES que multer', () => {
    const stack = routeStack('post', '/:id/attachment');
    expect(stack[0].name).toBe('authorizeAttachment');
  });
});
