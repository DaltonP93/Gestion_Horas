/**
 * authRefresh.ts
 * Renovación de sesión single-flight.
 *
 * Problema: cuando el access token expira, todas las peticiones en vuelo
 * reciben 401 a la vez y cada una disparaba su propio POST /api/auth/refresh.
 * En producción se veían refresh simultáneos con respuestas 200 y 401
 * mezcladas: el primero rota el refresh token y los demás llegan con uno ya
 * consumido, así que una sesión válida terminaba cerrada.
 *
 * Acá vive la lógica pura (sin axios y sin window) para poder probarla; el
 * cableado con el interceptor está en api.ts.
 */

export const REFRESH_PATH = '/api/auth/refresh'

/**
 * Endpoints públicos de auth: un 401 acá significa "credenciales inválidas",
 * no "sesión vencida". Renovar o cerrar sesión sobre ellos recargaría la
 * pantalla de login antes de que llegue a mostrar el error.
 */
export const PUBLIC_AUTH_PATHS = [
  '/api/auth/login',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
] as const

/** Claves de sesión. Se limpian sólo éstas: las preferencias de UI sobreviven. */
export const AUTH_KEYS = ['access_token', 'refresh_token', 'token', 'user'] as const

export const AUTH_CHANNEL = 'sishoras-auth'

export type Tokens = { accessToken: string; refreshToken: string }

/** Mensajes entre pestañas. Nunca llevan tokens: sólo avisan qué pasó. */
export type AuthMessage =
  | { type: 'refreshed'; at: number }
  | { type: 'logout'; at: number; reason: string }

export interface AuthEnv {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  broadcast(msg: AuthMessage): void
  redirect(url: string): void
  /** Ruta actual (pathname + search) para armar el returnUrl. */
  currentPath(): string
  now(): number
}

export class SessionLostError extends Error {
  reason: string
  constructor(reason: string) {
    super(`sesión terminada: ${reason}`)
    this.name = 'SessionLostError'
    this.reason = reason
  }
}

/** ¿La URL apunta al endpoint de refresh? Ese nunca se reintenta ni se refresca. */
export function isRefreshUrl(url?: string | null): boolean {
  return pathOf(url).endsWith(REFRESH_PATH)
}

function pathOf(url?: string | null): string {
  if (!url) return ''
  return url.split('?')[0].replace(/\/+$/, '')
}

/** ¿Es un endpoint donde el 401 es del formulario, no de la sesión? */
export function isPublicAuthUrl(url?: string | null): boolean {
  const path = pathOf(url)
  return !!path && PUBLIC_AUTH_PATHS.some(p => path.endsWith(p))
}

/**
 * Devuelve un `next` seguro para el login.
 * Rechaza absolutas, protocol-relative (`//evil.com`) y cualquier esquema:
 * sólo sobrevive una ruta interna.
 */
export function safeReturnUrl(path: string | null | undefined): string | null {
  if (!path) return null
  const p = path.trim()
  if (!p.startsWith('/')) return null
  if (p.startsWith('//')) return null
  if (/^\/\\/.test(p)) return null
  if (/[\x00-\x1f]/.test(p)) return null
  if (p.startsWith('/login')) return null
  return p
}

export function loginUrlFor(path: string | null | undefined): string {
  const next = safeReturnUrl(path)
  return next ? `/login?next=${encodeURIComponent(next)}` : '/login'
}

/** Token que llevaba una petición, para detectar si ya fue renovado. */
export function bearerOf(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}

export function createAuthSession(
  env: AuthEnv,
  doRefresh: (refreshToken: string) => Promise<Tokens>,
) {
  let inFlight: Promise<string> | null = null
  let sessionLost = false

  function clearCredentials() {
    for (const k of AUTH_KEYS) env.removeItem(k)
  }

  /**
   * Cierra la sesión una sola vez, aunque veinte peticiones fallen juntas.
   * `fromOtherTab` evita el eco: la pestaña que recibe el aviso no lo reenvía.
   */
  function logout(reason: string, fromOtherTab = false): void {
    if (sessionLost) return
    sessionLost = true
    inFlight = null
    clearCredentials()
    if (!fromOtherTab) env.broadcast({ type: 'logout', at: env.now(), reason })
    env.redirect(loginUrlFor(env.currentPath()))
  }

  /**
   * Garantiza un access token vigente.
   *
   * @param tokenUsed token que llevaba la petición que recibió 401. Si el
   *   guardado ya es otro, alguien (otra petición de esta pestaña u otra
   *   pestaña) renovó mientras tanto: se reusa y no se pide nada.
   */
  function ensureFreshToken(tokenUsed?: string | null): Promise<string> {
    if (sessionLost) return Promise.reject(new SessionLostError('sesión ya cerrada'))

    const current = env.getItem('access_token')
    if (current && tokenUsed && current !== tokenUsed) return Promise.resolve(current)

    // Ya hay una renovación en curso: todos esperan LA MISMA promesa.
    if (inFlight) return inFlight

    const refreshToken = env.getItem('refresh_token')
    if (!refreshToken) {
      // Sin refresh token pero CON access token había una sesión y se perdió:
      // corresponde cerrarla. Sin ninguno de los dos no había sesión que
      // cerrar — redirigir ahí recargaría el login encima del error del
      // formulario.
      if (current) logout('sin refresh token')
      return Promise.reject(new SessionLostError('sin refresh token'))
    }

    const run = doRefresh(refreshToken)
      .then((tokens) => {
        // La sesión pudo cerrarse MIENTRAS esta petición viajaba (botón salir,
        // o el aviso de otra pestaña). Guardar el token acá dejaría
        // credenciales vivas después de un cierre, y la petición original
        // seguiría autenticada.
        if (sessionLost) throw new SessionLostError('sesión cerrada durante la renovación')
        if (!tokens || !tokens.accessToken) throw new SessionLostError('respuesta de refresh inválida')
        env.setItem('access_token', tokens.accessToken)
        if (tokens.refreshToken) env.setItem('refresh_token', tokens.refreshToken)
        // Aviso sin token: las demás pestañas lo leen del storage compartido.
        env.broadcast({ type: 'refreshed', at: env.now() })
        return tokens.accessToken
      })
      .catch((err) => {
        // Fallo definitivo: se cierra una vez y TODOS los que esperaban
        // esta promesa reciben el rechazo.
        logout('refresh falló')
        throw err instanceof SessionLostError ? err : new SessionLostError('refresh falló')
      })
      .finally(() => { if (inFlight === run) inFlight = null })

    inFlight = run
    return run
  }

  /** Mensaje de otra pestaña. */
  function handleMessage(msg: AuthMessage): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'logout') logout(msg.reason || 'logout en otra pestaña', true)
  }

  /** Cierre explícito desde la UI (botón "salir"). */
  function logoutExplicit(reason = 'salida manual'): void {
    logout(reason)
  }

  /** Sólo para tests: vuelve al estado inicial. */
  function reset(): void {
    inFlight = null
    sessionLost = false
  }

  return {
    ensureFreshToken,
    handleMessage,
    logout: logoutExplicit,
    clearCredentials,
    reset,
    get isRefreshing() { return inFlight !== null },
    get isSessionLost() { return sessionLost },
  }
}

export type AuthSession = ReturnType<typeof createAuthSession>

/** Entorno real del navegador. En SSR devuelve un stub inerte. */
export function browserAuthEnv(): AuthEnv {
  const hasWindow = typeof window !== 'undefined'
  let channel: BroadcastChannel | null = null
  if (hasWindow && typeof BroadcastChannel !== 'undefined') {
    try { channel = new BroadcastChannel(AUTH_CHANNEL) } catch { channel = null }
  }
  return {
    getItem: (k) => (hasWindow ? window.localStorage.getItem(k) : null),
    setItem: (k, v) => { if (hasWindow) window.localStorage.setItem(k, v) },
    removeItem: (k) => { if (hasWindow) window.localStorage.removeItem(k) },
    broadcast: (msg) => { try { channel?.postMessage(msg) } catch { /* canal cerrado */ } },
    redirect: (url) => { if (hasWindow) window.location.href = url },
    currentPath: () => (hasWindow ? `${window.location.pathname}${window.location.search}` : ''),
    now: () => Date.now(),
  }
}

/** Suscribe la sesión al canal entre pestañas. Devuelve el desuscriptor. */
export function listenAuthChannel(session: AuthSession): () => void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return () => {}
  let channel: BroadcastChannel
  try { channel = new BroadcastChannel(AUTH_CHANNEL) } catch { return () => {} }
  const onMessage = (ev: MessageEvent) => session.handleMessage(ev.data as AuthMessage)
  channel.addEventListener('message', onMessage)
  return () => {
    channel.removeEventListener('message', onMessage)
    try { channel.close() } catch { /* ya cerrado */ }
  }
}
