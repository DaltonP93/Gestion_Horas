import { marcadasParams, marcadasEmailBody } from '../reportParams'

describe('marcadasParams', () => {
  test('la regresión: el departamento viaja como deptId, no como departmentId', () => {
    // La API lee `deptId` (api/src/routes/reports.js). Mandar `departmentId`
    // hacía que el filtro se descartara en silencio y se consultara a toda la
    // empresa.
    const p = marcadasParams({ from: '2026-01-01', to: '2026-01-31', deptId: '7' })

    expect(p).toHaveProperty('deptId', '7')
    expect(p).not.toHaveProperty('departmentId')
  })

  test('el empleado viaja como employeeId', () => {
    const p = marcadasParams({ from: '2026-01-01', to: '2026-01-31', empId: '42' })
    expect(p).toHaveProperty('employeeId', '42')
  })

  test('los filtros vacíos se omiten en vez de mandarse en blanco', () => {
    // Un `deptId=''` en la querystring llega como string vacío y la API lo
    // trataría como valor presente.
    const p = marcadasParams({ from: '2026-01-01', to: '2026-01-31', empId: '', deptId: '' })

    expect(p).toEqual({ from: '2026-01-01', to: '2026-01-31' })
    expect(Object.keys(p)).not.toContain('deptId')
    expect(Object.keys(p)).not.toContain('employeeId')
  })

  test('undefined se comporta igual que vacío', () => {
    const p = marcadasParams({ from: '2026-01-01', to: '2026-01-31' })
    expect(p).toEqual({ from: '2026-01-01', to: '2026-01-31' })
  })

  test('combina ambos filtros', () => {
    const p = marcadasParams({ from: '2026-01-01', to: '2026-01-31', empId: '42', deptId: '7' })
    expect(p).toEqual({
      from: '2026-01-01', to: '2026-01-31', employeeId: '42', deptId: '7',
    })
  })
})

describe('marcadasEmailBody', () => {
  test('el email lleva los mismos filtros que la pantalla', () => {
    // Antes el envío por email no mandaba departamento, así que el reporte
    // que llegaba al buzón no coincidía con el que se veía en pantalla.
    const body = marcadasEmailBody(
      { from: '2026-01-01', to: '2026-01-31', empId: '42', deptId: '7' },
      ['jefe@example.com'],
    )

    expect(body).toEqual({
      from: '2026-01-01', to: '2026-01-31',
      employeeId: '42', deptId: '7',
      recipients: ['jefe@example.com'],
    })
  })

  test('los tres caminos producen los mismos filtros', () => {
    // Es la propiedad que evita que tabla, PDF y email vuelvan a divergir.
    const filtros = { from: '2026-01-01', to: '2026-01-31', empId: '42', deptId: '7' }
    const { recipients, ...delEmail } = marcadasEmailBody(filtros, ['a@b.com'])

    expect(delEmail).toEqual(marcadasParams(filtros))
  })
})
