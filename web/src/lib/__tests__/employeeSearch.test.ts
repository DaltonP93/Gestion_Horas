import { shouldSearch, employeeLabel, employeeMeta, employeeInputText } from '../employeeSearch'

describe('shouldSearch', () => {
  test('no consulta con el campo vacío', () => {
    expect(shouldSearch('')).toBe(false)
    expect(shouldSearch('   ')).toBe(false)
  })

  test('exige dos caracteres para texto', () => {
    expect(shouldSearch('a')).toBe(false)
    expect(shouldSearch('ma')).toBe(true)
    expect(shouldSearch('María')).toBe(true)
  })

  test('★ los términos numéricos buscan desde un solo dígito', () => {
    // Códigos y legajos son cortos y se tipean de memoria. Exigir dos dígitos
    // volvería inalcanzable al empleado con código "7".
    expect(shouldSearch('7')).toBe(true)
    expect(shouldSearch('42')).toBe(true)
    expect(shouldSearch('1001')).toBe(true)
  })

  test('ignora espacios alrededor', () => {
    expect(shouldSearch('  7  ')).toBe(true)
    expect(shouldSearch('  a  ')).toBe(false)
  })
})

describe('employeeLabel', () => {
  test('usa full_name cuando está', () => {
    expect(employeeLabel({ id: 1, full_name: 'María Rodríguez' })).toBe('María Rodríguez')
  })

  test('compone nombre y apellido si no hay full_name', () => {
    expect(employeeLabel({ id: 1, first_name: 'María', last_name: 'Rodríguez' }))
      .toBe('María Rodríguez')
  })

  test('tolera datos incompletos', () => {
    expect(employeeLabel({ id: 1, first_name: 'María' })).toBe('María')
    expect(employeeLabel({ id: 1 })).toBe('')
    expect(employeeLabel(null)).toBe('')
  })
})

describe('employeeMeta', () => {
  test('arma "Cód. XXXX · Departamento"', () => {
    expect(employeeMeta({ id: 1, code: 'E001', department: 'Administración' }))
      .toBe('Cód. E001 · Administración')
  })

  test('omite la parte faltante en vez de dejar separadores huérfanos', () => {
    // Un empleado sin departamento no debe mostrar "Cód. E001 · " ni "null".
    expect(employeeMeta({ id: 1, code: 'E001' })).toBe('Cód. E001')
    expect(employeeMeta({ id: 1, department: 'Ventas' })).toBe('Ventas')
    expect(employeeMeta({ id: 1, code: 'E001', department: null })).toBe('Cód. E001')
    expect(employeeMeta({ id: 1 })).toBe('')
  })

  test('acepta department_name como alias', () => {
    expect(employeeMeta({ id: 1, code: 'E9', department_name: 'RRHH' })).toBe('Cód. E9 · RRHH')
  })
})

describe('employeeInputText', () => {
  test('muestra nombre y código en una línea', () => {
    expect(employeeInputText({ id: 1, full_name: 'María Rodríguez', code: 'E001' }))
      .toBe('María Rodríguez (E001)')
  })

  test('sin código, sólo el nombre', () => {
    expect(employeeInputText({ id: 1, full_name: 'María Rodríguez' })).toBe('María Rodríguez')
  })
})
