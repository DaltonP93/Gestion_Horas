jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('HASH'),
  compare: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  authorize: () => (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/config/securityPreflight', () => ({ isDefaultAdminPassword: () => false }));

const { sequelize } = require('../src/config/database');
const router = require('../src/routes/users');

function handlerFor(method, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}

const ADMIN = { id: 2, username: 'admin2', role: 'admin' };
const SUPER = { id: 1, username: 'root', role: 'super_admin' };

beforeEach(() => jest.clearAllMocks());

describe('POST /api/users — sede y roles', () => {
  test('supervisor sin sede => 400 BRANCH_REQUIRED y no inserta', async () => {
    const res = mkRes();
    await handlerFor('post', '/')({
      user: ADMIN,
      body: {
        username: 'sup', email: 'sup@example.com', password: 'Segura123',
        full_name: 'Supervisor', role: 'supervisor',
      },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRANCH_REQUIRED' }));
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('supervisor con sede activa persiste branch_id', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 3 }]])
      .mockResolvedValueOnce([{ insertId: 22 }]);

    const res = mkRes();
    await handlerFor('post', '/')({
      user: ADMIN,
      body: {
        username: 'sup', email: 'sup@example.com', password: 'Segura123',
        full_name: 'Supervisor', role: 'supervisor', branch_id: 3,
      },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const insertCall = sequelize.query.mock.calls[1];
    expect(String(insertCall[0])).toMatch(/branch_id/i);
    expect(insertCall[1].replacements.at(-1)).toBe(3);
  });

  test('rol global admin puede quedar sin sede', async () => {
    sequelize.query.mockResolvedValueOnce([{ insertId: 23 }]);
    const res = mkRes();
    await handlerFor('post', '/')({
      user: ADMIN,
      body: {
        username: 'a2', email: 'a2@example.com', password: 'Segura123',
        full_name: 'Admin 2', role: 'admin', branch_id: null,
      },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    expect(sequelize.query.mock.calls[0][1].replacements.at(-1)).toBeNull();
  });

  test('admin no puede crear super_admin', async () => {
    const res = mkRes();
    await handlerFor('post', '/')({
      user: ADMIN,
      body: {
        username: 'root2', email: 'root2@example.com', password: 'Segura123',
        full_name: 'Root 2', role: 'super_admin',
      },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUPER_ADMIN_REQUIRED' }));
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('super_admin sí puede crear otra cuenta super_admin', async () => {
    sequelize.query.mockResolvedValueOnce([{ insertId: 24 }]);
    const res = mkRes();
    await handlerFor('post', '/')({
      user: SUPER,
      body: {
        username: 'root2', email: 'root2@example.com', password: 'Segura123',
        full_name: 'Root 2', role: 'super_admin',
      },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('PUT /api/users/:id — protección super_admin', () => {
  test('admin no puede modificar una cuenta super_admin', async () => {
    sequelize.query.mockResolvedValueOnce([[{ role: 'super_admin', branch_id: null }]]);
    const res = mkRes();
    await handlerFor('put', '/:id')({
      user: ADMIN,
      params: { id: '1' },
      body: { full_name: 'Intento' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUPER_ADMIN_REQUIRED' }));
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  test('cambiar a supervisor exige sede', async () => {
    sequelize.query.mockResolvedValueOnce([[{ role: 'admin', branch_id: null }]]);
    const res = mkRes();
    await handlerFor('put', '/:id')({
      user: SUPER,
      params: { id: '2' },
      body: { role: 'supervisor', branch_id: null },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRANCH_REQUIRED' }));
  });
});

describe('GET /api/users/:id', () => {
  test('super_admin puede leer otro usuario', async () => {
    sequelize.query.mockResolvedValueOnce([[{
      id: 4, username: 'judit.baier', role: 'supervisor', branch_id: 1,
    }]]);
    const res = mkRes();
    await handlerFor('get', '/:id')({
      user: SUPER,
      params: { id: '4' },
    }, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  });
});
