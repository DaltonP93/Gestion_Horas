jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/zktecoReader', () => ({ withZK: jest.fn() }));

const { resolveTarget } = require('../src/services/reverseSyncPreview');

describe('reverseSyncPreview.resolveTarget (prioridad device_user_id)', () => {
  const edm = new Map([[1, '9001']]);

  test('1) employee_device_map tiene prioridad', () => {
    const r = resolveTarget({ id: 1, employee_number: '555', code: 'C1' }, edm);
    expect(r).toEqual({ userId: '9001', source: 'edm', needs_confirmation: false });
  });

  test('2) employee_number si no hay vínculo', () => {
    const r = resolveTarget({ id: 2, employee_number: '555', code: 'C1' }, edm);
    expect(r).toEqual({ userId: '555', source: 'employee_number', needs_confirmation: false });
  });

  test('3) code sólo como sugerencia (needs_confirmation)', () => {
    const r = resolveTarget({ id: 3, employee_number: '', code: 'C1' }, edm);
    expect(r).toEqual({ userId: 'C1', source: 'code', needs_confirmation: true });
  });

  test('sin datos resolubles → null', () => {
    expect(resolveTarget({ id: 4, employee_number: '', code: '' }, edm)).toBeNull();
  });

  test('recorta espacios', () => {
    const r = resolveTarget({ id: 5, employee_number: '  777  ', code: '' }, edm);
    expect(r.userId).toBe('777');
  });
});
