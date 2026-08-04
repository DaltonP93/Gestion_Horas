/**
 * Refresh de sesión single-flight.
 *
 * Síntoma en producción: varias peticiones protegidas reciben 401 a la vez y
 * cada una dispara su propio POST /api/auth/refresh; se veían renovaciones
 * simultáneas con 200 y 401 mezclados. Como el backend rota el refresh token,
 * el primero gana y los demás llegan con uno ya consumido: una sesión válida
 * terminaba cerrada.
 */
import {
  createAuthSession, isRefreshUrl, safeReturnUrl, loginUrlFor, bearerOf,
  SessionLostError, AUTH_KEYS, type AuthEnv, type AuthMessage, type Tokens,
} from '../authRefresh'

function makeEnv(inicial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(inicial))
  const mensajes: AuthMessage[] = []
  const redirecciones: string[] = []
  const env: AuthEnv = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
    broadcast: (m) => { mensajes.push(m) },
    redirect: (u) => { redirecciones.push(u) },
    currentPath: () => '/empleados?page=2',
    now: () => 1_700_000_000_000,
  }
  return { env, store, mensajes, redirecciones }
}

const sesionValida = { access_token: 'viejo', refresh_token: 'r1', user: '{"id":1}', sish_ui: '{"tema":"oscuro"}' }

describe('single-flight', () => {
  test('cinco 401 simultáneos producen UNA sola renovación', async () => {
    const { env } = makeEnv(sesionValida)
    let llamadas = 0
    const s = createAuthSession(env, async () => {
      llamadas++
      await new Promise(r => setTimeout(r, 20))
      return { accessToken: 'nuevo', refreshToken: 'r2' }
    })

    const tokens = await Promise.all(Array.from({ length: 5 }, () => s.ensureFreshToken('viejo')))

    expect(llamadas).toBe(1)
    expect(tokens).toEqual(['nuevo', 'nuevo', 'nuevo', 'nuevo', 'nuevo'])
  })

  test('las cinco esperan LA MISMA promesa', async () => {
    const { env } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => {
      await new Promise(r => setTimeout(r, 10))
      return { accessToken: 'nuevo', refreshToken: 'r2' }
    })

    const promesas = Array.from({ length: 5 }, () => s.ensureFreshToken('viejo'))
    expect(new Set(promesas).size).toBe(1)
    await Promise.all(promesas)
  })

  test('el token renovado queda guardado y se puede reintentar', async () => {
    const { env, store } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({ accessToken: 'nuevo', refreshToken: 'r2' }))

    await s.ensureFreshToken('viejo')

    expect(store.get('access_token')).toBe('nuevo')
    expect(store.get('refresh_token')).toBe('r2')
  })

  test('después de terminar, un 401 posterior sí dispara otra renovación', async () => {
    const { env } = makeEnv(sesionValida)
    let llamadas = 0
    const s = createAuthSession(env, async () => {
      llamadas++
      return { accessToken: `t${llamadas}`, refreshToken: `r${llamadas}` }
    })

    await s.ensureFreshToken('viejo')
    await s.ensureFreshToken('t1')

    expect(llamadas).toBe(2)
  })

  test('si otra petición ya renovó, no se pide de nuevo', async () => {
    const { env } = makeEnv({ ...sesionValida, access_token: 'yaNuevo' })
    let llamadas = 0
    const s = createAuthSession(env, async () => { llamadas++; return { accessToken: 'x', refreshToken: 'y' } })

    const token = await s.ensureFreshToken('viejo')   // el 401 traía el token viejo

    expect(token).toBe('yaNuevo')
    expect(llamadas).toBe(0)
  })
})

describe('fallo definitivo', () => {
  test('cierra sesión UNA sola vez aunque fallen cinco peticiones', async () => {
    const { env, redirecciones, mensajes } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => { throw new Error('401 del refresh') })

    const res = await Promise.allSettled(Array.from({ length: 5 }, () => s.ensureFreshToken('viejo')))

    expect(res.every(r => r.status === 'rejected')).toBe(true)
    expect(redirecciones).toHaveLength(1)
    expect(mensajes.filter(m => m.type === 'logout')).toHaveLength(1)
  })

  test('todas las peticiones que esperaban reciben el rechazo', async () => {
    const { env } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => {
      await new Promise(r => setTimeout(r, 10))
      throw new Error('refresh inválido')
    })

    const res = await Promise.allSettled([s.ensureFreshToken('viejo'), s.ensureFreshToken('viejo')])
    expect(res.map(r => r.status)).toEqual(['rejected', 'rejected'])
  })

  test('limpia las credenciales pero conserva las preferencias de UI', async () => {
    const { env, store } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => { throw new Error('no') })

    await s.ensureFreshToken('viejo').catch(() => {})

    for (const k of AUTH_KEYS) expect(store.has(k)).toBe(false)
    expect(store.get('sish_ui')).toBe('{"tema":"oscuro"}')
  })

  test('conserva un returnUrl seguro', async () => {
    const { env, redirecciones } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => { throw new Error('no') })

    await s.ensureFreshToken('viejo').catch(() => {})

    expect(redirecciones[0]).toBe('/login?next=%2Fempleados%3Fpage%3D2')
  })

  test('sin refresh token, cierra sesión sin llamar al endpoint', async () => {
    const { env, redirecciones } = makeEnv({ access_token: 'viejo' })
    let llamadas = 0
    const s = createAuthSession(env, async () => { llamadas++; return { accessToken: 'x', refreshToken: 'y' } })

    await expect(s.ensureFreshToken('viejo')).rejects.toBeInstanceOf(SessionLostError)
    expect(llamadas).toBe(0)
    expect(redirecciones).toHaveLength(1)
  })

  test('una respuesta de refresh sin accessToken se trata como fallo', async () => {
    const { env, redirecciones } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({} as unknown as Tokens))

    await expect(s.ensureFreshToken('viejo')).rejects.toBeInstanceOf(SessionLostError)
    expect(redirecciones).toHaveLength(1)
  })

  test('con la sesión ya cerrada no se vuelve a intentar ni a redirigir', async () => {
    const { env, redirecciones } = makeEnv(sesionValida)
    let llamadas = 0
    const s = createAuthSession(env, async () => { llamadas++; throw new Error('no') })

    await s.ensureFreshToken('viejo').catch(() => {})
    await s.ensureFreshToken('viejo').catch(() => {})
    await s.ensureFreshToken('viejo').catch(() => {})

    expect(llamadas).toBe(1)
    expect(redirecciones).toHaveLength(1)
  })
})

describe('sin bucles', () => {
  test('el endpoint de refresh se reconoce en todas sus formas', () => {
    expect(isRefreshUrl('/api/auth/refresh')).toBe(true)
    expect(isRefreshUrl('/api/auth/refresh/')).toBe(true)
    expect(isRefreshUrl('https://sishoras/api/auth/refresh')).toBe(true)
    expect(isRefreshUrl('/api/auth/refresh?x=1')).toBe(true)
    expect(isRefreshUrl('/api/auth/login')).toBe(false)
    expect(isRefreshUrl('/api/employees')).toBe(false)
    expect(isRefreshUrl(undefined)).toBe(false)
  })

  test('bearerOf extrae el token de la cabecera', () => {
    expect(bearerOf('Bearer abc.def')).toBe('abc.def')
    expect(bearerOf('bearer abc')).toBe('abc')
    expect(bearerOf('Basic abc')).toBeNull()
    expect(bearerOf(undefined)).toBeNull()
  })
})

describe('returnUrl seguro', () => {
  test('acepta rutas internas', () => {
    expect(safeReturnUrl('/empleados')).toBe('/empleados')
    expect(safeReturnUrl('/reportes?mes=3')).toBe('/reportes?mes=3')
  })

  test('rechaza destinos externos', () => {
    expect(safeReturnUrl('//evil.com')).toBeNull()
    expect(safeReturnUrl('https://evil.com')).toBeNull()
    expect(safeReturnUrl('javascript:alert(1)')).toBeNull()
    expect(safeReturnUrl('/\\evil.com')).toBeNull()
  })

  test('no vuelve al propio login', () => {
    expect(safeReturnUrl('/login')).toBeNull()
    expect(loginUrlFor('/login')).toBe('/login')
  })

  test('vacío o nulo', () => {
    expect(safeReturnUrl('')).toBeNull()
    expect(safeReturnUrl(null)).toBeNull()
    expect(loginUrlFor(null)).toBe('/login')
  })
})

describe('múltiples pestañas', () => {
  test('el aviso de renovación no lleva tokens', async () => {
    const { env, mensajes } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({ accessToken: 'secreto123', refreshToken: 'secretoR' }))

    await s.ensureFreshToken('viejo')

    const json = JSON.stringify(mensajes)
    expect(json).not.toContain('secreto123')
    expect(json).not.toContain('secretoR')
    expect(mensajes[0].type).toBe('refreshed')
  })

  test('el logout de otra pestaña cierra ésta, sin reenviar el aviso', () => {
    const { env, mensajes, redirecciones, store } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({ accessToken: 'x', refreshToken: 'y' }))

    s.handleMessage({ type: 'logout', at: 1, reason: 'salida manual' })

    expect(redirecciones).toHaveLength(1)
    expect(store.has('access_token')).toBe(false)
    expect(mensajes).toHaveLength(0)          // sin eco entre pestañas
  })

  test('un mensaje basura no rompe nada', () => {
    const { env, redirecciones } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({ accessToken: 'x', refreshToken: 'y' }))

    s.handleMessage(null as unknown as AuthMessage)
    s.handleMessage({ type: 'refreshed', at: 1 })

    expect(redirecciones).toHaveLength(0)
  })

  test('el logout explícito avisa a las demás pestañas', () => {
    const { env, mensajes } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({ accessToken: 'x', refreshToken: 'y' }))

    s.logout('salida manual')

    expect(mensajes.filter(m => m.type === 'logout')).toHaveLength(1)
  })
})

describe('navegación durante el refresh', () => {
  test('una renovación en curso no bloquea el cierre de sesión', async () => {
    const { env, redirecciones } = makeEnv(sesionValida)
    let resolver: ((t: Tokens) => void) | null = null
    const s = createAuthSession(env, () => new Promise<Tokens>(res => { resolver = res }))

    const p = s.ensureFreshToken('viejo')
    expect(s.isRefreshing).toBe(true)

    s.logout('salida manual')                    // el usuario cierra sesión mientras tanto
    expect(s.isSessionLost).toBe(true)
    expect(redirecciones).toHaveLength(1)

    resolver!({ accessToken: 'tarde', refreshToken: 'tardeR' })
    await p.catch(() => {})
    expect(redirecciones).toHaveLength(1)        // no redirige dos veces
  })

  test('un refresh que llega TARDE no revive la sesión cerrada', async () => {
    const { env, store, mensajes } = makeEnv(sesionValida)
    let resolver: ((t: Tokens) => void) | null = null
    const s = createAuthSession(env, () => new Promise<Tokens>(res => { resolver = res }))

    const p = s.ensureFreshToken('viejo')
    s.logout('salida manual')                    // cierra mientras el refresh viaja
    resolver!({ accessToken: 'tarde', refreshToken: 'tardeR' })

    await expect(p).rejects.toBeInstanceOf(SessionLostError)
    // Lo crítico: no quedan credenciales vivas después del cierre.
    expect(store.has('access_token')).toBe(false)
    expect(store.has('refresh_token')).toBe(false)
    expect(mensajes.some(m => m.type === 'refreshed')).toBe(false)
  })

  test('tampoco revive si el cierre vino de otra pestaña', async () => {
    const { env, store } = makeEnv(sesionValida)
    let resolver: ((t: Tokens) => void) | null = null
    const s = createAuthSession(env, () => new Promise<Tokens>(res => { resolver = res }))

    const p = s.ensureFreshToken('viejo')
    s.handleMessage({ type: 'logout', at: 1, reason: 'otra pestaña' })
    resolver!({ accessToken: 'tarde', refreshToken: 'tardeR' })

    await expect(p).rejects.toBeInstanceOf(SessionLostError)
    expect(store.has('access_token')).toBe(false)
  })

  test('una petición que llega después del cierre no reabre la sesión', async () => {
    const { env } = makeEnv(sesionValida)
    const s = createAuthSession(env, async () => ({ accessToken: 'x', refreshToken: 'y' }))

    s.logout('salida manual')

    await expect(s.ensureFreshToken('viejo')).rejects.toBeInstanceOf(SessionLostError)
  })
})
