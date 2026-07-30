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

  test('salario base: entero no-negativo, sin decimales ni separadores', () => {
    expect(validate('salary_base', -1).ok).toBe(false);
    expect(validate('salary_base', 0)).toEqual({ ok: true, value: 0 });
    expect(validate('salary_base', 1500000)).toEqual({ ok: true, value: 1500000 });
    expect(validate('salary_base', '2899048')).toEqual({ ok: true, value: 2899048 });
    // Decimales rechazados.
    expect(validate('salary_base', 2500.5).ok).toBe(false);
    expect(validate('salary_base', '2500.50').ok).toBe(false);
    expect(validate('salary_base', '2.500,50').ok).toBe(false);
    // Separadores de miles: la UI envía el entero limpio.
    expect(validate('salary_base', '1.000').ok).toBe(false);
    expect(validate('salary_base', '1,000').ok).toBe(false);
    expect(validate('salary_base', 'abc').ok).toBe(false);
    expect(validate('salary_base', 1e13).ok).toBe(false);
  });

  test('salario base: null / vacío limpia el campo', () => {
    expect(validate('salary_base', null)).toEqual({ ok: true, value: null });
    expect(validate('salary_base', '')).toEqual({ ok: true, value: null });
  });

  test('pay_type: valida slug; catálogo lo verifica en el handler', () => {
    // Sólo formato: la existencia+active se comprueba contra payment_types.
    expect(validate('pay_type', 'mensualizado').ok).toBe(true);
    expect(validate('pay_type', 'nuevo_pago').ok).toBe(true);
    expect(validate('pay_type', 'Mensualizado').ok).toBe(false);   // mayúscula
    expect(validate('pay_type', 'con espacios').ok).toBe(false);
    expect(validate('pay_type', '123_num').ok).toBe(false);         // empieza en dígito
    expect(validate('pay_type', '').ok).toBe(false);               // NOT_NULL
  });

  test('hijos: entero 0..30', () => {
    expect(validate('children_count', 0)).toEqual({ ok: true, value: 0 });
    expect(validate('children_count', 5)).toEqual({ ok: true, value: 5 });
    expect(validate('children_count', -1).ok).toBe(false);
    expect(validate('children_count', 31).ok).toBe(false);
    expect(validate('children_count', 2.5).ok).toBe(false);
  });

  test('antigüedad: no editable — se deriva de hire_date', () => {
    // PR-B: la columna legada `antiguedad_rate` queda cerrada al update
    // público. Cualquier intento devuelve error explícito.
    for (const raw of [0, 5, 80, '10', -1, 15.5, null, '']) {
      const r = validate('antiguedad_rate', raw);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/fecha de ingreso|no editable|calcula/i);
    }
  });

  test('C.I. y N° IPS: formato numérico con separadores', () => {
    expect(validate('document_number', '1.234.567').ok).toBe(true);
    expect(validate('document_number', 'abc').ok).toBe(false);
    expect(validate('ips_number', '99-88').ok).toBe(true);
    expect(validate('ips_number', 'xx').ok).toBe(false);
  });

  test('género: valores limitados a conjunto', () => {
    expect(validate('gender', 'X').ok).toBe(false);
    expect(validate('gender', 'M').ok).toBe(true);
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

  test('campos NOT NULL rechazan blank en lugar de propagar null', () => {
    for (const f of ['first_name', 'last_name', 'pay_type', 'children_count']) {
      const r = validate(f, '');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/requerido/i);
    }
    // Los NULLables sí aceptan blank como "limpiar".
    for (const f of ['phone', 'email', 'position', 'document_number', 'ips_number', 'salary_base', 'gender']) {
      expect(validate(f, '')).toEqual({ ok: true, value: null });
    }
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
