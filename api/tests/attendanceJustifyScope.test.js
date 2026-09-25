/**
 * attendanceJustifyScope.test.js — contención de
 * POST /api/reports/attendance/justify (escribe daily_summary).
 *
 * Usa el requirePermission REAL (defaults por rol + user_permissions mockeada),
 * el enforceEmployeeScope REAL (con getVisibleDepartmentIds mockeado) y el
 * sanitizador REAL de auditoría para comprobar qué persiste.
 */

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/departmentScope', () => {
  const actual = jest.requireActual('../src/services/departmentScope');
  return { ...actual, getVisibleDepartmentIds: jest.fn() };
});
jest.mock('../src/services/audit', () => {
  const actual = jest.requireActual('../src/services/audit');
  return { ...actual, log: jest.fn() };
});

const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const audit = require('../src/services/audit');
const router = require('../src/routes/reports');

let overrides;   // user_id → fila de user_permissions para 'asistencia'
let employees;   // id → { id, department_id }
let calls;

beforeEach(() => {
  jest.clearAllMocks();
  overrides = {};
  employees = {
    1: { id: 1, department_id: 1 },
    100: { id: 100, department_id: 1 },
    200: { id: 200, department_id: 2 },
    256: { id: 256, department_id: 2 },
  };
  calls = [];
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    calls.push({ sql, rp });
    if (/FROM user_permissions/.test(sql)) {
      const row = overrides[rp[0]];
      return [row ? [row] : []];
    }
    if (/SELECT department_id FROM employees WHERE id = \?/.test(sql)) {
      const e = employees[rp[0]];
      return [e ? [e] : []];
    }
    if (/SELECT id FROM employees WHERE id = \?/.test(sql)) {
      const e = employees[rp[0]];
      return [e ? [{ id: e.id }] : []];
    }
    if (/INSERT INTO daily_summary/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
});

function stack() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/attendance/justify' && l.route.methods.post);
  if (!layer) throw new Error('ruta no encontrada');
  return layer.route.stack.map((l) => l.handle);
}
function run(req) {
  const handlers = stack();
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; resolve(res); return res; };
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      i += 1;
      if (i >= handlers.length) return resolve(res);
      Promise.resolve(handlers[i](req, res, next)).catch(reject);
    };
    Promise.resolve(handlers[0](req, res, next)).catch(reject);
  });
}
const inserted = () => calls.some((c) => /INSERT INTO daily_summary/.test(c.sql));
const body = (over = {}) => ({ employeeId: 100, date: '2026-09-10', justification: '  Certificado presentado  ', justificationType: 'enfermedad', ...over });

describe('cadena de la ruta', () => {
  test('permiso asistencia.update y alcance por empleado ANTES del handler', () => {
    const s = stack();
    expect(s.length).toBe(3);
    expect(s[1]._enforceEmployeeScope).toBe(true);
  });
});

describe('quién puede', () => {
  test('employee → 403 y sin escritura', async () => {
    const res = await run({ user: { id: 7, role: 'employee' }, body: body() });
    expect(res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });

  test.each(['supervisor', 'manager', 'coordinator', 'gestor'])('%s sin override → 403', async (role) => {
    const res = await run({ user: { id: 5, role }, body: body() });
    expect(res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });

  test('rol con alcance con override pero empleado fuera de alcance → 404', async () => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: 200 }) });
    expect(res.statusCode).toBe(404);
    expect(inserted()).toBe(false);
  });

  test('rol con alcance con override y empleado en alcance → 200', async () => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: 100 }) });
    expect(res.statusCode).toBe(200);
    expect(inserted()).toBe(true);
  });

  test('hr (asistencia.update por defecto) → 200', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    const res = await run({ user: { id: 2, role: 'hr' }, body: body() });
    expect(res.statusCode).toBe(200);
  });
});

describe('validación', () => {
  beforeEach(() => departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true }));

  test.each([
    ['fecha inexistente', { date: '2026-02-31' }],
    ['fecha con formato inválido', { date: '10/09/2026' }],
    ['tipo fuera de la lista', { justificationType: 'vacaciones_extra' }],
    ['texto vacío', { justification: '   ' }],
    ['employeeId no numérico', { employeeId: 'abc' }],
  ])('%s → 400 y sin escritura', async (_n, over) => {
    const res = await run({ user: { id: 1, role: 'admin' }, body: body(over) });
    expect(res.statusCode).toBe(400);
    expect(inserted()).toBe(false);
  });

  test('empleado inexistente (rol global) → 404', async () => {
    const res = await run({ user: { id: 1, role: 'admin' }, body: body({ employeeId: 999 }) });
    expect(res.statusCode).toBe(404);
    expect(inserted()).toBe(false);
  });

  test("sin tipo usa el default histórico 'other' (compatibilidad)", async () => {
    const res = await run({ user: { id: 1, role: 'admin' }, body: body({ justificationType: undefined }) });
    expect(res.statusCode).toBe(200);
    const ins = calls.find((c) => /INSERT INTO daily_summary/.test(c.sql));
    expect(ins.rp[3]).toBe('other');
    expect(ins.rp[4]).toBe('permission');
  });
});

describe('escritura y auditoría', () => {
  beforeEach(() => departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true }));

  test('inserta con texto recortado y estado derivado; injustificada → absent', async () => {
    await run({ user: { id: 1, role: 'admin' }, body: body({ justificationType: 'injustificada' }) });
    const ins = calls.find((c) => /INSERT INTO daily_summary/.test(c.sql));
    expect(ins.rp).toEqual([100, '2026-09-10', 'Certificado presentado', 'injustificada', 'absent']);
  });

  test('audita con el sanitizador REAL: persiste employee_id, date y type, sin el texto libre', async () => {
    await run({ user: { id: 1, role: 'admin' }, body: body() });
    expect(audit.log).toHaveBeenCalledTimes(1);
    const arg = audit.log.mock.calls[0][0];
    expect(arg.action).toBe('attendance.justify');
    const persisted = JSON.parse(audit.sanitizeDetails(arg.details));
    expect(persisted).toEqual({ employee_id: 100, date: '2026-09-10', type: 'enfermedad' });
    expect(JSON.stringify(arg.details)).not.toMatch(/Certificado/);
  });
});

describe('identificador del empleado: un único valor validado', () => {
  const invalid = [
    ['notación exponencial', '1e2'],
    ['hexadecimal', '0x100'],
    ['decimal string', '100.0'],
    ['decimal number', 100.5],
    ['sufijo', '100abc'],
    ['espacios', ' 100'],
    ['ceros a la izquierda', '0100'],
    ['cero', 0],
    ['cero string', '0'],
    ['negativo', -100],
    ['negativo string', '-100'],
    ['fuera de rango seguro (string)', '9007199254740993'],
    ['fuera de rango seguro (number)', 9007199254740992],
    ['array', [100]],
    ['objeto', { id: 100 }],
    ['booleano', true],
  ];

  test.each(invalid)('%s → 400, sin escritura ni auditoría (rol global)', async (_n, bad) => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    const res = await run({ user: { id: 1, role: 'admin' }, body: body({ employeeId: bad }) });
    expect(res.statusCode).toBe(400);
    expect(inserted()).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test.each(invalid)('%s → 400, sin escritura ni auditoría (rol con alcance con override)', async (_n, bad) => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: bad }) });
    expect(res.statusCode).toBe(400);
    expect(inserted()).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test("'1e2' no puede autorizarse contra el empleado 1 (en alcance) y escribirse sobre el 100", async () => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: '1e2' }) });
    expect(res.statusCode).toBe(400);
    expect(calls.some((c) => /INSERT INTO daily_summary/.test(c.sql) && c.rp[0] === 100)).toBe(false);
  });

  test("'0x100' no puede escribir sobre el 256 (fuera de alcance)", async () => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: '0x100' }) });
    expect(res.statusCode).toBe(400);
    expect(inserted()).toBe(false);
  });

  test('id válido como string se autoriza y se escribe con el MISMO valor numérico', async () => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: '100' }) });
    expect(res.statusCode).toBe(200);
    const scopeQ = calls.find((c) => /SELECT department_id FROM employees WHERE id = \?/.test(c.sql));
    const ins = calls.find((c) => /INSERT INTO daily_summary/.test(c.sql));
    expect(scopeQ.rp[0]).toBe(100);
    expect(ins.rp[0]).toBe(100);
    expect(audit.log.mock.calls[0][0].entity_id).toBe(100);
  });

  test('empleado fuera de alcance con id válido → 404, sin escritura ni auditoría', async () => {
    overrides[5] = { can_view: 1, can_create: 0, can_update: 1, can_delete: 0 };
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: 200 }) });
    expect(res.statusCode).toBe(404);
    expect(inserted()).toBe(false);
    expect(audit.log).not.toHaveBeenCalled();
  });

  test('sin asistencia.update el alcance no alcanza (requisitos independientes)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [1], branchIds: [1] });
    const res = await run({ user: { id: 5, role: 'manager' }, body: body({ employeeId: 100 }) });
    expect(res.statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });
});
