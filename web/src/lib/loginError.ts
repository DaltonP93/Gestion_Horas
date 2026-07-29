/**
 * loginError — mapea el resultado de POST /api/auth/login a un estado de UI.
 *
 * Distingue 401 (credenciales) de 429 (rate limit) y respeta Retry-After. NO
 * revela si el usuario existe: cualquier fallo de credenciales usa el mismo
 * mensaje genérico.
 */
export type LoginErrKind = 'credentials' | 'rate_limited' | 'twofa'

export interface LoginErrInfo {
  kind: LoginErrKind
  message: string
  retryAfterSec: number | null
}

export const CREDENTIALS_MSG = 'Usuario o contraseña incorrectos'
export const RATE_LIMITED_MSG = 'Demasiados intentos. Esperá antes de volver a intentar'

/** Parsea Retry-After: segundos (delta) o fecha HTTP → segundos restantes. */
export function parseRetryAfter(header?: string | number | null, now: number = Date.now()): number | null {
  if (header == null || header === '') return null
  const s = String(header).trim()
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10))
  const t = Date.parse(s)
  if (!isNaN(t)) return Math.max(0, Math.ceil((t - now) / 1000))
  return null
}

/** ¿La respuesta 200 indica que falta el 2FA? */
export function isTwofaRequired(data: any): boolean {
  return !!(data && data.twofaRequired)
}

/** ¿La respuesta 200 trae tokens (login exitoso)? */
export function hasAccessToken(data: any): boolean {
  return !!(data && data.accessToken)
}

/**
 * Deriva el estado de error a mostrar a partir del error de axios/fetch.
 * - 2FA requerido (viene como 200 con twofaRequired, o error con ese flag).
 * - 429 → rate limit + Retry-After.
 * - 401 y cualquier otro → mensaje genérico de credenciales (no revela usuario).
 */
export function loginError(err: any, now: number = Date.now()): LoginErrInfo {
  const status = err?.response?.status
  const data = err?.response?.data
  if (isTwofaRequired(data)) {
    return { kind: 'twofa', message: data.error || 'Código 2FA requerido', retryAfterSec: null }
  }
  if (status === 429) {
    const retryAfterSec = parseRetryAfter(err?.response?.headers?.['retry-after'], now)
    return { kind: 'rate_limited', message: RATE_LIMITED_MSG, retryAfterSec }
  }
  // 401 y demás: mismo mensaje genérico (no distingue usuario inexistente).
  return { kind: 'credentials', message: CREDENTIALS_MSG, retryAfterSec: null }
}
