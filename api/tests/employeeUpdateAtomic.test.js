/**
 * employeeUpdateAtomic.test.js — PR 1 (ficha del empleado, modal atómico).
 *
 * Cubre el contrato del `update(req, res)` del controller:
 *
 *  - Validación completa PREVIA a cualquier escritura.
 *    Si un campo del payload falla, la respuesta es 400 y no se toca la BD.
 *  - Cuando todo valida, el UPDATE corre dentro de una transacción
 *    (`sequelize.transaction` → SELECT FOR UPDATE + UPDATE + commit).
 *  - Ante error en la transacción, se hace rollback y la respuesta es 500.
 *  - La respuesta incluye la ficha completa (`employee`) recién guardada,
 *    con antigüedad derivada y capacidades embebidas.
 *  - `branch_id` está permitido (PR 1 lo agregó a la allowlist).
 *  - Guard PUT_EDITABLE_FIELDS: presente en el router (regresión).
 */

const path = require('path');

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const transaction = jest.fn().mockResolvedValue({ commit, rollback });
  return {
    sequelize: { query, transaction, _handles: { commit, rollback } },
  };
});

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/audit', () => ({
  log: jest.fn(),
}));

jest.mock('../src/services/paymentTypes', () => ({
  isActiveCode: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const paymentTypes = require('../src/services/paymentTypes');
const audit        = require('../src/services/audit');
const controller   = require('../src/controllers/employeeController');

function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this; });
  res.json   = jest.fn().mockImplementation(function () { return this; });
  return res;
}

function mkReq(body, user = { id: 42, role: 'admin' }) {
  return { params: { id: '7' }, body, user };
}

describe('employeeController.update — guardado atómico', () => {
  beforeEach(() => {
    sequelize.query.mockReset();
    sequelize.transaction.mockClear();
    sequelize._handles.commit.mockClear();
    sequelize._handles.rollback.mockClear();
    audit.log.mockClear();
    paymentTypes.isActiveCode.mockReset();
    paymentTypes.isActiveCode.mockResolvedValue(true);
  });

  test('un campo inválido aborta el update: 400 y ninguna escritura ni transacción', async () => {
    const req = mkReq({
      first_name: 'Ana',
      salary_base: '2500.50', // decimales rechazados por el validador
    });
    const res = mkRes();

    await controller.update(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ field: 'salary_base' }));
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(paymentTypes.isActiveCode).not.toHaveBeenCalled();
  });

  test('pay_type inexistente en catálogo → 400 y no abre transacción', async () => {
    paymentTypes.isActiveCode.mockResolvedValue(false);
    const req = mkReq({ pay_type: 'inexistente' });
    const res = mkRes();

    await controller.update(req, res);

    expect(paymentTypes.isActiveCode).toHaveBeenCalledWith('inexistente');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ field: 'pay_type' }));
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('guarda cambios reales dentro de una transacción y responde con employee completo', async () => {
    // 1) SELECT FOR UPDATE dentro de la tx → devuelve valores previos
    sequelize.query
      .mockResolvedValueOnce([[{ first_name: 'Antigua', salary_base: 1000000, pay_type: 'mensualizado' }]])
      // 2) UPDATE dentro de la tx
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      // 3) readEmployeeById fuera de la tx: SELECT * JOIN
      .mockResolvedValueOnce([[{
        id: 7, first_name: 'Ana', last_name: 'García', salary_base: 2500000,
        pay_type: 'mensualizado', hire_date: '2020-01-15',
        department_name: 'Ventas', schedule_name: null, branch_name: 'Central',
      }]]);

    const req = mkReq({
      first_name: 'Ana',
      salary_base: '2500000',
      pay_type: 'mensualizado', // no cambia → no debe aparecer en `changed`
    });
    const res = mkRes();

    await controller.update(req, res);

    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(sequelize._handles.commit).toHaveBeenCalledTimes(1);
    expect(sequelize._handles.rollback).not.toHaveBeenCalled();

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.message).toBe('Empleado actualizado');
    // pay_type se filtró como no-cambio (mismo valor previo)
    expect(jsonArg.changed).toEqual(expect.arrayContaining(['first_name', 'salary_base']));
    expect(jsonArg.changed).not.toContain('pay_type');
    // employee viene con antigüedad derivada y caps embebidos
    expect(jsonArg.employee).toEqual(expect.objectContaining({
      id: 7,
      first_name: 'Ana',
      department_name: 'Ventas',
      branch_name: 'Central',
      antiguedad_label: expect.any(String),
      _caps: expect.any(Object),
    }));
    // auditoría: una entrada por campo real que cambió
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  test('empleado inexistente → 404 y rollback', async () => {
    sequelize.query.mockResolvedValueOnce([[]]); // SELECT FOR UPDATE vacío
    const req = mkReq({ first_name: 'X' });
    const res = mkRes();

    await controller.update(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(sequelize._handles.rollback).toHaveBeenCalledTimes(1);
    expect(sequelize._handles.commit).not.toHaveBeenCalled();
  });

  test('sin cambios reales: commit + employee vuelto sin escribir UPDATE ni auditar', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ first_name: 'Ana' }]])
      // readEmployeeById
      .mockResolvedValueOnce([[{
        id: 7, first_name: 'Ana', hire_date: null,
      }]]);
    const req = mkReq({ first_name: 'Ana' }); // igual al valor previo
    const res = mkRes();

    await controller.update(req, res);

    // No hubo un segundo query dentro de la tx (el UPDATE dinámico).
    // Sólo el SELECT y luego readEmployeeById fuera de la tx = 2 llamadas.
    expect(sequelize.query).toHaveBeenCalledTimes(2);
    expect(audit.log).not.toHaveBeenCalled();
    expect(sequelize._handles.commit).toHaveBeenCalledTimes(1);

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.message).toBe('Sin cambios');
    expect(jsonArg.changed).toEqual([]);
    expect(jsonArg.employee).toEqual(expect.objectContaining({ id: 7 }));
  });

  test('branch_id aceptado por PUT (allowlist PR 1) y clasificado como personal', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ branch_id: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 7, first_name: 'A', hire_date: null, branch_id: 3, branch_name: 'Nueva' }]]);
    const req = mkReq({ branch_id: 3 });
    const res = mkRes();

    await controller.update(req, res);

    expect(sequelize._handles.commit).toHaveBeenCalledTimes(1);
    const auditCall = audit.log.mock.calls[0][0];
    expect(auditCall.action).toBe('employee.update.personal');
    expect(auditCall.details).toMatchObject({ field: 'branch_id', to: 3 });
  });

  test('rollback si el UPDATE lanza; respuesta 500 y auditoría vacía', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ first_name: 'Antigua' }]])
      .mockRejectedValueOnce(new Error('deadlock'));
    const req = mkReq({ first_name: 'Nueva' });
    const res = mkRes();

    await controller.update(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(sequelize._handles.rollback).toHaveBeenCalledTimes(1);
    expect(sequelize._handles.commit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('antiguedad_rate rechazado antes de cualquier query (READ_ONLY)', async () => {
    const req = mkReq({ antiguedad_rate: 5 });
    const res = mkRes();

    await controller.update(req, res);

    // No lo tomamos ni siquiera como "sin cambios": la allowlist lo omite
    // silenciosamente porque no está en ALLOWED. Como el body queda vacío
    // efectivamente, la respuesta es "Sin cambios" sin abrir transacción.
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Sin cambios' }));
  });
});

describe('routes/employees.js — PUT_EDITABLE_FIELDS incluye branch_id (regresión)', () => {
  // Comprobación estática: el guard debe cubrir todos los campos del PUT,
  // no sólo los del allowlist de /quick.
  const fs = require('fs');
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'routes', 'employees.js'),
    'utf8'
  );

  test('PUT_EDITABLE_FIELDS existe y contiene branch_id + department_id + schedule_id', () => {
    const start = src.indexOf('const PUT_EDITABLE_FIELDS');
    expect(start).toBeGreaterThan(-1);
    const end   = src.indexOf(');', start);
    const block = src.slice(start, end + 2);
    for (const f of ['branch_id', 'department_id', 'schedule_id']) {
      expect(block).toMatch(new RegExp(`'${f}'`));
    }
  });
});
