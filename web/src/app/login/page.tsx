'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Lock, User, Clock as ClockIcon, Shield } from 'lucide-react'
import Link from 'next/link'
import { authApi, apiUrl } from '@/lib/api'
import { landingFor } from '@/lib/useCurrentUser'

interface SiteSettings {
  system_name: string
  system_company: string
  system_logo_url: string
  system_login_bg: string
  system_login_bg_image: string
  system_primary_color: string
  system_secondary_color: string
  system_login_title: string
  system_login_subtitle: string
  system_login_layout: 'center' | 'left' | 'right' | 'split'
  system_login_show_datetime: string
  system_login_glass: string
  system_login_footer: string
  system_locale: string
  system_time_format: '24h' | '12h'
}

const DEFAULT: SiteSettings = {
  system_name: 'Sistema de Asistencia',
  system_company: '',
  system_logo_url: '',
  system_login_bg: 'from-slate-900 to-blue-900',
  system_login_bg_image: '',
  system_primary_color: '#2563eb',
  system_secondary_color: '#1e40af',
  system_login_title: 'Sistema de Asistencia',
  system_login_subtitle: 'Recursos Humanos',
  system_login_layout: 'center',
  system_login_show_datetime: '1',
  system_login_glass: '1',
  system_login_footer: '',
  system_locale: 'es-PY',
  system_time_format: '24h',
}

// Inicializa null en SSR para evitar hydration mismatch (React #418/#423/#425).
// Se setea recién al montar en cliente.
function useNow(enabled: boolean): Date | null {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    if (!enabled) return
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [enabled])
  return now
}

export default function LoginPage() {
  const router = useRouter()
  const [form, setForm] = useState({ username: '', password: '' })
  const [otp, setOtp] = useState('')
  const [needsOtp, setNeedsOtp] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [settings, setSettings] = useState<SiteSettings>(DEFAULT)

  useEffect(() => {
    fetch(apiUrl('/api/settings'))
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setSettings(s => ({ ...s, ...data })) })
      .catch(() => {})
  }, [])

  const showClock = settings.system_login_show_datetime === '1'
  const glass     = settings.system_login_glass === '1'
  const now       = useNow(showClock)

  const datetimeStr = useMemo(() => {
    if (!now) return ''
    try {
      const opts: Intl.DateTimeFormatOptions = {
        dateStyle: 'full',
        timeStyle: 'medium',
        hour12: settings.system_time_format === '12h',
      }
      return new Intl.DateTimeFormat(settings.system_locale || 'es-PY', opts).format(now)
    } catch {
      return now.toLocaleString()
    }
  }, [now, settings.system_locale, settings.system_time_format])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await authApi.login(form.username, form.password, needsOtp ? otp : undefined)

      // Backend indica que se necesita 2FA
      if (data?.twofaRequired) {
        setNeedsOtp(true)
        if (needsOtp) setError('Código 2FA incorrecto')
        return
      }
      localStorage.setItem('access_token', data.accessToken)
      localStorage.setItem('refresh_token', data.refreshToken)
      localStorage.setItem('user', JSON.stringify(data.user))
      router.push(landingFor(data.user.role))
    } catch (e: any) {
      if (e?.response?.data?.twofaRequired) {
        setNeedsOtp(true)
        setError(e.response.data.error || 'Código 2FA requerido')
      } else {
        setError('Usuario o contraseña incorrectos')
      }
    } finally {
      setLoading(false)
    }
  }

  // Fondo: imagen local > gradient class
  const bgImage = settings.system_login_bg_image
    ? (settings.system_login_bg_image.startsWith('http')
        ? settings.system_login_bg_image
        : apiUrl(settings.system_login_bg_image))
    : ''

  // Vidrio líquido cuando el admin activa "glass"; opaco si lo desactiva.
  const cardClass = glass
    ? 'glass lift'
    : 'bg-white'

  // Layout
  const wrapperAlign =
    settings.system_login_layout === 'left'  ? 'justify-start pl-8 md:pl-20' :
    settings.system_login_layout === 'right' ? 'justify-end pr-8 md:pr-20' :
                                               'justify-center'

  return (
    <div
      className={`relative min-h-screen flex items-center ${wrapperAlign} p-4 overflow-hidden ${!bgImage ? `bg-gradient-to-br ${settings.system_login_bg}` : ''}`}
      style={bgImage ? {
        backgroundImage: `url("${bgImage}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      } : undefined}
    >
      {/* overlay cuando hay imagen */}
      {bgImage && (
        <div className="absolute inset-0 bg-gradient-to-br from-black/40 via-black/20 to-black/50 pointer-events-none" />
      )}

      {/* Orbes ambientales Futurista (solo sobre el fondo por defecto, sin imagen) */}
      {!bgImage && (
        <>
          <div className="absolute -top-[20%] left-[30%] w-[600px] h-[600px] rounded-full pointer-events-none"
               style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.12), transparent 65%)' }} />
          <div className="absolute -bottom-[30%] -right-[10%] w-[700px] h-[700px] rounded-full pointer-events-none"
               style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.10), transparent 65%)' }} />
        </>
      )}

      {/* Reloj flotante (esquina) */}
      {showClock && (
        <div className="hidden md:flex absolute top-6 right-8 items-center gap-2 text-white bg-black/60 backdrop-blur px-4 py-2 rounded-xl z-10"
             aria-live="off">
          <ClockIcon size={16} aria-hidden="true" />
          <span className="text-sm font-medium tracking-wide" suppressHydrationWarning>{datetimeStr || ' '}</span>
        </div>
      )}

      <div className={`relative z-10 rounded-3xl shadow-2xl p-8 w-full max-w-md ${cardClass}`}>
        <div className="text-center mb-8">
          {settings.system_logo_url ? (
            <img
              src={settings.system_logo_url.startsWith('http') ? settings.system_logo_url : apiUrl(settings.system_logo_url)}
              alt={settings.system_name}
              className="h-16 mx-auto mb-4 object-contain"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg"
              style={{
                background: `linear-gradient(135deg, ${settings.system_primary_color}, ${settings.system_secondary_color})`,
              }}
            >
              <ClockIcon className="text-white" size={28} />
            </div>
          )}
          <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">{settings.system_login_title}</h1>
          <p className="text-slate-500 text-sm mt-1">{settings.system_login_subtitle}</p>
          {showClock && (
            <p className="md:hidden text-xs text-slate-400 mt-3" suppressHydrationWarning>{datetimeStr || ' '}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-username" className="block text-sm font-medium text-slate-700 mb-1">Usuario</label>
            <div className="relative">
              <User size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                id="login-username"
                type="text"
                required
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                aria-invalid={!!error}
                className="w-full border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2"
                style={{ '--tw-ring-color': settings.system_primary_color } as any}
                placeholder="usuario o email"
                autoComplete="username"
              />
            </div>
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-1">Contraseña</label>
            <div className="relative">
              <Lock size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                id="login-password"
                type="password"
                required
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                aria-invalid={!!error}
                className="w-full border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2"
                style={{ '--tw-ring-color': settings.system_primary_color } as any}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
          </div>

          {needsOtp && (
            <div className="space-y-2">
              <label htmlFor="login-otp" className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-2">
                <Shield size={14} aria-hidden="true" /> Código de autenticación 2FA
              </label>
              <div className="relative">
                <input
                  id="login-otp"
                  type="text"
                  required
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  aria-describedby="otp-hint"
                  aria-invalid={!!error}
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 text-lg tracking-[0.4em] text-center font-mono focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': settings.system_primary_color } as any}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  autoFocus
                />
              </div>
              <p id="otp-hint" className="text-xs text-slate-500">
                Ingresá el código de 6 dígitos de tu app (Google Authenticator / Authy).
              </p>
            </div>
          )}

          {error && (
            <div role="alert" aria-live="assertive"
                 className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full text-white font-semibold py-3 rounded-xl transition-all hover:brightness-110 hover:shadow-lg disabled:opacity-60"
            style={{
              background: `linear-gradient(135deg, ${settings.system_primary_color}, ${settings.system_secondary_color})`,
            }}
          >
            {loading ? 'Iniciando sesión...' : needsOtp ? 'Verificar código' : 'Iniciar sesión'}
          </button>

          {!needsOtp && (
            <div className="text-center">
              <Link href="/forgot-password" className="text-xs text-slate-500 hover:text-slate-700 hover:underline">
                ¿Olvidaste tu contraseña?
              </Link>
            </div>
          )}
        </form>

        {settings.system_login_footer && (
          <p className="text-center text-xs text-slate-400 mt-6">{settings.system_login_footer}</p>
        )}
        {settings.system_company && (
          <p className="text-center text-xs text-slate-400 mt-2">© {new Date().getFullYear()} {settings.system_company}</p>
        )}
      </div>
    </div>
  )
}
