/**
 * Verifica contra el REGISTRO REAL de módulos (NAV_GROUPS de navModules) que el
 * módulo Talento existe con su slug canónico y que tanto la ruta canónica como
 * el alias resuelven al mismo módulo (lo que consumen ModuleLanding, el sidebar
 * y los breadcrumbs vía groupById / locateByPath). No se limita a navRouting.
 */
import { NAV_GROUPS, groupById, locateByPath } from '@/lib/navModules'
import { normalizeGroupSlug } from '@/lib/navRouting'

describe('registro real de módulos — Talento', () => {
  test('el slug canónico del módulo es "talento" (no "talento-desarrollo")', () => {
    expect(groupById('talento')).not.toBeNull()
    expect(groupById('talento-desarrollo')).toBeNull()
  })

  test('groupById("talento") trae los submódulos reales', () => {
    const g = groupById('talento')!
    const hrefs = g.items.map(i => i.href)
    expect(hrefs).toEqual(expect.arrayContaining(['/capacitaciones', '/encuestas', '/evaluaciones']))
    expect(g.label).toBe('Talento y desarrollo')
  })

  test('ModuleLanding: normalizar el alias antes de buscar evita "Módulo no encontrado"', () => {
    // Esto replica lo que hace ModuleLanding: groupById(normalizeGroupSlug(slug)).
    expect(groupById(normalizeGroupSlug('talento-desarrollo'))).not.toBeNull()
    expect(groupById(normalizeGroupSlug('talento-desarrollo'))!.id).toBe('talento')
  })

  test('locateByPath resuelve la ruta canónica y el alias al mismo módulo', () => {
    expect(locateByPath('/m/talento')?.group.id).toBe('talento')
    expect(locateByPath('/m/talento-desarrollo')?.group.id).toBe('talento')
  })

  test('locateByPath de un submódulo apunta al grupo Talento y su ítem', () => {
    const loc = locateByPath('/capacitaciones')
    expect(loc?.group.id).toBe('talento')
    expect(loc?.item?.href).toBe('/capacitaciones')
  })

  test('todos los ids de NAV_GROUPS son slugs válidos y únicos', () => {
    const ids = NAV_GROUPS.map(g => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z-]+$/)
  })
})
