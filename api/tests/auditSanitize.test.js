/**
 * audit.sanitizeDetails — la auditoría NUNCA serializa PII ni texto libre.
 *
 * Allowlist de claves no-PII + guardián de valores (sólo escalares "token" sin
 * espacios/@, números, booleanos o arrays de esos). Todo lo demás se descarta.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn().mockResolvedValue([{}]) },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const audit = require('../src/services/audit');
const { sanitizeDetails } = audit;
const { sequelize } = require('../src/config/database');

describe('sanitizeDetails: descarta PII y texto libre', () => {
  test('email nunca sobrevive', () => {
    expect(sanitizeDetails({ email: 'juan@example.com', found: false }))
      .toBe(JSON.stringify({ found: false }));
  });

  test('nombre / full_name / username nunca sobreviven', () => {
    expect(sanitizeDetails({ name: 'Ana Páez' })).toBeNull();
    expect(sanitizeDetails({ full_name: 'Ana Páez' })).toBeNull();
    expect(sanitizeDetails({ username: 'apaez' })).toBeNull();
  });

  test('texto libre (reason con espacios) se descarta; enum se conserva', () => {
    expect(sanitizeDetails({ reason: 'Renuncia voluntaria por motivos personales' })).toBeNull();
    expect(sanitizeDetails({ reason: 'bad_password' }))
      .toBe(JSON.stringify({ reason: 'bad_password' }));
  });

  test('un email colado en una clave permitida igual se descarta (guardián de valores)', () => {
    // `status` está en la allowlist, pero el valor con @ no pasa el guardián.
    expect(sanitizeDetails({ status: 'juan@example.com' })).toBeNull();
  });

  test('string suelto (texto libre) → null', () => {
    expect(sanitizeDetails('cualquier cosa libre')).toBeNull();
  });

  test('array suelto → null', () => {
    expect(sanitizeDetails(['a', 'b'])).toBeNull();
  });

  test('objeto anidado bajo clave permitida → se descarta', () => {
    expect(sanitizeDetails({ fields: { first_name: 'Ana' } })).toBeNull();
  });

  test('null/undefined → null', () => {
    expect(sanitizeDetails(null)).toBeNull();
    expect(sanitizeDetails(undefined)).toBeNull();
  });
});

describe('sanitizeDetails: conserva datos estructurales no-PII', () => {
  test('ids, conteos y banderas', () => {
    const out = JSON.parse(sanitizeDetails({
      id: 5, employee_id: 7, count: 3, matched: true, found: true,
    }));
    expect(out).toEqual({ id: 5, employee_id: 7, count: 3, matched: true, found: true });
  });

  test('enums y fechas civiles', () => {
    const out = JSON.parse(sanitizeDetails({
      role: 'supervisor', status: 'active', period: '2026-07', date: '2026-07-01',
    }));
    expect(out).toEqual({ role: 'supervisor', status: 'active', period: '2026-07', date: '2026-07-01' });
  });

  test('listas de nombres de campo (no de valores)', () => {
    const out = JSON.parse(sanitizeDetails({ fields: ['first_name', 'branch_id'] }));
    expect(out).toEqual({ fields: ['first_name', 'branch_id'] });
  });

  test('array de ids numéricos', () => {
    const out = JSON.parse(sanitizeDetails({ devices: [1, 2, 3] }));
    expect(out).toEqual({ devices: [1, 2, 3] });
  });
});

describe('integración: audit.log escribe details ya saneados', () => {
  test('el email pasado por el caller no llega a la columna details', async () => {
    sequelize.query.mockClear();
    await audit.log({
      req: null, user: { id: 1, username: 'op' },
      action: 'password_forgot',
      details: { email: 'secreto@example.com', found: false },
    });
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    const replacements = sequelize.query.mock.calls[0][1].replacements;
    const detailsCol = replacements[replacements.length - 1];
    expect(detailsCol).toBe(JSON.stringify({ found: false }));
    expect(detailsCol).not.toMatch(/secreto@example\.com/);
  });
});
