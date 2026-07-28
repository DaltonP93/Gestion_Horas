import { locateGroupIdByPath, NAV_ROUTES, normalizeGroupSlug, MODULE_ALIASES } from '../navRouting'

describe('navRouting.locateGroupIdByPath', () => {
  // Rutas /m/<slug> → su módulo (páginas principales de módulo)
  test('/m/administracion → administracion', () => {
    expect(locateGroupIdByPath('/m/administracion')).toBe('administracion')
  })
  test('/m/talento → talento (canónico)', () => {
    expect(locateGroupIdByPath('/m/talento')).toBe('talento')
  })
  test('/m/talento-desarrollo → talento (alias normalizado)', () => {
    expect(locateGroupIdByPath('/m/talento-desarrollo')).toBe('talento')
  })
  test('/m/mi-equipo → mi-equipo', () => {
    expect(locateGroupIdByPath('/m/mi-equipo')).toBe('mi-equipo')
  })
  test('/m/<slug> inexistente → null', () => {
    expect(locateGroupIdByPath('/m/no-existe')).toBeNull()
  })

  // Submódulos → su módulo
  test('/configuracion → administracion', () => {
    expect(locateGroupIdByPath('/configuracion')).toBe('administracion')
  })
  test('/configuracion/sincronizacion → administracion (prefijo más largo gana)', () => {
    expect(locateGroupIdByPath('/configuracion/sincronizacion')).toBe('administracion')
  })
  test('/empleados → gestion-personal', () => {
    expect(locateGroupIdByPath('/empleados')).toBe('gestion-personal')
  })
  test('/empleados/123 (subruta) → gestion-personal', () => {
    expect(locateGroupIdByPath('/empleados/123')).toBe('gestion-personal')
  })
  test('/dashboard → inicio', () => {
    expect(locateGroupIdByPath('/dashboard')).toBe('inicio')
  })
  test('ruta sin módulo → null', () => {
    expect(locateGroupIdByPath('/cuenta/perfil')).toBeNull()
  })

  // Cada grupo tiene id no vacío y al menos una ruta.
  test('NAV_ROUTES bien formado', () => {
    for (const g of NAV_ROUTES) {
      expect(g.id).toMatch(/^[a-z-]+$/)
      expect(g.paths.length).toBeGreaterThan(0)
    }
  })
})

describe('normalizeGroupSlug (alias de módulos)', () => {
  test('talento-desarrollo → talento', () => {
    expect(normalizeGroupSlug('talento-desarrollo')).toBe('talento')
  })
  test('slug canónico se devuelve igual', () => {
    expect(normalizeGroupSlug('talento')).toBe('talento')
    expect(normalizeGroupSlug('administracion')).toBe('administracion')
  })
  test('slug desconocido se devuelve tal cual', () => {
    expect(normalizeGroupSlug('no-existe')).toBe('no-existe')
  })
  test('todo alias apunta a un id real de NAV_ROUTES', () => {
    for (const target of Object.values(MODULE_ALIASES)) {
      expect(NAV_ROUTES.some(g => g.id === target)).toBe(true)
    }
  })
  test('ningún alias colisiona con un id canónico existente', () => {
    for (const alias of Object.keys(MODULE_ALIASES)) {
      expect(NAV_ROUTES.some(g => g.id === alias)).toBe(false)
    }
  })
})

describe('submódulos de Talento → talento', () => {
  test.each(['/capacitaciones', '/encuestas', '/evaluaciones', '/capacitaciones/5'])(
    '%s → talento', (p) => { expect(locateGroupIdByPath(p)).toBe('talento') },
  )
})
