/**
 * assignmentScope.test.js — createAssignment exige alcance EN EL SERVICIO.
 *
 * Sin referencias organizacionales (sólo valid_from), el servicio no debe
 * crear la vigencia si el alcance es ausente, nulo, mal formado, un literal
 * global no emitido, vacío o no incluye al empleado. Las denegaciones terminan
 * sin INSERT, sin cerrar la vigencia anterior y sin commit. Base simulada; la
 * prueba con MySQL real está en tests/it/orgScope.it.test.js.
 */
const { issuedGlobal } = require('./helpers/scopes');

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const tx = { commit: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue() };
  const transaction = jest.fn().mockResolvedValue(tx);
  return { sequelize: { query, transaction, __tx: tx } };
});

const { sequelize } = require('../src/config/database');
const people = require('../src/services/people');

// Empleado 50: departamento 4, sede 2. Vigencia abierta previa 7 (2025-01-01).
const EMP = { id: 50, department_id: 4, branch_id: 2 };
let writes;
beforeEach(() => {
  jest.clearAllMocks();
  writes = [];
  sequelize.query.mockImplementation(async (sql) => {
    if (/FROM employees WHERE id = \? FOR UPDATE/.test(sql)) return [[EMP]];
    if (/FROM employee_assignments\s+WHERE employee_id = \? AND valid_to IS NULL/.test(sql)) {
      return [[{ id: 7, valid_from: new Date(Date.UTC(2025, 0, 1)) }]];
    }
    if (/^\s*(UPDATE|INSERT)/.test(sql)) { writes.push(sql.trim().split(/\s+/)[0]); return /INSERT/.test(sql) ? [99, 1] : [{}]; }
    return [[]];
  });
});

const call = (scope) => people.createAssignment(50, { valid_from: '2031-01-01' }, 1, scope);

describe('denegado: sin INSERT, sin cerrar la vigencia anterior, sin commit', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['{}', {}],
    ['literal { unrestricted: true } no emitido', { unrestricted: true }],
    ['alcance vacío (sin sede activa)', { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] }],
    ['restringido que no incluye al empleado', { unrestricted: false, companyIds: [9], branchIds: [9], departmentIds: [9] }],
  ])('%s → 403', async (_label, scope) => {
    await expect(call(scope)).rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
    expect(writes).toEqual([]);
    expect(sequelize.__tx.commit).not.toHaveBeenCalled();
  });
});

describe('permitido (controles positivos)', () => {
  test('global emitido → cierra la previa, inserta y confirma', async () => {
    expect(await call(issuedGlobal())).toEqual({ id: 99, company_id: null, closed_previous: 7 });
    expect(writes).toEqual(['UPDATE', 'INSERT']);
    expect(sequelize.__tx.commit).toHaveBeenCalledTimes(1);
  });

  test('restringido que incluye al empleado (por departamento o por sede) → inserta y confirma', async () => {
    for (const scope of [
      { unrestricted: false, companyIds: [1], branchIds: [8], departmentIds: [4] },
      { unrestricted: false, companyIds: [1], branchIds: [2], departmentIds: [] },
    ]) {
      writes = [];
      sequelize.__tx.commit.mockClear();
      await expect(call(scope)).resolves.toMatchObject({ id: 99 });
      expect(writes).toEqual(['UPDATE', 'INSERT']);
      expect(sequelize.__tx.commit).toHaveBeenCalledTimes(1);
    }
  });
});
