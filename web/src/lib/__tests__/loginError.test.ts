import {
  loginError, parseRetryAfter, isTwofaRequired, hasAccessToken,
  CREDENTIALS_MSG, RATE_LIMITED_MSG,
} from '../loginError'

// Errores estilo axios.
const axiosErr = (status: number, data: any = {}, headers: any = {}) =>
  ({ response: { status, data, headers } })

describe('parseRetryAfter', () => {
  test('segundos (delta) → número', () => {
    expect(parseRetryAfter('45')).toBe(45)
    expect(parseRetryAfter(30)).toBe(30)
  })
  test('fecha HTTP → segundos restantes', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const future = new Date(now + 90_000).toUTCString()
    expect(parseRetryAfter(future, now)).toBe(90)
  })
  test('fecha pasada → 0 (no negativo)', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const past = new Date(now - 5000).toUTCString()
    expect(parseRetryAfter(past, now)).toBe(0)
  })
  test('ausente o inválido → null', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('mañana')).toBeNull()
  })
})

describe('éxito (200)', () => {
  test('hasAccessToken distingue login exitoso', () => {
    expect(hasAccessToken({ accessToken: 'x', refreshToken: 'y', user: {} })).toBe(true)
    expect(hasAccessToken({})).toBe(false)
    expect(hasAccessToken(null)).toBe(false)
  })
  test('isTwofaRequired detecta el paso 2FA (200 con flag)', () => {
    expect(isTwofaRequired({ twofaRequired: true })).toBe(true)
    expect(isTwofaRequired({ accessToken: 'x' })).toBe(false)
  })
})

describe('loginError — 401 (credenciales)', () => {
  test('401 → mensaje genérico', () => {
    const info = loginError(axiosErr(401, { error: 'Credenciales inválidas' }))
    expect(info.kind).toBe('credentials')
    expect(info.message).toBe(CREDENTIALS_MSG)
    expect(info.retryAfterSec).toBeNull()
  })
  test('NO revela si el usuario existe: usuario inexistente vs. contraseña mala → mismo mensaje', () => {
    const a = loginError(axiosErr(401, { error: 'Usuario no encontrado' }))
    const b = loginError(axiosErr(401, { error: 'Contraseña incorrecta' }))
    expect(a.message).toBe(b.message)
    expect(a.message).toBe(CREDENTIALS_MSG)
  })
  test('error de red (sin response) → credenciales genérico', () => {
    expect(loginError(new Error('Network Error')).message).toBe(CREDENTIALS_MSG)
  })
})

describe('loginError — 429 (rate limit)', () => {
  test('429 → mensaje distinto + kind rate_limited', () => {
    const info = loginError(axiosErr(429, { error: 'Demasiados intentos de login.' }, { 'retry-after': '60' }))
    expect(info.kind).toBe('rate_limited')
    expect(info.message).toBe(RATE_LIMITED_MSG)
    expect(info.message).not.toBe(CREDENTIALS_MSG)
    expect(info.retryAfterSec).toBe(60)
  })
  test('429 respeta Retry-After como fecha HTTP', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const future = new Date(now + 120_000).toUTCString()
    const info = loginError(axiosErr(429, {}, { 'retry-after': future }), now)
    expect(info.retryAfterSec).toBe(120)
  })
  test('429 sin Retry-After → retryAfterSec null', () => {
    expect(loginError(axiosErr(429, {})).retryAfterSec).toBeNull()
  })
})

describe('loginError — 2FA', () => {
  test('error con twofaRequired → kind twofa', () => {
    const info = loginError(axiosErr(401, { twofaRequired: true, error: 'Código 2FA requerido' }))
    expect(info.kind).toBe('twofa')
    expect(info.message).toBe('Código 2FA requerido')
  })
})
