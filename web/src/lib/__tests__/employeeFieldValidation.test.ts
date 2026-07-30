import { validateEmployeeField, isLegalField } from '@/lib/employeeFieldValidation'

describe('validateEmployeeField', () => {
  test('vacío / null / undefined limpia el campo', () => {
    for (const raw of ['', null, undefined]) {
      expect(validateEmployeeField('phone', raw as any)).toEqual({ ok: true, value: null })
    }
  })

  test('salario base: entero no-negativo, sin decimales ni separadores', () => {
    expect(validateEmployeeField('salary_base', -1).ok).toBe(false)
    expect(validateEmployeeField('salary_base', 0)).toEqual({ ok: true, value: 0 })
    expect(validateEmployeeField('salary_base', '1500000')).toEqual({ ok: true, value: 1500000 })
    expect(validateEmployeeField('salary_base', '2899048')).toEqual({ ok: true, value: 2899048 })
    expect(validateEmployeeField('salary_base', 2500.5).ok).toBe(false)
    expect(validateEmployeeField('salary_base', '2500.50').ok).toBe(false)
    expect(validateEmployeeField('salary_base', '2.500,50').ok).toBe(false)
    expect(validateEmployeeField('salary_base', '1.000').ok).toBe(false)
    expect(validateEmployeeField('salary_base', '1,000').ok).toBe(false)
    expect(validateEmployeeField('salary_base', 'abc').ok).toBe(false)
  })

  test('salario base: null / vacío limpia el campo (backend valida permiso)', () => {
    expect(validateEmployeeField('salary_base', null as any)).toEqual({ ok: true, value: null })
    expect(validateEmployeeField('salary_base', '')).toEqual({ ok: true, value: null })
  })

  test('hijos: entero 0..30', () => {
    expect(validateEmployeeField('children_count', 0)).toEqual({ ok: true, value: 0 })
    expect(validateEmployeeField('children_count', 5)).toEqual({ ok: true, value: 5 })
    expect(validateEmployeeField('children_count', 2.5).ok).toBe(false)
    expect(validateEmployeeField('children_count', 31).ok).toBe(false)
  })

  test('antigüedad: no editable — se deriva de hire_date', () => {
    for (const raw of [0, 5, 80, '10', -1, 15.5, null, '']) {
      const r = validateEmployeeField('antiguedad_rate', raw as any)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/fecha de ingreso|calcula/i)
    }
  })

  test('C.I. e IPS: rechazan basura, aceptan dígitos y separadores', () => {
    expect(validateEmployeeField('document_number', '1.234.567').ok).toBe(true)
    expect(validateEmployeeField('document_number', 'no').ok).toBe(false)
    expect(validateEmployeeField('ips_number', '99-88').ok).toBe(true)
  })

  test('género: valores limitados', () => {
    expect(validateEmployeeField('gender', 'M').ok).toBe(true)
    expect(validateEmployeeField('gender', 'X').ok).toBe(false)
  })

  test('pay_type: sólo formato del slug (existencia va al backend)', () => {
    expect(validateEmployeeField('pay_type', 'mensualizado').ok).toBe(true)
    expect(validateEmployeeField('pay_type', 'jornalero').ok).toBe(true)
    expect(validateEmployeeField('pay_type', 'contrato_civil').ok).toBe(true)
    expect(validateEmployeeField('pay_type', 'Mensualizado').ok).toBe(false)
    expect(validateEmployeeField('pay_type', 'con espacios').ok).toBe(false)
    expect(validateEmployeeField('pay_type', '123nada').ok).toBe(false)
  })

  test('email y fecha: formato estricto', () => {
    expect(validateEmployeeField('email', 'a@b.co').ok).toBe(true)
    expect(validateEmployeeField('email', 'no-arroba').ok).toBe(false)
    expect(validateEmployeeField('birth_date', '1990-01-02').ok).toBe(true)
    expect(validateEmployeeField('birth_date', '02/01/1990').ok).toBe(false)
  })

  test('campo desconocido → error', () => {
    expect(validateEmployeeField('salario', 100).ok).toBe(false)
  })

  test('campos NOT NULL rechazan blank', () => {
    for (const f of ['first_name', 'last_name', 'pay_type', 'children_count']) {
      const r = validateEmployeeField(f, '')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/requerido/i)
    }
    for (const f of ['phone', 'email', 'position', 'document_number', 'ips_number', 'salary_base', 'gender']) {
      expect(validateEmployeeField(f, '')).toEqual({ ok: true, value: null })
    }
  })
})

describe('isLegalField', () => {
  test('conjunto MTESS/IPS', () => {
    for (const f of ['document_number', 'ips_number', 'salary_base', 'gender', 'pay_type', 'children_count']) {
      expect(isLegalField(f)).toBe(true)
    }
    // `antiguedad_rate` ya no forma parte del set editable de "legales".
    expect(isLegalField('antiguedad_rate')).toBe(false)
  })
  test('personales no son legales', () => {
    for (const f of ['first_name', 'last_name', 'email', 'phone', 'position', 'hire_date', 'birth_date']) {
      expect(isLegalField(f)).toBe(false)
    }
  })
})
