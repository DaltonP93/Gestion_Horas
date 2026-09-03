import { getHelpContent } from '../helpContent'

describe('getHelpContent — módulos FASE F+', () => {
  test.each([
    ['/candidatos', 'Candidatos'],
    ['/configuracion/empresas', 'Empresas'],
    ['/configuracion/centros-costo', 'Centros de costo'],
    ['/configuracion/calendario-laboral', 'Calendario laboral'],
    ['/configuracion/nomina-base', 'Nómina — base (sandbox)'],
  ])('%s tiene ayuda contextual con título "%s"', (path, title) => {
    const c = getHelpContent(path)
    expect(c).not.toBeNull()
    expect(c!.title).toBe(title)
    expect(c!.sections.length).toBeGreaterThan(0)
  })

  test('la ficha del empleado (/empleados/:id) muestra la ayuda de historial organizativo', () => {
    const c = getHelpContent('/empleados/123')
    expect(c?.title).toBe('Historial organizativo del empleado')
  })

  test('el listado /empleados conserva su propia ayuda (no la del detalle)', () => {
    const c = getHelpContent('/empleados')
    expect(c?.title).toBe('Empleados')
  })

  test('la nómina sandbox deja explícito el límite NO OFICIAL', () => {
    const c = getHelpContent('/configuracion/nomina-base')
    expect(JSON.stringify(c)).toMatch(/NO OFICIAL/)
  })
})
