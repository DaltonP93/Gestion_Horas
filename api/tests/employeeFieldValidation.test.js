const { validate, auditValueOf, SENSITIVE_VALUE } = require('../src/services/employeeFieldValidation');

describe('employeeFieldValidation.validate', () => {
  test('cadena vacía / null / undefined → limpia el campo (null)', () => {
    for (const raw of ['', null, undefined]) {
      const r = validate('phone', raw);
      expect(r).toEqual({ ok: true, value: null });
    }
    // Sólo espacios: al recortarse queda vacío → falla el regex de teléfono.
    expect(validate('phone', '   ').ok).toBe(false);
  });

  test('salario base: rechaza negativos, acepta 0 y positivos', () => {
    expect(validate('salary_base', -1).ok).toBe(false);
    expect(validate('salary_base', 0)).toEqual({ ok: true, value: 0 });
    expect(validate('salary_base', 1500000)).toEqual({ ok: true, value: 1500000 });
    expect(validate('salary_base', 'abc').ok).toBe(false);
    expect(validate('salary_base', 1e13).ok).toBe(false);
  });

  test('hijos: entero 0..30', () => {
    expect(validate('children_count', 0)).toEqual({ ok: true, value: 0 });
    expect(validate('children_count', 5)).toEqual({ ok: true, value: 5 });
    expect(validate('children_count', -1).ok).toBe(false);
    expect(validate('children_count', 31).ok).toBe(false);
    expect(validate('children_count', 2.5).ok).toBe(false);
  });

  test('antigüedad: 0..100', () => {
    expect(validate('antiguedad_rate', 0).ok).toBe(true);
    expect(validate('antiguedad_rate', 15.5).ok).toBe(true);
    expect(validate('antiguedad_rate', -1).ok).toBe(false);
    expect(validate('antiguedad_rate', 101).ok).toBe(false);
  });

  test('C.I. y N° IPS: formato numérico con separadores', () => {
    expect(validate('document_number', '1.234.567').ok).toBe(true);
    expect(validate('document_number', 'abc').ok).toBe(false);
    expect(validate('ips_number', '99-88').ok).toBe(true);
    expect(validate('ips_number', 'xx').ok).toBe(false);
  });

  test('género y pay_type limitados a conjunto', () => {
    expect(validate('gender', 'X').ok).toBe(false);
    expect(validate('gender', 'M').ok).toBe(true);
    expect(validate('pay_type', 'mensualizado').ok).toBe(true);
    expect(validate('pay_type', 'otro').ok).toBe(false);
  });

  test('email y fecha: formato', () => {
    expect(validate('email', 'x@y').ok).toBe(false);
    expect(validate('email', 'a@b.co').ok).toBe(true);
    expect(validate('birth_date', '1990-01-02').ok).toBe(true);
    expect(validate('birth_date', '02/01/1990').ok).toBe(false);
  });

  test('campo desconocido → error', () => {
    expect(validate('salario', 100).ok).toBe(false);
  });
});

describe('employeeFieldValidation.auditValueOf', () => {
  test('salary_base NUNCA se registra en la auditoría', () => {
    expect(auditValueOf('salary_base', 1500000)).toBeNull();
    expect(SENSITIVE_VALUE.has('salary_base')).toBe(true);
  });
  test('otros campos sí conservan valor', () => {
    expect(auditValueOf('first_name', 'Ana')).toBe('Ana');
    expect(auditValueOf('children_count', 3)).toBe(3);
  });
});
