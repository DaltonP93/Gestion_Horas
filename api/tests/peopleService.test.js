/**
 * peopleService.test.js — kill switch fail-closed, conversión trazable y
 * asignaciones append-only con cierre de la vigencia previa.
 */
jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const transaction = jest.fn().mockResolvedValue({ commit, rollback });
  return { sequelize: { query, transaction, _handles: { commit, rollback } } };
});

const { sequelize } = require('../src/config/database');
const people = require('../src/services/people');

const ORIG = process.env.PEOPLE_WRITE_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.PEOPLE_WRITE_ENABLED;
  else process.env.PEOPLE_WRITE_ENABLED = ORIG;
  jest.clearAllMocks();
});

describe('kill switch fail-closed', () => {
  test('sólo "true" habilita', () => {
    for (const v of [undefined, 'false', '1', 'TRUE']) {
      if (v === undefined) delete process.env.PEOPLE_WRITE_ENABLED; else process.env.PEOPLE_WRITE_ENABLED = v;
      expect(people.isWriteEnabled()).toBe(false);
    }
    process.env.PEOPLE_WRITE_ENABLED = 'true';
    expect(people.isWriteEnabled()).toBe(true);
  });
  test('assertWriteEnabled → 503 PEOPLE_WRITES_DISABLED', () => {
    delete process.env.PEOPLE_WRITE_ENABLED;
    try { people.assertWriteEnabled(); throw new Error('no lanzó'); }
    catch (e) { expect(e.status).toBe(503); expect(e.code).toBe('PEOPLE_WRITES_DISABLED'); }
  });
});

describe('conversión de candidato (no fabrica empleados)', () => {
  test('enlaza a un empleado existente y marca hired', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, status: 'offer', converted_employee_id: null }]]) // getCandidate
      .mockResolvedValueOnce([[{ ok: 1 }]])   // employeeExists
      .mockResolvedValueOnce([{}]);           // UPDATE
    const r = await people.convertCandidate(1, 50);
    expect(r).toEqual({ candidate_id: 1, converted_employee_id: 50, from_status: 'offer' });
    const upd = sequelize.query.mock.calls[2];
    expect(upd[0]).toMatch(/UPDATE candidates SET status = 'hired'/);
    expect(upd[1].replacements).toEqual([50, 1]);
  });

  test('rechaza si el candidato ya fue convertido (409)', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'hired', converted_employee_id: 9 }]]);
    await expect(people.convertCandidate(1, 50)).rejects.toMatchObject({ status: 409, code: 'CANDIDATE_ALREADY_CONVERTED' });
  });

  test('rechaza si el empleado destino no existe (400)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, status: 'offer', converted_employee_id: null }]])
      .mockResolvedValueOnce([[]]); // employeeExists → no
    await expect(people.convertCandidate(1, 999)).rejects.toMatchObject({ status: 400, code: 'EMPLOYEE_NOT_FOUND' });
  });
});

describe('asignaciones append-only', () => {
  test('cierra la vigencia previa y crea la nueva en transacción', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])                     // employeeExists
      .mockResolvedValueOnce([[{ id: 7, valid_from: '2025-01-01' }]]) // openAssignment
      .mockResolvedValueOnce([{}])                              // UPDATE cierre
      .mockResolvedValueOnce([{ insertId: 8 }]);               // INSERT nueva
    const r = await people.createAssignment(50, { valid_from: '2026-03-01', branch_id: 2 }, 7);
    expect(r).toEqual({ id: 8, closed_previous: 7 });
    const close = sequelize.query.mock.calls[2];
    expect(close[0]).toMatch(/SET valid_to = DATE_SUB\(\?, INTERVAL 1 DAY\)/);
    expect(close[1].replacements).toEqual(['2026-03-01', 7]);
    expect(sequelize._handles.commit).toHaveBeenCalled();
  });

  test('sin vigencia previa, sólo inserta', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])   // employeeExists
      .mockResolvedValueOnce([[]])            // openAssignment → ninguna
      .mockResolvedValueOnce([{ insertId: 3 }]); // INSERT
    const r = await people.createAssignment(50, { valid_from: '2026-01-01' }, 1);
    expect(r).toEqual({ id: 3, closed_previous: null });
  });

  test('rechaza inserción fuera de orden (409)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])                     // employeeExists
      .mockResolvedValueOnce([[{ id: 7, valid_from: '2026-06-01' }]]); // open posterior
    await expect(
      people.createAssignment(50, { valid_from: '2026-03-01' }, 1),
    ).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_OUT_OF_ORDER' });
  });

  test('rechaza si el empleado no existe (400)', async () => {
    sequelize.query.mockResolvedValueOnce([[]]); // employeeExists → no
    await expect(
      people.createAssignment(999, { valid_from: '2026-01-01' }, 1),
    ).rejects.toMatchObject({ status: 400, code: 'EMPLOYEE_NOT_FOUND' });
  });
});
