/**
 * jobTitlesRoute.test.js — PR 3, comportamiento del ABM de cargos.
 *
 * Lo que importa acá es el rename: `employees.position` guarda el NOMBRE
 * del cargo, así que renombrar en el catálogo sin arrastrar a las fichas
 * dejaría a esos empleados apuntando a un cargo inexistente. El UPDATE de
 * `job_titles` y el de `employees` van en la misma transacción.
 *
 * También se cubre que un cargo en uso no se pueda borrar (409).
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const transaction = jest.fn().mockResolvedValue({ commit, rollback });
  return { sequelize: { query, transaction, _handles: { commit, rollback } } };
});

jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
}));

jest.mock('../src/middleware/validate', () => ({
  validate: () => (_req, _res, next) => next(),
}));

jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const jobTitles = require('../src/services/jobTitles');
const router = require('../src/routes/jobTitles');

/** Extrae el handler final de una ruta del router. */
function handlerFor(method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this; });
  res.json   = jest.fn().mockImplementation(function () { return this; });
  return res;
}

const USER = { id: 7, role: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
  jobTitles.invalidateCache();
});

describe('PATCH /api/job-titles/:id', () => {
  test('renombrar arrastra las fichas que tenían el nombre anterior', async () => {
    sequelize.query
      // SELECT del registro previo
      .mockResolvedValueOnce([[{ id: 5, name: 'Operario', description: null, active: 1, sort_order: 0 }]])
      // UPDATE job_titles
      .mockResolvedValueOnce([{}])
      // UPDATE employees
      .mockResolvedValueOnce([{ affectedRows: 12 }]);

    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { params: { id: '5' }, body: { name: 'Operario de producción' }, user: USER },
      res, jest.fn()
    );

    const employeeUpdate = sequelize.query.mock.calls.find(
      ([sql]) => /UPDATE employees SET position/.test(sql)
    );
    expect(employeeUpdate).toBeTruthy();
    expect(employeeUpdate[1].replacements).toEqual(['Operario de producción', 'Operario']);
    // Y va dentro de la transacción, no suelto.
    expect(employeeUpdate[1].transaction).toBeTruthy();
    expect(sequelize._handles.commit).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, employees_updated: 12 })
    );
  });

  test('cambiar sólo la descripción no toca employees', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 5, name: 'Operario', description: null, active: 1, sort_order: 0 }]])
      .mockResolvedValueOnce([{}]);

    await handlerFor('patch', '/:id')(
      { params: { id: '5' }, body: { description: 'Planta 1' }, user: USER },
      mkRes(), jest.fn()
    );

    expect(sequelize.query.mock.calls.some(([sql]) => /UPDATE employees/.test(sql))).toBe(false);
  });

  test('sin cambios reales no escribe ni abre transacción', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 5, name: 'Operario', description: null, active: 1, sort_order: 0 }]]);

    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { params: { id: '5' }, body: { name: 'Operario' }, user: USER },
      res, jest.fn()
    );

    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, changed: false });
  });

  test('un nombre duplicado hace rollback y responde 409', async () => {
    const dup = new Error('dup');
    dup.original = { code: 'ER_DUP_ENTRY' };
    sequelize.query
      .mockResolvedValueOnce([[{ id: 5, name: 'Operario', description: null, active: 1, sort_order: 0 }]])
      .mockRejectedValueOnce(dup);

    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { params: { id: '5' }, body: { name: 'Analista' }, user: USER },
      res, jest.fn()
    );

    expect(sequelize._handles.rollback).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('id inexistente responde 404', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { params: { id: '99' }, body: { name: 'X' }, user: USER }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('id no numérico responde 400', async () => {
    const res = mkRes();
    await handlerFor('patch', '/:id')(
      { params: { id: 'abc' }, body: { name: 'X' }, user: USER }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('DELETE /api/job-titles/:id', () => {
  test('un cargo en uso no se borra: 409 con la cuenta', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 5, name: 'Operario' }]])   // SELECT
      .mockResolvedValueOnce([[{ c: 12 }]]);                    // countUsage

    const res = mkRes();
    await handlerFor('delete', '/:id')(
      { params: { id: '5' }, user: USER }, res, jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ in_use: 12 }));
    expect(sequelize.query.mock.calls.some(([sql]) => /DELETE FROM job_titles/.test(sql))).toBe(false);
  });

  test('un cargo sin uso se borra y queda auditado', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 5, name: 'Sereno' }]])
      .mockResolvedValueOnce([[{ c: 0 }]])
      .mockResolvedValueOnce([{}]);

    const res = mkRes();
    await handlerFor('delete', '/:id')(
      { params: { id: '5' }, user: USER }, res, jest.fn()
    );

    expect(sequelize.query.mock.calls.some(([sql]) => /DELETE FROM job_titles/.test(sql))).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job_title.delete' })
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
