/**
 * paymentTypes.test.js — tests unitarios del servicio de acceso al catálogo,
 * mockeando `sequelize.query`. Cubre listado, findByCode/isActiveCode,
 * countUsage y comportamiento de la cache al invalidar.
 */

// Nombre `mockQuery*` — Jest permite referenciarlo desde el factory.
jest.mock('../src/config/database', () => {
  const mockQueryFn = jest.fn();
  return { sequelize: { query: mockQueryFn }, __mockQueryFn: mockQueryFn };
});

const { sequelize, __mockQueryFn: queryMock } = require('../src/config/database');
const paymentTypes = require('../src/services/paymentTypes');

function seedList(rows) {
  queryMock.mockResolvedValueOnce([rows]);
}

beforeEach(() => {
  queryMock.mockReset();
  paymentTypes.invalidateCache();
});

describe('paymentTypes.listAll', () => {
  test('devuelve todos y filtra activos con activeOnly', async () => {
    seedList([
      { id: 1, code: 'mensualizado', name: 'Mensualizado', active: 1, sort_order: 10 },
      { id: 2, code: 'jornalero',    name: 'Jornalero',    active: 1, sort_order: 20 },
      { id: 3, code: 'destajo',      name: 'Destajo',      active: 0, sort_order: 30 },
    ]);
    const all = await paymentTypes.listAll();
    expect(all).toHaveLength(3);
    // Reutiliza cache — misma llamada no dispara otra query.
    const active = await paymentTypes.listAll({ activeOnly: true });
    expect(active).toHaveLength(2);
    expect(active.map(r => r.code)).toEqual(['mensualizado', 'jornalero']);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('paymentTypes.findByCode / isActiveCode', () => {
  test('encuentra sólo los activos', async () => {
    seedList([
      { id: 1, code: 'mensualizado', name: 'Mensualizado', active: 1, sort_order: 10 },
      { id: 3, code: 'destajo',      name: 'Destajo',      active: 0, sort_order: 30 },
    ]);
    expect(await paymentTypes.isActiveCode('mensualizado')).toBe(true);
    expect(await paymentTypes.isActiveCode('destajo')).toBe(false);
    expect(await paymentTypes.isActiveCode('inexistente')).toBe(false);
    expect(await paymentTypes.isActiveCode(null)).toBe(false);
  });
});

describe('paymentTypes.invalidateCache', () => {
  test('fuerza reload al siguiente listAll', async () => {
    seedList([{ id: 1, code: 'x', name: 'X', active: 1, sort_order: 0 }]);
    await paymentTypes.listAll();
    paymentTypes.invalidateCache();
    seedList([{ id: 2, code: 'y', name: 'Y', active: 1, sort_order: 0 }]);
    const r = await paymentTypes.listAll();
    expect(r[0].code).toBe('y');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('paymentTypes.countUsage', () => {
  test('cuenta empleados con ese pay_type', async () => {
    queryMock.mockResolvedValueOnce([[{ c: 42 }]]);
    expect(await paymentTypes.countUsage('mensualizado')).toBe(42);
    queryMock.mockResolvedValueOnce([[{ c: 0 }]]);
    expect(await paymentTypes.countUsage('nuevo')).toBe(0);
  });
});
