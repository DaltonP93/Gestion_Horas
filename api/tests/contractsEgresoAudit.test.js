'use strict';

/**
 * contractsEgresoAudit.test.js — la auditoría del egreso no serializa el motivo.
 *
 * Política: la auditoría (audit_events.details) NUNCA guarda texto libre; el
 * motivo del egreso (campo `reason`, provisto por el usuario) queda en la
 * columna estructurada employees.termination_reason, y en la auditoría sólo se
 * deja constancia de que se dio uno (`reason_provided: bool`).
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
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const router = require('../src/routes/contracts');

function handlerFor(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this; });
  res.json = jest.fn().mockImplementation(function () { return this; });
  return res;
}

const USER = { id: 7, role: 'admin' };

beforeEach(() => jest.clearAllMocks());

describe('POST /api/contracts/egreso — auditoría sin texto libre', () => {
  test('★ audita reason_provided:true SIN el motivo libre; el motivo va a la columna', async () => {
    sequelize.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE employees (baja)
      .mockResolvedValueOnce([{}]);                  // UPDATE employee_contracts (cierre)
    const res = mkRes();
    const REASON = 'reestructuración confidencial del área de sistemas';
    await handlerFor('post', '/egreso')(
      { user: USER, body: { employee_id: 5, termination_date: '2026-03-31', reason: REASON }, headers: {} },
      res, jest.fn(),
    );

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(audit.log).toHaveBeenCalledTimes(1);
    const call = audit.log.mock.calls[0][0];
    expect(call.action).toBe('employee_egreso');
    expect(call.details).toEqual({ termination_date: '2026-03-31', reason_provided: true });
    // El texto libre no aparece en ningún lado de la auditoría.
    expect(JSON.stringify(call.details)).not.toContain('confidencial');
    // Pero SÍ se persiste en la columna estructurada termination_reason.
    const updateEmp = sequelize.query.mock.calls.find(([sql]) => /UPDATE employees SET status='inactive'/.test(String(sql)));
    expect(updateEmp[1].replacements).toEqual(['2026-03-31', REASON, 5]);
  });

  test('sin motivo → reason_provided:false', async () => {
    sequelize.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);
    await handlerFor('post', '/egreso')(
      { user: USER, body: { employee_id: 5, termination_date: '2026-03-31' }, headers: {} },
      mkRes(), jest.fn(),
    );
    expect(audit.log.mock.calls[0][0].details).toEqual({ termination_date: '2026-03-31', reason_provided: false });
  });

  test('empleado inexistente (affectedRows=0) → 404 y rollback, sin auditar', async () => {
    sequelize.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = mkRes();
    await handlerFor('post', '/egreso')(
      { user: USER, body: { employee_id: 999, termination_date: '2026-03-31', reason: 'x' }, headers: {} },
      res, jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(sequelize._handles.rollback).toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
