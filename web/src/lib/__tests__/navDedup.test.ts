import { sanitizeTarget, parseTarget, TARGET_KEY } from '../att2000Target'
import { SISTEMA_CARDS, visibleSistemaCards } from '../sistemaNav'

describe('att2000Target — ninguna credencial en localStorage', () => {
  const conn = { host: '10.0.0.5', port: '1433', database: 'att2000', user: 'sa', password: 'secreta', label: 'ZK' }

  test('sanitizeTarget descarta user y password', () => {
    const t = sanitizeTarget(conn) as any
    expect(t).toEqual({ host: '10.0.0.5', port: '1433', database: 'att2000', label: 'ZK' })
    expect(t.user).toBeUndefined()
    expect(t.password).toBeUndefined()
  })

  test('lo que se persistiría NO contiene la contraseña', () => {
    const persisted = JSON.stringify(sanitizeTarget(conn))
    expect(persisted).not.toContain('secreta')
    expect(persisted).not.toMatch(/password|"user"|"sa"/)
  })

  test('parseTarget ignora credenciales guardadas por versiones viejas', () => {
    const legacyStored = { host: 'h', port: '1', database: 'd', label: 'l', user: 'sa', password: 'vieja' }
    const t = parseTarget(legacyStored) as any
    expect(t.user).toBeUndefined()
    expect(t.password).toBeUndefined()
    expect(JSON.stringify(t)).not.toContain('vieja')
  })

  test('TARGET_KEY es distinto de la clave vieja con credenciales', () => {
    expect(TARGET_KEY).toBe('sishoras_att2000_target')
    expect(TARGET_KEY).not.toBe('sishoras_db_conn')
  })
})

describe('sistemaNav — sin duplicados de navegación', () => {
  const hrefs = SISTEMA_CARDS.map(c => c.href)

  test('no hay tarjetas duplicadas (una entrada por función)', () => {
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  test('NO aparecen las funciones con ubicación canónica en otro lado', () => {
    // Relojes, Salud, Webhooks, Descubrimiento e Importación att2000 NO son tarjetas de Sistema.
    expect(hrefs).not.toContain('/configuracion?tab=relojes')
    expect(hrefs).not.toContain('/configuracion?tab=sync')
    expect(hrefs).not.toContain('/sistema/salud')
    expect(hrefs).not.toContain('/configuracion/webhooks')
    expect(hrefs).not.toContain('/configuracion/discovery')
    // Ninguna tarjeta describe att2000 como flujo normal ("Importación att2000").
    expect(SISTEMA_CARDS.some(c => /importaci[oó]n att2000/i.test(c.title))).toBe(false)
  })

  test('la integración legada att2000 existe y es superOnly', () => {
    const legacy = SISTEMA_CARDS.find(c => c.href === '/sistema/legado-att2000')
    expect(legacy).toBeTruthy()
    expect(legacy!.superOnly).toBe(true)
    expect(legacy!.title).toMatch(/legada att2000/i)
  })

  test('visibleSistemaCards: la legada SÓLO para super_admin', () => {
    const forSuper = visibleSistemaCards(true).map(c => c.href)
    const forOther = visibleSistemaCards(false).map(c => c.href)
    expect(forSuper).toContain('/sistema/legado-att2000')
    expect(forOther).not.toContain('/sistema/legado-att2000')
    // Las tarjetas técnicas genuinas siguen visibles para ambos.
    expect(forOther).toEqual(expect.arrayContaining(['/sistema/procesar', '/sistema/backups', '/sistema/gdpr', '/sistema/embed']))
  })
})
