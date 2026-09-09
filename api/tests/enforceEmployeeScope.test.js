/**
 * enforceEmployeeScope — middleware de alcance organizacional por empleado.
 *
 * Reutiliza `services/departmentScope` (misma fuente de verdad que el listado
 * de empleados y los reportes). Acá mockeamos `getVisibleDepartmentIds` para
 * controlar el scope y usamos el `canSeeEmployee` REAL (función pura ya cubierta
 * por departmentScope.test.js). `sequelize.query` mockeado para no golpear BD.
 *
 * Propiedad protegida: un rol scoped NO puede alcanzar (biometría/documentos) a
 * un empleado fuera de su ámbito, y fuera-de-alcance es indistinguible de
 * inexistente (ambos 404, sin filtrar existencia).
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/departmentScope', () => {
  const actual = jest.requireActual('../src/services/departmentScope');
  return { ...actual, getVisibleDepartmentIds: jest.fn() };
});

const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const enforceEmployeeScope = require('../src/middleware/enforceEmployeeScope');

function mkRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
}

// Ejecuta el middleware y resuelve con {nexted, res} cuando llame next() o
// cuando responda (res.json).
function run(mw, req) {
  return new Promise((resolve, reject) => {
    const res = mkRes();
    const origJson = res.json;
    res.json = (b) => { origJson(b); resolve({ nexted: false, res }); return res; };
    const next = (err) => {
      if (err) return reject(err);
      resolve({ nexted: true, res });
    };
    Promise.resolve(mw(req, res, next)).catch(reject);
  });
}

beforeEach(() => {
  sequelize.query.mockReset();
  departmentScope.getVisibleDepartmentIds.mockReset();
});

describe('roles globales (unrestricted)', () => {
  test('unrestricted → next(), sin consulta de departamento', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    const { nexted } = await run(enforceEmployeeScope('employeeId'), {
      user: { role: 'admin' }, params: { employeeId: '5' },
    });
    expect(nexted).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('roles scoped', () => {
  test('empleado DENTRO de alcance → next()', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3, 4] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 4 }]]);
    const { nexted } = await run(enforceEmployeeScope('employeeId'), {
      user: { role: 'supervisor' }, params: { employeeId: '7' },
    });
    expect(nexted).toBe(true);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  test('empleado FUERA de alcance → 404 (no 403)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 9 }]]);
    const { nexted, res } = await run(enforceEmployeeScope('employeeId'), {
      user: { role: 'manager' }, params: { employeeId: '7' },
    });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Empleado no encontrado' });
  });

  test('empleado INEXISTENTE → mismo 404 (no filtra existencia)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    sequelize.query.mockResolvedValueOnce([[]]); // sin fila
    const { res } = await run(enforceEmployeeScope('employeeId'), {
      user: { role: 'gestor' }, params: { employeeId: '999' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Empleado no encontrado' });
  });

  test('scoped sin departamento vinculado (ids: []) → 404', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 3 }]]);
    const { res } = await run(enforceEmployeeScope('employeeId'), {
      user: { role: 'coordinator' }, params: { employeeId: '7' },
    });
    expect(res.statusCode).toBe(404);
  });

  test('id tomado del body (POST /verify): fuera de alcance → 404', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 8 }]]);
    const { res } = await run(enforceEmployeeScope({ from: 'body', key: 'employee_id' }), {
      user: { role: 'supervisor' }, params: {}, body: { employee_id: 12 },
    });
    expect(res.statusCode).toBe(404);
  });

  test('id tomado del body dentro de alcance → next()', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [8] });
    sequelize.query.mockResolvedValueOnce([[{ department_id: 8 }]]);
    const { nexted } = await run(enforceEmployeeScope({ from: 'body', key: 'employee_id' }), {
      user: { role: 'supervisor' }, params: {}, body: { employee_id: 12 },
    });
    expect(nexted).toBe(true);
  });

  test('sin id resoluble → next() (deja que el handler valide, p.ej. 400)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    const { nexted } = await run(enforceEmployeeScope({ from: 'body', key: 'employee_id' }), {
      user: { role: 'supervisor' }, params: {}, body: {},
    });
    expect(nexted).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('id no numérico → next() (no decide el middleware)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [3] });
    const { nexted } = await run(enforceEmployeeScope('employeeId'), {
      user: { role: 'supervisor' }, params: { employeeId: 'abc' },
    });
    expect(nexted).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('marca de wiring', () => {
  test('el middleware expone _enforceEmployeeScope', () => {
    expect(enforceEmployeeScope('id')._enforceEmployeeScope).toBe(true);
  });
});
