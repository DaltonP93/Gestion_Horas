import axios from 'axios'
import {
  createAuthSession, browserAuthEnv, listenAuthChannel,
  isRefreshUrl, bearerOf, REFRESH_PATH,
} from './authRefresh'

// Normaliza la URL del API:
// - quita trailing slash y trailing /api (las rutas ya empiezan con /api)
// - si la página corre en https, fuerza https en la base (evita mixed-content)
// - en producción detrás de nginx, dejá NEXT_PUBLIC_API_URL='' y se usa el mismo origen
function normalizeApiUrl(raw?: string): string {
  let u = (raw || '').trim()
  if (!u) return '' // mismo origen — funciona con nginx proxy /api/* → :4000
  u = u.replace(/\/+$/, '').replace(/\/api$/i, '')
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && u.startsWith('http://')) {
    u = 'https://' + u.slice('http://'.length)
  }
  return u
}

const API_URL       = normalizeApiUrl(process.env.NEXT_PUBLIC_API_URL)
const ANALYTICS_URL = normalizeApiUrl(process.env.NEXT_PUBLIC_ANALYTICS_URL) || 'http://localhost:5000'

// Helper para componentes que usan fetch() crudo en lugar de axios.
// Devuelve la URL absoluta correctamente formada para un path tipo "/api/...".
export function apiUrl(path: string = ''): string {
  const p = path.startsWith('/') ? path : '/' + path
  return `${API_URL}${p}`
}

// Helper para descargas via window.open() o <a href>.
// Como window.open no permite agregar headers, anexa el JWT como ?access_token=.
// Combina con query params adicionales si se pasan.
export function downloadUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const base = apiUrl(path)
  const sp = new URLSearchParams()
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) sp.set(k, String(v))
  }
  if (typeof window !== 'undefined') {
    const t = localStorage.getItem('access_token')
    if (t) sp.set('access_token', t)
  }
  const qs = sp.toString()
  return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base
}

export const api = axios.create({ baseURL: API_URL })
export const analyticsApi = axios.create({ baseURL: ANALYTICS_URL })

// Interceptor: agregar token JWT automáticamente
api.interceptors.request.use(config => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Cliente sin interceptores para el refresh. Usar `api` acá era un camino a
// la recursión: un 401 del propio refresh volvía a entrar al interceptor.
// Se exporta sólo para que los tests puedan inyectarle un adaptador.
export const refreshClient = axios.create({ baseURL: API_URL })

export const authSession = createAuthSession(
  browserAuthEnv(),
  async (refreshToken: string) => {
    const { data } = await refreshClient.post(REFRESH_PATH, { refreshToken })
    return { accessToken: data.accessToken, refreshToken: data.refreshToken }
  },
)

// Escucha el canal entre pestañas: si otra cierra sesión, ésta la sigue.
if (typeof window !== 'undefined') listenAuthChannel(authSession)

// Interceptor: refrescar token si expira.
// Como máximo UNA renovación en curso por pestaña; las demás peticiones
// esperan esa misma promesa y se reintentan una sola vez.
api.interceptors.response.use(
  res => res,
  async error => {
    const original = error.config
    if (!original || error.response?.status !== 401) return Promise.reject(error)

    // Un 401 del endpoint de refresh es terminal: no se refresca ni se reintenta.
    if (isRefreshUrl(original.url)) {
      authSession.logout('refresh devolvió 401')
      return Promise.reject(error)
    }

    if (original._retry) return Promise.reject(error)   // un solo reintento
    original._retry = true

    try {
      const token = await authSession.ensureFreshToken(bearerOf(original.headers?.Authorization))
      original.headers = { ...(original.headers || {}), Authorization: `Bearer ${token}` }
      return await api(original)
    } catch {
      // La sesión ya se cerró (una sola vez) dentro de ensureFreshToken.
      return Promise.reject(error)
    }
  }
)

// ─── Auth ─────────────────────────────────────────────────────────
export const authApi = {
  login: (username: string, password: string, otp?: string) =>
    api.post('/api/auth/login', { username, password, otp }).then(r => r.data),
  me: () => api.get('/api/auth/me').then(r => r.data),
  logout: (refreshToken: string) =>
    api.post('/api/auth/logout', { refreshToken }),
  forgotPassword: (email: string) =>
    api.post('/api/auth/password/forgot', { email }).then(r => r.data),
  resetPassword: (token: string, newPassword: string) =>
    api.post('/api/auth/password/reset', { token, newPassword }).then(r => r.data),
}

// ─── Empleados ────────────────────────────────────────────────────
export const employeesApi = {
  list: (params?: object) => api.get('/api/employees', { params }).then(r => r.data),
  get: (id: number)       => api.get(`/api/employees/${id}`).then(r => r.data),
  create: (data: object)  => api.post('/api/employees', data).then(r => r.data),
  update: (id: number, data: object) => api.put(`/api/employees/${id}`, data).then(r => r.data),
  // Edición inline campo a campo. `value` puede ser null/'' para limpiar.
  quickUpdate: (id: number, field: string, value: unknown) =>
    api.patch(`/api/employees/${id}/quick`, { field, value }).then(r => r.data),
  history: (id: number, params?: object) =>
    api.get(`/api/employees/${id}/attendance`, { params }).then(r => r.data),
}

// ─── Asistencia ───────────────────────────────────────────────────
export const attendanceApi = {
  live: ()              => api.get('/api/attendance/live').then(r => r.data),
  byDate: (params: object) => api.get('/api/attendance', { params }).then(r => r.data),
  registerManual: (data: object) => api.post('/api/attendance/manual', data).then(r => r.data),
}

// ─── Reportes (Analytics vía BFF proxy del core) ─────────────────
// El navegador consume /api/analytics/* del core (con JWT); el core añade
// la API key de Analytics del lado servidor. La clave ya NO viaja al browser.
export const reportsApi = {
  monthly: (year: number, month: number, deptId?: number) =>
    api.get('/api/analytics/reports/monthly', {
      params: { year, month, dept_id: deptId }
    }).then(r => r.data),
  daily: (date?: string, deptId?: number) =>
    api.get('/api/analytics/reports/daily', {
      params: { report_date: date, dept_id: deptId }
    }).then(r => r.data),
  kpis: () =>
    api.get('/api/analytics/reports/dashboard-kpis').then(r => r.data),
  exportExcel: (type: string, year: number, month: number) => {
    // Descarga vía el proxy del core con el JWT en query (flujo window.open)
    const token = typeof window !== 'undefined'
      ? (localStorage.getItem('access_token') || localStorage.getItem('token'))
      : null
    const url = apiUrl(`/api/analytics/reports/export/excel?report_type=${type}&year=${year}&month=${month}&access_token=${token || ''}`)
    window.open(url, '_blank')
  }
}
