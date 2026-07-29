import { validateEmployeeField, isLegalField } from '@/lib/employeeFieldValidation'

describe('validateEmployeeField', () => {
  test('vacío / null / undefined limpia el campo', () => {
    for (const raw of ['', null, undefined]) {
      expect(validateEmployeeField('phone', raw as any)).toEqual({ ok: true, value: null })
    }
  })

  test('salario base rechaza negativos, acepta cero y positivos', () => {
    expect(validateEmployeeField('salary_base', -1).ok).toBe(false)
    expect(validateEmployeeField('salary_base', 0)).toEqual({ ok: true, value: 0 })
    expect(validateEmployeeField('salary_base', '1500000')).toEqual({ ok: true, value: 1500000 })
    expect(validateEmployeeField('salary_base', 'abc').ok).toBe(false)
  })

  test('hijos: entero 0..30', () => {
    expect(validateEmployeeField('children_count', 0)).toEqual({ ok: true, value: 0 })
    expect(validateEmployeeField('children_count', 5)).toEqual({ ok: true, value: 5 })
    expect(validateEmployeeField('children_count', 2.5).ok).toBe(false)
    expect(validateEmployeeField('children_count', 31).ok).toBe(false)
  })

  test('antigüedad: 0..100', () => {
    expect(validateEmployeeField('antiguedad_rate', 0).ok).toBe(true)
    expect(validateEmployeeField('antiguedad_rate', 100).ok).toBe(true)
    expect(validateEmployeeField('antiguedad_rate', -1).ok).toBe(false)
    expect(validateEmployeeField('antiguedad_rate', 101).ok).toBe(false)
  })

  test('C.I. e IPS: rechazan basura, aceptan dígitos y separadores', () => {
    expect(validateEmployeeField('document_number', '1.234.567').ok).toBe(true)
    expect(validateEmployeeField('document_number', 'no').ok).toBe(false)
    expect(validateEmployeeField('ips_number', '99-88').ok).toBe(true)
  })

  test('género y pay_type: valores limitados', () => {
    expect(validateEmployeeField('gender', 'M').ok).toBe(true)
    expect(validateEmployeeField('gender', 'X').ok).toBe(false)
    expect(validateEmployeeField('pay_type', 'mensualizado').ok).toBe(true)
    expect(validateEmployeeField('pay_type', 'otro').ok).toBe(false)
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
})

describe('isLegalField', () => {
  test('conjunto MTESS/IPS', () => {
    for (const f of ['document_number', 'ips_number', 'salary_base', 'gender', 'pay_type', 'children_count', 'antiguedad_rate']) {
      expect(isLegalField(f)).toBe(true)
    }
  })
  test('personales no son legales', () => {
    for (const f of ['first_name', 'last_name', 'email', 'phone', 'position', 'hire_date', 'birth_date']) {
      expect(isLegalField(f)).toBe(false)
    }
  })
})
