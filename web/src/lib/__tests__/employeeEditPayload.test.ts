/**
 * employeeEditPayload.test.ts — PR 1 (modal de edición del empleado).
 *
 * Cubre las funciones puras que arman el payload del PUT desde el estado del
 * formulario. El modal (`EmployeeEditModal.tsx`) las consume pero no vive
 * dentro del test — sólo se prueba la lógica que corre en el submit.
 */

import {
  snapshotOf,
  buildPayload,
  filterByCaps,
  normalizeForField,
} from '../employeeEditPayload'

describe('snapshotOf', () => {
  test('empleado completo → strings listas para inputs controlados', () => {
    const snap = snapshotOf({
      id: 1, first_name: 'Ana', last_name: 'García',
      email: 'ana@x.co', phone: '+595981', position: 'Cajera',
      hire_date: '2020-01-15T00:00:00Z',
      birth_date: '1985-04-20T12:00:00Z',
      department_id: 3, branch_id: 7, schedule_id: 12,
      document_number: '1234567', ips_number: '99-88',
      salary_base: 2899048, pay_type: 'jornalero', gender: 'F', children_count: 2,
    })
    expect(snap.first_name).toBe('Ana')
    expect(snap.hire_date).toBe('2020-01-15')  // sólo YYYY-MM-DD
    expect(snap.birth_date).toBe('1985-04-20')
    expect(snap.department_id).toBe('3')
    expect(snap.branch_id).toBe('7')
    expect(snap.schedule_id).toBe('12')
    expect(snap.salary_base).toBe('2899048')
    expect(snap.pay_type).toBe('jornalero')
    expect(snap.children_count).toBe('2')
  })

  test('empleado sin fecha ni tipo de pago → defaults sanos', () => {
    const snap = snapshotOf({ first_name: 'X', last_name: 'Y' })
    expect(snap.hire_date).toBe('')
    expect(snap.birth_date).toBe('')
    expect(snap.pay_type).toBe('mensualizado') // default visible
    expect(snap.children_count).toBe('0')      // NOT_NULL → 0
    expect(snap.department_id).toBe('')
    expect(snap.branch_id).toBe('')
  })

  test('empleado nulo → forma completa con strings vacías', () => {
    const snap = snapshotOf(null)
    expect(snap.first_name).toBe('')
    expect(snap.pay_type).toBe('mensualizado')
    expect(snap.children_count).toBe('0')
  })
})

describe('normalizeForField', () => {
  test('salary_base: strip de miles', () => {
    expect(normalizeForField('salary_base', '1.500.000')).toBe('1500000')
    expect(normalizeForField('salary_base', 'Gs. 2 899 048')).toBe('2899048')
  })
  test('FK y children_count: string → Number, vacío → ""', () => {
    expect(normalizeForField('department_id', '5')).toBe(5)
    expect(normalizeForField('branch_id', '')).toBe('')
    expect(normalizeForField('schedule_id', '12')).toBe(12)
    expect(normalizeForField('children_count', '3')).toBe(3)
  })
  test('el resto pasa como string', () => {
    expect(normalizeForField('first_name', 'Ana ')).toBe('Ana ')
  })
})

describe('buildPayload', () => {
  const baseForm = snapshotOf({
    first_name: 'Ana', last_name: 'García',
    email: 'ana@x.co', phone: '+595981',
    hire_date: '2020-01-15', birth_date: '1985-04-20',
    position: 'Cajera', department_id: 3, branch_id: 7, schedule_id: 12,
    document_number: '1234567', ips_number: '99-88',
    salary_base: 2899048, pay_type: 'jornalero',
    gender: 'F', children_count: 2,
  })

  test('payload válido: sin errores, tipos correctos, FKs numéricas', () => {
    const r = buildPayload(baseForm)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.first_name).toBe('Ana')
    expect(r.payload.salary_base).toBe(2899048)
    expect(r.payload.department_id).toBe(3)
    expect(r.payload.branch_id).toBe(7)
    expect(r.payload.schedule_id).toBe(12)
    expect(r.payload.children_count).toBe(2)
    expect(r.payload.pay_type).toBe('jornalero')
  })

  test('salario negativo → error en salary_base (no arranca PUT)', () => {
    // El input CurrencyInput conserva el "-" via stripThousands para que el
    // validador lo rechace explícitamente con "≥ 0". Es el error que el
    // usuario ve si teclea un menos.
    const r = buildPayload({ ...baseForm, salary_base: '-500' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fieldErrors.salary_base).toMatch(/≥ 0|no-negativo|negativo|debe ser/i)
  })

  test('salario obviamente fuera de rango → error (validator rechaza > 1e12)', () => {
    const r = buildPayload({ ...baseForm, salary_base: '9999999999999' }) // 13 dígitos
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fieldErrors.salary_base).toMatch(/rango|fuera/i)
  })

  test('nombre vacío → error (NOT NULL)', () => {
    const r = buildPayload({ ...baseForm, first_name: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fieldErrors.first_name).toMatch(/requerido/i)
  })

  test('FKs limpias (usuario deseleccionó dept/sede/horario) → null', () => {
    const r = buildPayload({ ...baseForm, department_id: '', branch_id: '', schedule_id: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.department_id).toBeNull()
    expect(r.payload.branch_id).toBeNull()
    expect(r.payload.schedule_id).toBeNull()
  })

  test('salario limpio → null (para roles con legal.update)', () => {
    const r = buildPayload({ ...baseForm, salary_base: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.salary_base).toBeNull()
  })
})

describe('filterByCaps', () => {
  const fullPayload = {
    first_name: 'Ana',
    last_name: 'García',
    department_id: 3,
    branch_id: 7,
    salary_base: 2500000,
    ips_number: '99-88',
    document_number: '1234567',
    pay_type: 'jornalero',
    gender: 'F',
    children_count: 2,
  }

  test('con ambas caps: pasa todo', () => {
    const r = filterByCaps(fullPayload, { personal_update: true, legal_update: true })
    expect(Object.keys(r).sort()).toEqual(Object.keys(fullPayload).sort())
  })

  test('sólo personal_update: filtra los legales', () => {
    const r = filterByCaps(fullPayload, { personal_update: true, legal_update: false })
    expect(r).toHaveProperty('first_name')
    expect(r).toHaveProperty('department_id')
    expect(r).toHaveProperty('branch_id')
    expect(r).not.toHaveProperty('salary_base')
    expect(r).not.toHaveProperty('ips_number')
    expect(r).not.toHaveProperty('pay_type')
    expect(r).not.toHaveProperty('gender')
    expect(r).not.toHaveProperty('children_count')
    expect(r).not.toHaveProperty('document_number')
  })

  test('sólo legal_update (rol raro): filtra los personales', () => {
    const r = filterByCaps(fullPayload, { personal_update: false, legal_update: true })
    expect(r).toHaveProperty('salary_base')
    expect(r).toHaveProperty('ips_number')
    expect(r).toHaveProperty('gender')
    expect(r).not.toHaveProperty('first_name')
    expect(r).not.toHaveProperty('department_id')
    expect(r).not.toHaveProperty('branch_id')
  })

  test('sin caps: payload vacío (el modal debe abortar antes de enviar)', () => {
    const r = filterByCaps(fullPayload, {})
    expect(r).toEqual({})
  })
})

describe('snapshotOf — salario que llega como DECIMAL de MySQL', () => {
  test('"3500000.00" entra al formulario como "3500000"', () => {
    expect(snapshotOf({ salary_base: '3500000.00' }).salary_base).toBe('3500000')
  })

  test('un number entero también', () => {
    expect(snapshotOf({ salary_base: 3500000 }).salary_base).toBe('3500000')
  })

  test('buildPayload sobre ese snapshot devuelve 3500000, no 350000000', () => {
    const form = snapshotOf({
      first_name: 'Ana', last_name: 'Gómez', pay_type: 'mensualizado',
      children_count: 0, salary_base: '3500000.00',
    })
    const r = buildPayload(form)
    expect(r.ok).toBe(true)
    expect(r.payload.salary_base).toBe(3500000)
  })

  test('tres ciclos abrir → guardar → releer conservan 3500000', () => {
    // Simula lo que hace el backend: persiste el entero y lo devuelve como
    // DECIMAL. Antes del fix cada vuelta multiplicaba por 100.
    let fromApi: string | number = '3500000.00'
    for (let i = 0; i < 3; i++) {
      const form = snapshotOf({
        first_name: 'Ana', last_name: 'Gómez', pay_type: 'mensualizado',
        children_count: 0, salary_base: fromApi,
      })
      const r = buildPayload(form)
      expect(r.ok).toBe(true)
      expect(r.payload.salary_base).toBe(3500000)
      fromApi = `${r.payload.salary_base}.00`
    }
  })

  test('salario nulo o ausente queda vacío', () => {
    expect(snapshotOf({ salary_base: null }).salary_base).toBe('')
    expect(snapshotOf({}).salary_base).toBe('')
  })
})
