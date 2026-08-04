/**
 * @jest-environment jsdom
 *
 * El interceptor de respuesta end-to-end: 401 → una renovación → reintento.
 * Complementa authRefresh.test.ts, que cubre la lógica pura.
 */
import type { AxiosAdapter, AxiosRequestConfig } from 'axios'

/**
 * Los tipos de axios exigen un AxiosResponse completo (headers como
 * AxiosHeaders, no un objeto plano). Para un adaptador de prueba eso es ruido:
 * se construye la respuesta a mano y se adapta el tipo en un solo lugar.
 */
type FakeAdapter = (config: AxiosRequestConfig) => Promise<unknown>
const asAdapter = (fn: FakeAdapter): AxiosAdapter => fn as unknown as AxiosAdapter
const respuesta = (config: AxiosRequestConfig, status: number, data: unknown) =>
  ({ data, status, statusText: 'OK', headers: {}, config })
const fallo = (config: AxiosRequestConfig, status: number, msg: string) =>
  Object.assign(new Error(msg), {
    config, response: { status, data: {}, config, headers: {}, statusText: msg },
  })

type Llamada = { url: string; auth?: string }

let llamadas: Llamada[]
let refrescos: number
let respuestaRefresh: 'ok' | '401'
let tokenActual: string

/** Adaptador falso: 401 mientras el token sea el viejo, 200 con el nuevo. */
const adaptadorApi = asAdapter((config) => {
  const auth = (config.headers?.Authorization ?? config.headers?.authorization) as string | undefined
  llamadas.push({ url: config.url || '', auth })

  if (config.signal?.aborted) {
    return Promise.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', config }))
  }
  const token = (auth || '').replace(/^Bearer\s+/i, '')
  if (token !== tokenActual) return Promise.reject(fallo(config, 401, 'Unauthorized'))
  return Promise.resolve(respuesta(config, 200, { ok: true, url: config.url }))
})

const adaptadorRefresh = asAdapter((config) => {
  refrescos++
  if (respuestaRefresh === '401') return Promise.reject(fallo(config, 401, 'Unauthorized'))
  tokenActual = 'nuevo'
  return Promise.resolve(respuesta(config, 200, { accessToken: 'nuevo', refreshToken: 'r2' }))
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { api, refreshClient, authSession } = require('../api') as typeof import('../api')

beforeEach(() => {
  llamadas = []
  refrescos = 0
  respuestaRefresh = 'ok'
  tokenActual = 'nuevo'                       // el servidor ya rotó: 'viejo' da 401
  localStorage.clear()
  localStorage.setItem('access_token', 'viejo')
  localStorage.setItem('refresh_token', 'r1')
  localStorage.setItem('sish_ui', '{"tema":"oscuro"}')
  api.defaults.adapter = adaptadorApi
  refreshClient.defaults.adapter = adaptadorRefresh
  authSession.reset()
  // jsdom no permite navegar de verdad; alcanza con que no explote.
  delete (window as unknown as Record<string, unknown>).location
  ;(window as unknown as Record<string, unknown>).location = { href: '', pathname: '/empleados', search: '' }
})

describe('401 concurrentes', () => {
  test('cinco peticiones en paralelo generan UN solo refresh y las cinco terminan bien', async () => {
    const res = await Promise.all([
      api.get('/api/employees'),
      api.get('/api/attendance'),
      api.get('/api/departments'),
      api.get('/api/permissions'),
      api.get('/api/devices'),
    ])

    expect(refrescos).toBe(1)
    expect(res.map(r => r.status)).toEqual([200, 200, 200, 200, 200])
  })

  test('los reintentos llevan el token nuevo', async () => {
    await api.get('/api/employees')

    const aEmpleados = llamadas.filter(l => l.url === '/api/employees')
    expect(aEmpleados).toHaveLength(2)                     // original + reintento
    expect(aEmpleados[0].auth).toBe('Bearer viejo')
    expect(aEmpleados[1].auth).toBe('Bearer nuevo')
  })

  test('cada petición se reintenta una sola vez', async () => {
    // El refresh "funciona" pero devuelve un token que el servidor sigue
    // rechazando: sin el tope, esto sería un bucle.
    refreshClient.defaults.adapter = asAdapter((config) => {
      refrescos++
      return Promise.resolve(respuesta(config, 200, { accessToken: 'tampoco', refreshToken: 'r2' }))
    })

    await expect(api.get('/api/employees')).rejects.toMatchObject({ response: { status: 401 } })

    expect(llamadas.filter(l => l.url === '/api/employees')).toHaveLength(2)
    expect(refrescos).toBe(1)
  })
})

describe('refresh que falla', () => {
  test('un 401 del refresh cierra la sesión y rechaza todo', async () => {
    respuestaRefresh = '401'

    const res = await Promise.allSettled([api.get('/api/employees'), api.get('/api/attendance')])

    expect(res.every(r => r.status === 'rejected')).toBe(true)
    expect(refrescos).toBe(1)
    expect(authSession.isSessionLost).toBe(true)
    expect(window.location.href).toBe('/login?next=%2Fempleados')
  })

  test('borra las credenciales y conserva las preferencias', async () => {
    respuestaRefresh = '401'
    await api.get('/api/employees').catch(() => {})

    expect(localStorage.getItem('access_token')).toBeNull()
    expect(localStorage.getItem('refresh_token')).toBeNull()
    expect(localStorage.getItem('sish_ui')).toBe('{"tema":"oscuro"}')
  })

  test('el endpoint de refresh nunca se reintenta a sí mismo', async () => {
    respuestaRefresh = '401'
    await api.get('/api/employees').catch(() => {})

    // Una sola llamada al refresh, y ninguna vía el cliente con interceptores.
    expect(refrescos).toBe(1)
    expect(llamadas.some(l => l.url.includes('/api/auth/refresh'))).toBe(false)
  })
})

describe('casos que no deben disparar refresh', () => {
  test('una petición cancelada no renueva nada', async () => {
    const ac = new AbortController()
    ac.abort()

    await expect(api.get('/api/employees', { signal: ac.signal })).rejects.toMatchObject({ code: 'ERR_CANCELED' })
    expect(refrescos).toBe(0)
  })

  test('un 500 no dispara refresh', async () => {
    api.defaults.adapter = asAdapter((config) => Promise.reject(fallo(config, 500, 'Error')))

    await expect(api.get('/api/employees')).rejects.toMatchObject({ response: { status: 500 } })
    expect(refrescos).toBe(0)
  })

  test('un 403 tampoco', async () => {
    api.defaults.adapter = asAdapter((config) => Promise.reject(fallo(config, 403, 'Forbidden')))

    await expect(api.get('/api/employees')).rejects.toMatchObject({ response: { status: 403 } })
    expect(refrescos).toBe(0)
  })
})

// ── Segunda tanda de Codex ──────────────────────────────────────
describe('401 del formulario de login', () => {
  test('un login con credenciales malas no cierra sesión ni redirige', async () => {
    localStorage.clear()                          // no había sesión
    api.defaults.adapter = asAdapter((config) => Promise.reject(fallo(config, 401, 'Unauthorized')))

    await expect(api.post('/api/auth/login', { username: 'x', password: 'mal' }))
      .rejects.toMatchObject({ response: { status: 401 } })

    expect(refrescos).toBe(0)
    expect(window.location.href).toBe('')         // la pantalla de login sigue en pie
    expect(authSession.isSessionLost).toBe(false)
  })

  test('recuperación de contraseña tampoco', async () => {
    localStorage.clear()
    api.defaults.adapter = asAdapter((config) => Promise.reject(fallo(config, 401, 'Unauthorized')))

    await expect(api.post('/api/auth/password/forgot', { email: 'x@y.com' })).rejects.toBeDefined()
    expect(window.location.href).toBe('')
  })

  test('un 401 sin ninguna credencial guardada no redirige', async () => {
    localStorage.clear()
    await expect(api.get('/api/employees')).rejects.toMatchObject({ response: { status: 401 } })

    expect(refrescos).toBe(0)
    expect(window.location.href).toBe('')
  })

  test('pero con access token y sin refresh token SÍ cierra la sesión', async () => {
    localStorage.clear()
    localStorage.setItem('access_token', 'viejo')   // había sesión, se perdió el refresh
    await expect(api.get('/api/employees')).rejects.toBeDefined()

    expect(window.location.href).toContain('/login')
  })
})

describe('el error del reintento no queda tapado', () => {
  test('un 403 después de renovar llega como 403, no como el 401 viejo', async () => {
    let primera = true
    api.defaults.adapter = asAdapter((config) => {
      if (primera) { primera = false; return Promise.reject(fallo(config, 401, 'Unauthorized')) }
      return Promise.reject(fallo(config, 403, 'Forbidden'))
    })

    await expect(api.get('/api/employees')).rejects.toMatchObject({ response: { status: 403 } })
    expect(refrescos).toBe(1)
  })

  test('un 500 en el reintento llega como 500', async () => {
    let primera = true
    api.defaults.adapter = asAdapter((config) => {
      if (primera) { primera = false; return Promise.reject(fallo(config, 401, 'Unauthorized')) }
      return Promise.reject(fallo(config, 500, 'Error'))
    })

    await expect(api.get('/api/employees')).rejects.toMatchObject({ response: { status: 500 } })
  })

  test('una cancelación en el reintento llega como cancelación', async () => {
    let primera = true
    api.defaults.adapter = asAdapter((config) => {
      if (primera) { primera = false; return Promise.reject(fallo(config, 401, 'Unauthorized')) }
      return Promise.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', config }))
    })

    await expect(api.get('/api/employees')).rejects.toMatchObject({ code: 'ERR_CANCELED' })
  })
})
