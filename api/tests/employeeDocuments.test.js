const {
  CATEGORIES, MAX_SIZE_BYTES,
  isValidCategory, isValidPeriod, isAllowedMime,
  sanitizeTitle, defaultTitleFor, canEmployeeAccess,
} = require('../src/services/employeeDocuments');

describe('employeeDocuments.isValidCategory', () => {
  test.each(CATEGORIES)('%s es válida', c => expect(isValidCategory(c)).toBe(true));
  test('otra cosa no es válida', () => {
    expect(isValidCategory('foo')).toBe(false);
    expect(isValidCategory('')).toBe(false);
    expect(isValidCategory(null)).toBe(false);
    expect(isValidCategory(undefined)).toBe(false);
  });
});

describe('employeeDocuments.isValidPeriod', () => {
  test('null / vacío son válidos (opcional para no-payslip)', () => {
    expect(isValidPeriod(null)).toBe(true);
    expect(isValidPeriod('')).toBe(true);
    expect(isValidPeriod(undefined)).toBe(true);
  });
  test('YYYY-MM válido', () => {
    expect(isValidPeriod('2026-01')).toBe(true);
    expect(isValidPeriod('2026-12')).toBe(true);
    expect(isValidPeriod('2099-06')).toBe(true);
  });
  test('mes inválido', () => {
    expect(isValidPeriod('2026-00')).toBe(false);
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(isValidPeriod('2026-1')).toBe(false);
  });
  test('año fuera de rango', () => {
    expect(isValidPeriod('1999-01')).toBe(false);
    expect(isValidPeriod('2100-01')).toBe(false);
  });
  test('formato inválido', () => {
    expect(isValidPeriod('2026/01')).toBe(false);
    expect(isValidPeriod('26-01')).toBe(false);
    expect(isValidPeriod('foo')).toBe(false);
  });
});

describe('employeeDocuments.isAllowedMime', () => {
  test('PDF, imágenes comunes, docx, xlsx', () => {
    for (const m of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) {
      expect(isAllowedMime(m)).toBe(true);
    }
  });
  test('rechaza ejecutables y desconocidos', () => {
    expect(isAllowedMime('application/x-msdownload')).toBe(false);
    expect(isAllowedMime('application/octet-stream')).toBe(false);
    expect(isAllowedMime('')).toBe(false);
    expect(isAllowedMime(null)).toBe(false);
  });
});

describe('employeeDocuments.sanitizeTitle', () => {
  test('recorta espacios y limita a 200', () => {
    expect(sanitizeTitle('  hola  ')).toBe('hola');
    const long = 'x'.repeat(500);
    expect(sanitizeTitle(long).length).toBe(200);
  });
  test('vacío → null', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle(null)).toBeNull();
  });
});

describe('employeeDocuments.defaultTitleFor', () => {
  test('payslip con período', () => {
    expect(defaultTitleFor({ category: 'payslip', period: '2026-07', filename: 'x.pdf' }))
      .toBe('Recibo de sueldo 2026-07');
  });
  test('categoría mapeada', () => {
    expect(defaultTitleFor({ category: 'contract',    filename: 'a.pdf' })).toBe('Contrato');
    expect(defaultTitleFor({ category: 'certificate', filename: 'a.pdf' })).toBe('Certificado');
    expect(defaultTitleFor({ category: 'other',       filename: 'a.pdf' })).toBe('Documento');
  });
  test('fallback a filename sin extensión', () => {
    expect(defaultTitleFor({ category: null, filename: 'informe.pdf' })).toBe('informe');
    expect(defaultTitleFor({ category: null, filename: null })).toBe('Documento');
  });
});

describe('employeeDocuments.canEmployeeAccess', () => {
  test('propio + visible → true', () => {
    expect(canEmployeeAccess({ employee_id: 3, visible_to_employee: 1 }, 3)).toBe(true);
    expect(canEmployeeAccess({ employee_id: 3, visible_to_employee: true }, 3)).toBe(true);
  });
  test('propio pero oculto → false', () => {
    expect(canEmployeeAccess({ employee_id: 3, visible_to_employee: 0 }, 3)).toBe(false);
  });
  test('otro empleado → false', () => {
    expect(canEmployeeAccess({ employee_id: 3, visible_to_employee: 1 }, 4)).toBe(false);
  });
  test('doc null o employee_id null → false', () => {
    expect(canEmployeeAccess(null, 3)).toBe(false);
    expect(canEmployeeAccess({ employee_id: 3, visible_to_employee: 1 }, null)).toBe(false);
  });
});

test('MAX_SIZE_BYTES es 10 MB', () => {
  expect(MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
});
