'use strict';

/**
 * employeeDeactivateAudit.test.js — la baja de empleado no audita PII ni texto libre.
 *
 * Invariante: audit_events.details sólo guarda ids/acciones, nunca el nombre del
 * empleado ni el motivo (texto libre). El motivo se persiste en la columna
 * employees.deactivation_reason; en la auditoría sólo queda constancia de que se
 * dio uno (reason_provided).
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const ctrl = require('../src/controllers/employeeController');

function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this; });
  res.json = jest.fn().mockImplementation(function () { return this; });
  return res;
}

function routeQueries() {
  sequelize.query.mockImplementation(async (sql) => {
    if (/SELECT id, code, first_name, last_name, status FROM employees WHERE id = \?/.test(sql)) {
      return [[{ id: 5, code: 'E5', first_name: 'Ana', last_name: 'Pérez', status: 'active' }]];
    }
    if (/information_schema\.COLUMNS/i.test(sql)) {
      return [[{ COLUMN_NAME: 'deactivated_at' }, { COLUMN_NAME: 'device_disable_pending' }]];
    }
    if (/UPDATE employees/.test(sql)) return [{}];
    return [[]];
  });
}

beforeEach(() => jest.clearAllMocks());

describe('employee.deactivate — auditoría sin PII ni texto libre', () => {
  test('★ con motivo: audita reason_provided:true, sin nombre ni el motivo libre', async () => {
    routeQueries();
    const res = mkRes();
    await ctrl.deactivate(
      { params: { id: '5' }, body: { reason: 'motivo confidencial de baja' }, user: { id: 9 } },
      res,
    );
    const call = audit.log.mock.calls.find(([a]) => a && a.action === 'employee.deactivate');
    expect(call).toBeTruthy();
    expect(call[0].details).toEqual({ code: 'E5', was: 'active', reason_provided: true });
    // Ni el nombre (PII) ni el texto libre del motivo sobreviven en la auditoría.
    expect(JSON.stringify(call[0].details)).not.toMatch(/Ana|Pérez|confidencial/);
    // El motivo SÍ se persiste en la columna deactivation_reason.
    const upd = sequelize.query.mock.calls.find(([sql]) => /UPDATE employees\s+SET status = 'inactive'/.test(String(sql)));
    expect(upd[1].replacements).toContain('motivo confidencial de baja');
  });

  test('sin motivo: reason_provided:false', async () => {
    routeQueries();
    const res = mkRes();
    await ctrl.deactivate({ params: { id: '5' }, body: {}, user: { id: 9 } }, res);
    const call = audit.log.mock.calls.find(([a]) => a && a.action === 'employee.deactivate');
    expect(call[0].details).toEqual({ code: 'E5', was: 'active', reason_provided: false });
  });
});
