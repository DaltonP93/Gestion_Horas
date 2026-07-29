import { readFileSync } from 'fs'
import { join } from 'path'
import {
  purgeLegacyConnCreds, LEGACY_CONN_KEY, TARGET_KEY, PURGE_FLAG,
} from '../att2000Target'
import {
  testConnBody, fullSyncBody, pushBody, bodyHasNoCredentials,
} from '../att2000Requests'

// Almacenamiento falso (no hay window en el entorno node de jest).
function fakeStorage(seed: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    store: m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

describe('purgeLegacyConnCreds — borra credenciales heredadas una sola vez', () => {
  test('elimina la clave heredada sishoras_db_conn (posibles contraseñas viejas)', () => {
    const s = fakeStorage({ [LEGACY_CONN_KEY]: JSON.stringify({ user: 'sa', password: 'vieja' }) })
    expect(purgeLegacyConnCreds(s)).toBe(true)
    expect(s.getItem(LEGACY_CONN_KEY)).toBeNull()
    // No queda rastro de la contraseña heredada en el storage.
    expect(JSON.stringify([...s.store.entries()])).not.toContain('vieja')
  })

  test('también borra el destino sishoras_att2000_target (ya no se guarda en el navegador)', () => {
    const s = fakeStorage({ [TARGET_KEY]: JSON.stringify({ host: '10.0.0.5' }) })
    purgeLegacyConnCreds(s)
    expect(s.getItem(TARGET_KEY)).toBeNull()
  })

  test('se ejecuta UNA sola vez (deja marcador y no vuelve a purgar)', () => {
    const s = fakeStorage()
    expect(purgeLegacyConnCreds(s)).toBe(true)
    expect(s.getItem(PURGE_FLAG)).toBeTruthy()
    // Si aparece de nuevo una clave heredada tras la purga, ya no se toca.
    s.setItem(LEGACY_CONN_KEY, 'algo')
    expect(purgeLegacyConnCreds(s)).toBe(false)
    expect(s.getItem(LEGACY_CONN_KEY)).toBe('algo')
  })
})

describe('cuerpos de petición — sólo parámetros funcionales, sin credenciales', () => {
  test('test-conn no envía cuerpo (usa el .env del servidor)', () => {
    expect(testConnBody()).toEqual({})
    expect(bodyHasNoCredentials(testConnBody())).toBe(true)
  })

  test('full sync sólo envía el rango de fechas', () => {
    const body = fullSyncBody({ dateFrom: '2026-07-01', dateTo: '2026-07-10' })
    expect(Object.keys(body).sort()).toEqual(['dateFrom', 'dateTo'])
    expect(bodyHasNoCredentials(body)).toBe(true)
  })

  test('push sólo envía el rango de fechas', () => {
    const body = pushBody({ dateFrom: '2026-07-01', dateTo: '2026-07-10' })
    expect(Object.keys(body).sort()).toEqual(['dateFrom', 'dateTo'])
    expect(bodyHasNoCredentials(body)).toBe(true)
  })

  test('bodyHasNoCredentials detecta user/password/host/conn', () => {
    expect(bodyHasNoCredentials({ user: 'sa', password: 'x' })).toBe(false)
    expect(bodyHasNoCredentials({ conn: { host: 'h' } })).toBe(false)
    expect(bodyHasNoCredentials({ dateFrom: 'a', dateTo: 'b' })).toBe(true)
  })
})

describe('la página legada no renderiza ni envía credenciales', () => {
  const pageSrc = readFileSync(
    join(__dirname, '../../app/(app)/sistema/legado-att2000/page.tsx'),
    'utf8',
  )

  test('no hay campos de usuario ni contraseña', () => {
    expect(pageSrc).not.toMatch(/type=['"]password['"]/)
    expect(pageSrc).not.toMatch(/showPass/)
    expect(pageSrc).not.toMatch(/conn\.(user|password)/)
    expect(pageSrc).not.toMatch(/setField\(['"](user|password)['"]\)/)
  })

  test('no persiste destino ni credenciales en localStorage (sólo purga la clave heredada)', () => {
    expect(pageSrc).not.toMatch(/localStorage\.setItem/)
    expect(pageSrc).toMatch(/purgeLegacyConnCreds\(\)/)
  })

  test('las peticiones usan los builders sin credenciales (no envía `conn`)', () => {
    expect(pageSrc).toMatch(/api\.post\('\/api\/sync\/test-conn'\)/)
    expect(pageSrc).toMatch(/fullSyncBody\(/)
    expect(pageSrc).not.toMatch(/api\.post\('\/api\/sync\/full',\s*\{[^}]*conn/)
  })
})
