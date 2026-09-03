/**
 * overtimeDecideBatch.test.js — decisión por LOTE de horas extra.
 *
 * Handler puro (sin HTTP), como catalogs.test.js. Verifica que el lote:
 *   - valida entrada (status, items, tope 500);
 *   - escribe SÓLO overtime_approvals (nunca daily_summary ni att2000);
 *   - es atómico: commit al terminar; rollback si una fila falla.
 */

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const transaction = jest.fn().mockResolvedValue({ commit, rollback });
  return { sequelize: { query, transaction, _h: { commit, rollback } } };
});

const { sequelize } = require('../src/config/database');
const overtimeRouter = require('../src/routes/overtime');

function findHandler(stack, method, path) {
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`handler no encontrado: ${method} ${path}`);
}

const handler = findHandler(overtimeRouter.stack, 'put', '/decide-batch');

function invoke(body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; resolve(this); return this; },
    };
    try {
      const maybe = handler({ user: { id: 9, role: 'admin' }, body }, res, reject);
      if (maybe && typeof maybe.then === 'function') maybe.catch(reject);
    } catch (e) { reject(e); }
  });
}

function mockOk() {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql) => {
    if (/SELECT overtime_minutes/i.test(sql)) return [[{ overtime_minutes: 120 }]];
    if (/INSERT INTO overtime_approvals/i.test(sql)) return [{}];
    return [[]];
  });
}

beforeEach(() => {
  sequelize._h.commit.mockClear();
  sequelize._h.rollback.mockClear();
  sequelize.transaction.mockClear();
});

test('lote válido: aplica todas, commit y devuelve applied', async () => {
  mockOk();
  const res = await invoke({ status: 'approved', items: [
    { employee_id: 1, date: '2026-05-01' },
    { employee_id: 2, date: '2026-05-01' },
  ] });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ ok: true, applied: 2 });
  expect(sequelize._h.commit).toHaveBeenCalledTimes(1);
  expect(sequelize._h.rollback).not.toHaveBeenCalled();
});

test('escribe SÓLO overtime_approvals (nunca daily_summary)', async () => {
  mockOk();
  await invoke({ status: 'rejected', items: [{ employee_id: 1, date: '2026-05-01' }] });
  const writes = sequelize.query.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => /INSERT|UPDATE|DELETE|REPLACE/i.test(sql));
  expect(writes.length).toBe(1);
  expect(writes[0]).toMatch(/INSERT INTO overtime_approvals/i);
  // El SELECT de daily_summary es sólo lectura.
  expect(sequelize.query.mock.calls.some(([s]) => /INSERT INTO daily_summary|UPDATE daily_summary/i.test(s))).toBe(false);
});

test('status inválido → 400 sin transacción', async () => {
  mockOk();
  const res = await invoke({ status: 'maybe', items: [{ employee_id: 1, date: '2026-05-01' }] });
  expect(res.statusCode).toBe(400);
  expect(sequelize.transaction).not.toHaveBeenCalled();
});

test('items vacío → 400', async () => {
  mockOk();
  const res = await invoke({ status: 'approved', items: [] });
  expect(res.statusCode).toBe(400);
});

test('más de 500 ítems → 400 (tope de lote)', async () => {
  mockOk();
  const items = Array.from({ length: 501 }, (_, i) => ({ employee_id: i + 1, date: '2026-05-01' }));
  const res = await invoke({ status: 'approved', items });
  expect(res.statusCode).toBe(400);
  expect(sequelize.transaction).not.toHaveBeenCalled();
});

test('si una fila falla → rollback, sin commit', async () => {
  sequelize.query.mockReset();
  let n = 0;
  sequelize.query.mockImplementation(async (sql) => {
    if (/SELECT overtime_minutes/i.test(sql)) return [[{ overtime_minutes: 60 }]];
    if (/INSERT INTO overtime_approvals/i.test(sql)) {
      n++;
      if (n === 2) throw new Error('db falló');
      return [{}];
    }
    return [[]];
  });
  await expect(invoke({ status: 'approved', items: [
    { employee_id: 1, date: '2026-05-01' },
    { employee_id: 2, date: '2026-05-01' },
  ] })).rejects.toThrow('db falló');
  expect(sequelize._h.rollback).toHaveBeenCalledTimes(1);
  expect(sequelize._h.commit).not.toHaveBeenCalled();
});
