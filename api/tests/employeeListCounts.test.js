/**
 * employeeListCounts.test.js — PR 2 (contadores globales del listado).
 *
 * El listado mostraba los contadores derivándolos de la página cargada, así
 * que con el filtro por defecto en "Activos" la tarjeta de Inactivos siempre
 * marcaba 0 y "Todos" mostraba el total ya filtrado.
 *
 * Contrato que se fija acá:
 *  - `counts` se calcula SIN el filtro de estado, de modo que
 *    all === active + inactive sin importar qué estado se esté viendo.
 *  - `counts` SÍ respeta depto, sucursal, búsqueda y el scope RBAC.
 *  - `total` sigue siendo el total del listado filtrado (paginación).
 *  - Los contadores no dependen de `limit`/`offset`.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/zktecoReader', () => ({
  tableExists: jest.fn().mockResolvedValue(false),
}));

const { sequelize } = require('../src/config/database');
const controller = require('../src/controllers/employeeController');

function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this; });
  res.json   = jest.fn().mockImplementation(function () { return this; });
  return res;
}

/**
 * Enruta cada query por su forma. Devuelve además las SQL capturadas para
 * poder afirmar sobre el WHERE de cada una.
 */
function primeQueries({ statusRows, rows = [], total = 0 }) {
  const seen = { counts: null, list: null, totalQ: null };
  sequelize.query.mockImplementation(async (sql, opts) => {
    if (/GROUP BY e\.status/.test(sql)) {
      seen.counts = { sql, params: opts?.replacements ?? [] };
      return [statusRows];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) {
      seen.totalQ = { sql, params: opts?.replacements ?? [] };
      return [[{ total }]];
    }
    seen.list = { sql, params: opts?.replacements ?? [] };
    return [rows];
  });
  return seen;
}

const ADMIN = { id: 1, role: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getAll — contadores por estado', () => {
  test('all === active + inactive aunque se filtre por activos', async () => {
    primeQueries({
      statusRows: [{ status: 'active', n: 42 }, { status: 'inactive', n: 8 }],
      total: 42,
    });
    const res = mkRes();
    await controller.getAll({ query: { status: 'active' }, user: ADMIN }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.counts).toEqual({ all: 50, active: 42, inactive: 8 });
    expect(body.counts.all).toBe(body.counts.active + body.counts.inactive);
    // `total` sigue siendo el del listado filtrado.
    expect(body.total).toBe(42);
  });

  test('filtrar por inactivos no pone en 0 el contador de activos', async () => {
    primeQueries({
      statusRows: [{ status: 'active', n: 42 }, { status: 'inactive', n: 8 }],
      total: 8,
    });
    const res = mkRes();
    await controller.getAll({ query: { status: 'inactive' }, user: ADMIN }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.counts.active).toBe(42);
    expect(body.total).toBe(8);
  });

  test('la query de contadores no lleva el filtro de estado; la del listado sí', async () => {
    const seen = primeQueries({
      statusRows: [{ status: 'active', n: 3 }],
      total: 3,
    });
    await controller.getAll({ query: { status: 'active' }, user: ADMIN }, mkRes());

    expect(seen.counts.sql).not.toMatch(/e\.status = \?/);
    expect(seen.counts.params).not.toContain('active');
    expect(seen.totalQ.sql).toMatch(/e\.status = \?/);
    expect(seen.totalQ.params).toContain('active');
  });

  test('los contadores respetan depto y búsqueda (mismos params que el listado, sin el estado)', async () => {
    const seen = primeQueries({
      statusRows: [{ status: 'active', n: 2 }, { status: 'inactive', n: 1 }],
      total: 2,
    });
    await controller.getAll(
      { query: { status: 'active', dept: 7, search: 'gonz' }, user: ADMIN },
      mkRes()
    );

    expect(seen.counts.sql).toMatch(/e\.department_id = \?/);
    expect(seen.counts.params).toContain(7);
    expect(seen.counts.params.some(p => String(p).includes('gonz'))).toBe(true);
    // El listado es el mismo WHERE más el estado al final.
    expect(seen.totalQ.params).toEqual([...seen.counts.params, 'active']);
  });

  test('un rol scoped acota también los contadores', async () => {
    const seen = primeQueries({ statusRows: [{ status: 'active', n: 1 }], total: 1 });
    await controller.getAll(
      { query: {}, user: { id: 9, role: 'supervisor', department_id: 4 } },
      mkRes()
    );

    // Sin departamentos resolubles el scope corta a 0 filas, y ese corte debe
    // pesar sobre los contadores igual que sobre el listado: si no, un
    // supervisor vería en las tarjetas el padrón entero de la empresa.
    expect(seen.counts.sql).toContain('AND 1=0');
    expect(seen.totalQ.sql).toContain('AND 1=0');
  });

  test('el WHERE de los contadores es exactamente el del listado sin el estado', async () => {
    const seen = primeQueries({ statusRows: [{ status: 'active', n: 1 }], total: 1 });
    await controller.getAll(
      { query: { status: 'active', dept: 3, branch_id: 2 }, user: ADMIN },
      mkRes()
    );

    const whereOf = (sql) => sql.slice(sql.indexOf('WHERE'), sql.indexOf('GROUP BY') > -1 ? sql.indexOf('GROUP BY') : undefined).trim();
    expect(whereOf(seen.totalQ.sql)).toBe(`${whereOf(seen.counts.sql)} AND e.status = ?`);
  });

  test('los contadores no dependen del limit de la página', async () => {
    primeQueries({
      statusRows: [{ status: 'active', n: 900 }, { status: 'inactive', n: 100 }],
      rows: new Array(50).fill({ id: 1 }),
      total: 900,
    });
    const res = mkRes();
    await controller.getAll({ query: { status: 'active', limit: 50 }, user: ADMIN }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.counts).toEqual({ all: 1000, active: 900, inactive: 100 });
    expect(body.data).toHaveLength(50);
  });

  test('estados desconocidos suman al total pero no a las tarjetas', async () => {
    primeQueries({
      statusRows: [
        { status: 'active', n: 5 },
        { status: 'inactive', n: 2 },
        { status: 'suspended', n: 3 },
      ],
      total: 10,
    });
    const res = mkRes();
    await controller.getAll({ query: { status: 'all' }, user: ADMIN }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.counts).toEqual({ all: 10, active: 5, inactive: 2 });
  });

  test('COUNT devuelto como string se normaliza a número', async () => {
    primeQueries({
      statusRows: [{ status: 'active', n: '7' }, { status: 'inactive', n: '3' }],
      total: 7,
    });
    const res = mkRes();
    await controller.getAll({ query: {}, user: ADMIN }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.counts).toEqual({ all: 10, active: 7, inactive: 3 });
  });

  test('sin empleados visibles devuelve ceros, no undefined', async () => {
    primeQueries({ statusRows: [], total: 0 });
    const res = mkRes();
    await controller.getAll({ query: {}, user: ADMIN }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.counts).toEqual({ all: 0, active: 0, inactive: 0 });
  });
});
