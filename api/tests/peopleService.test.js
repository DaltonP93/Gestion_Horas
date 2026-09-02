/**
 * peopleService.test.js — kill switch, conversión/asignación ATÓMICAS (con
 * transacción + lock + affectedRows) y validación de referencias org.
 *
 * La concurrencia REAL (dos requests a la vez) se prueba en integración con
 * MySQL: tests/it/people.it.test.js. Acá se cubre la lógica con la DB mockeada.
 */
jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const tx = { commit: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue() };
  const transaction = jest.fn().mockResolvedValue(tx);
  return { sequelize: { query, transaction, __tx: tx } };
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
  test('sólo "true" habilita; assert → 503', () => {
    delete process.env.PEOPLE_WRITE_ENABLED;
    expect(people.isWriteEnabled()).toBe(false);
    try { people.assertWriteEnabled(); throw new Error('no lanzó'); }
    catch (e) { expect(e.status).toBe(503); expect(e.code).toBe('PEOPLE_WRITES_DISABLED'); }
    process.env.PEOPLE_WRITE_ENABLED = 'true';
    expect(people.isWriteEnabled()).toBe(true);
  });
});

describe('convertCandidate — atómica', () => {
  test('feliz: FOR UPDATE + UPDATE condicional (affectedRows=1), commit', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])  // employeeExists
      .mockResolvedValueOnce([[{ id: 1, status: 'offer', converted_employee_id: null }]]) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE condicional
    const r = await people.convertCandidate(1, 50);
    expect(r).toEqual({ candidate_id: 1, converted_employee_id: 50, from_status: 'offer' });
    const upd = sequelize.query.mock.calls[2];
    expect(upd[0]).toMatch(/UPDATE candidates SET status = 'hired'.*WHERE id = \? AND converted_employee_id IS NULL/s);
    expect(sequelize.__tx.commit).toHaveBeenCalled();
  });

  test('carrera perdida (affectedRows=0) → 409 y rollback', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, status: 'offer', converted_employee_id: null }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // otra request ganó
    await expect(people.convertCandidate(1, 50)).rejects.toMatchObject({ status: 409, code: 'CANDIDATE_ALREADY_CONVERTED' });
    expect(sequelize.__tx.rollback).toHaveBeenCalled();
  });

  test('ya convertido (bajo lock) → 409', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])
      .mockResolvedValueOnce([[{ id: 1, status: 'hired', converted_employee_id: 9 }]]);
    await expect(people.convertCandidate(1, 50)).rejects.toMatchObject({ status: 409 });
  });

  test('empleado destino inexistente → 400 (sin abrir transacción)', async () => {
    sequelize.query.mockResolvedValueOnce([[]]); // employeeExists → no
    await expect(people.convertCandidate(1, 999)).rejects.toMatchObject({ status: 400, code: 'EMPLOYEE_NOT_FOUND' });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
});

describe('createAssignment — atómica con lock del empleado', () => {
  test('cierra la vigencia previa y crea la nueva; commit', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 50 }]])                       // SELECT employees FOR UPDATE
      .mockResolvedValueOnce([[{ id: 7, valid_from: '2025-01-01' }]]) // SELECT open
      .mockResolvedValueOnce([{}])                                 // UPDATE cierre
      .mockResolvedValueOnce([{ insertId: 8 }]);                   // INSERT
    const r = await people.createAssignment(50, { valid_from: '2026-03-01' }, 7);
    expect(r).toEqual({ id: 8, closed_previous: 7 });
    expect(sequelize.query.mock.calls[0][0]).toMatch(/SELECT id FROM employees WHERE id = \? FOR UPDATE/);
    expect(sequelize.__tx.commit).toHaveBeenCalled();
  });

  test('sin vigencia previa: sólo inserta', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 50 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 3 }]);
    expect(await people.createAssignment(50, { valid_from: '2026-01-01' }, 1)).toEqual({ id: 3, closed_previous: null });
  });

  test('fuera de orden (vigencia abierta posterior) → 409 y rollback', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 50 }]])
      .mockResolvedValueOnce([[{ id: 7, valid_from: '2026-06-01' }]]);
    await expect(people.createAssignment(50, { valid_from: '2026-03-01' }, 1)).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_OUT_OF_ORDER' });
    expect(sequelize.__tx.rollback).toHaveBeenCalled();
  });

  test('empleado inexistente (lock vacío) → 400', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    await expect(people.createAssignment(999, { valid_from: '2026-01-01' }, 1)).rejects.toMatchObject({ status: 400, code: 'EMPLOYEE_NOT_FOUND' });
  });
});

describe('validateAssignmentRefs — existencia + alcance + coherencia mutua (P1-B)', () => {
  const scope = { unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4] };
  // Orden de consultas en el servicio: branch, cost_center, department.

  test('sucursal inexistente → 400', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    await expect(people.validateAssignmentRefs(scope, { branch_id: 99 })).rejects.toMatchObject({ status: 400, code: 'BRANCH_NOT_FOUND' });
  });

  test('sucursal fuera de alcance → 403', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: 9 }]]);
    await expect(people.validateAssignmentRefs(scope, { branch_id: 3 })).rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
  });

  test('centro de costo de empresa fuera de alcance → 403', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 5, company_id: 1 }]]);
    await expect(people.validateAssignmentRefs(scope, { cost_center_id: 5 })).rejects.toMatchObject({ status: 403 });
  });

  test('INCOHERENTE: sucursal empresa A + centro de costo empresa B → 400 INCOHERENT_SCOPE', async () => {
    // RR.HH. global (unrestricted) tampoco puede mezclar empresas por error.
    sequelize.query
      .mockResolvedValueOnce([[{ id: 2, company_id: 1 }]])  // branch → empresa 1
      .mockResolvedValueOnce([[{ id: 5, company_id: 2 }]]); // cost_center → empresa 2
    await expect(people.validateAssignmentRefs({ unrestricted: true }, { branch_id: 2, cost_center_id: 5 }))
      .rejects.toMatchObject({ status: 400, code: 'INCOHERENT_SCOPE' });
  });

  test('INCOHERENTE: departamento (vía su centro de costo) de otra empresa → 400', async () => {
    const global = { unrestricted: true };
    sequelize.query
      .mockResolvedValueOnce([[{ id: 2, company_id: 1 }]])  // branch → empresa 1
      .mockResolvedValueOnce([[{ id: 4, company_id: 2 }]]); // department → cc.company_id 2
    await expect(people.validateAssignmentRefs(global, { branch_id: 2, department_id: 4 }))
      .rejects.toMatchObject({ status: 400, code: 'INCOHERENT_SCOPE' });
  });

  test('COHERENTE: todas de la misma empresa → ok', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 2, company_id: 9 }]])  // branch → 9
      .mockResolvedValueOnce([[{ id: 5, company_id: 9 }]])  // cost_center → 9
      .mockResolvedValueOnce([[{ id: 4, company_id: 9 }]]); // department → 9
    await expect(people.validateAssignmentRefs(scope, { branch_id: 2, cost_center_id: 5, department_id: 4 })).resolves.toBeUndefined();
  });

  test('departamento sin centro de costo (company NULL) no bloquea', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 2, company_id: 9 }]])  // branch → 9
      .mockResolvedValueOnce([[{ id: 4, company_id: null }]]); // department sin cc → NULL
    await expect(people.validateAssignmentRefs(scope, { branch_id: 2, department_id: 4 })).resolves.toBeUndefined();
  });

  test('unrestricted: valida existencia pero no alcance', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 3, company_id: 1 }]]);
    await expect(people.validateAssignmentRefs({ unrestricted: true }, { branch_id: 3 })).resolves.toBeUndefined();
  });
});
