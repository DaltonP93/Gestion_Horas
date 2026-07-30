'use client'
import { useEffect, useRef, useState, Suspense } from 'react'
import {
  ShieldCheck, Lock, Smartphone, Copy, CheckCircle, AlertCircle, KeyRound, X,
  Monitor, LogOut, Clock,
} from 'lucide-react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { api } from '@/lib/api'
import {
  parseSecuritySection,
  securitySectionHref,
  DEFAULT_SECURITY_SECTION,
  type SecuritySection,
} from '@/lib/accountSection'

// ── Focus trap para modales (foco cicla, restaura al cerrar, Esc cierra) ──
function useFocusTrap(active: boolean, onEscape: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active || !ref.current) return
    const container = ref.current
    const prev = document.activeElement as HTMLElement | null
    const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(selector))
    focusables()[0]?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onEscape(); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const firstEl = items[0], lastEl = items[items.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus() }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [active, onEscape])
  return ref
}

let QRCodeComp: any = null
try { QRCodeComp = require('qrcode.react').QRCodeSVG } catch {}

interface Session { id: number; ip_address?: string | null; user_agent?: string | null; created_at?: string; last_used_at?: string | null; is_current?: boolean }
interface SecurityData {
  last_login: string | null
  password_changed_at: string | null
  twofa: { enabled: boolean; enabledAt: string | null }
  sessions: Session[]
  sessions_count: number
}

const TAB_META: Record<SecuritySection, { label: string; icon: typeof Lock }> = {
  password: { label: 'Contraseña',                    icon: Lock },
  sessions: { label: 'Sesiones activas',              icon: Monitor },
  '2fa':    { label: 'Verificación en dos pasos',     icon: Smartphone },
}
const TAB_ORDER: SecuritySection[] = ['password', 'sessions', '2fa']

// El uso de `useSearchParams` obliga a envolver el árbol en <Suspense>
// para que Next 14 no falle el pre-render estático de la ruta.
export default function SeguridadCuentaPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400 dark:text-white/40">Cargando…</div>}>
      <SeguridadCuentaInner />
    </Suspense>
  )
}

function SeguridadCuentaInner() {
  const [data, setData] = useState<SecurityData | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg]     = useState('')

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Sección activa: query param canónico. Si llega el hash legado
  // (#password / #password#password) se normaliza y se reemplaza la URL
  // para que las URLs compartidas queden limpias.
  const [section, setSection] = useState<SecuritySection>(DEFAULT_SECURITY_SECTION)
  useEffect(() => {
    const qsSection = searchParams?.get('section') || ''
    const fromUrl = qsSection
      ? parseSecuritySection('?section=' + qsSection)
      : (typeof window !== 'undefined' ? parseSecuritySection(window.location.href) : DEFAULT_SECURITY_SECTION)
    setSection(fromUrl)

    // Si vino por hash o venía sin query, normalizamos a query param.
    if (typeof window !== 'undefined' && !qsSection) {
      const target = securitySectionHref(fromUrl)
      const currentHref = window.location.pathname + window.location.search + window.location.hash
      if (currentHref !== target) router.replace(target)
    }
  }, [searchParams, router])

  function goSection(s: SecuritySection) {
    setSection(s)
    router.replace(`${pathname}?section=${s}`)
  }

  async function load() {
    try {
      const refresh = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null
      const { data } = await api.get('/api/me/security', {
        headers: refresh ? { 'X-Current-Refresh': refresh } : {},
      })
      setData(data)
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
  }
  useEffect(() => { load() }, [])

  // Foco automático al abrir "Contraseña".
  useEffect(() => {
    if (section !== 'password') return
    const t = setTimeout(() => document.getElementById('current-password')?.focus(), 250)
    return () => clearTimeout(t)
  }, [section])

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center">
          <ShieldCheck className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Seguridad de mi cuenta</h1>
          <p className="text-slate-500 text-sm dark:text-white/60">Contraseña, sesiones activas y verificación en dos pasos.</p>
        </div>
      </header>

      {/* Tabs de navegación interna */}
      <nav
        role="tablist"
        aria-label="Secciones de seguridad"
        className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-white/10"
      >
        {TAB_ORDER.map(s => {
          const meta = TAB_META[s]
          const active = section === s
          const Icon = meta.icon
          return (
            <button
              key={s}
              role="tab"
              aria-selected={active}
              aria-controls={`section-${s}`}
              id={`tab-${s}`}
              onClick={() => goSection(s)}
              className={
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ' +
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-t ' +
                (active
                  ? 'border-blue-600 text-blue-700 dark:text-blue-300 dark:border-blue-400'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300 dark:text-white/60 dark:hover:text-white dark:hover:border-white/20')
              }
            >
              <Icon size={15} aria-hidden="true" />
              {meta.label}
            </button>
          )
        })}
      </nav>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 dark:bg-red-500/10 dark:border-red-500/30"><AlertCircle className="text-red-600 dark:text-red-300 shrink-0 mt-0.5" size={20} /><div className="text-sm text-red-900 dark:text-red-200">{error}</div></div>}
      {msg && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-2 text-sm text-emerald-900 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-200"><CheckCircle size={16} /> {msg}</div>}

      <div role="tabpanel" id="section-password" aria-labelledby="tab-password" hidden={section !== 'password'}>
        {section === 'password' && (
          <ChangePasswordCard onDone={(m) => { setMsg(m); setError(''); load() }} setError={setError} />
        )}
      </div>
      <div role="tabpanel" id="section-sessions" aria-labelledby="tab-sessions" hidden={section !== 'sessions'}>
        {section === 'sessions' && (
          <SessionsCard data={data} reload={load} setMsg={setMsg} setError={setError} />
        )}
      </div>
      <div role="tabpanel" id="section-2fa" aria-labelledby="tab-2fa" hidden={section !== '2fa'}>
        {section === '2fa' && (
          <TwoFaCard status={data?.twofa || null} reload={load} setError={setError} setMsg={setMsg} />
        )}
      </div>
    </div>
  )
}

// ─── Cambio de contraseña ───────────────────────────────────────
function ChangePasswordCard({ onDone, setError }: { onDone: (m: string) => void; setError: (s: string) => void }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [closeOthers, setCloseOthers] = useState(true)
  const [saving, setSaving] = useState(false)

  const reqs = {
    len:   form.newPassword.length >= 8,
    alpha: /[A-Za-z]/.test(form.newPassword),
    num:   /[0-9]/.test(form.newPassword),
    match: form.newPassword.length > 0 && form.newPassword === form.confirm,
    diff:  form.newPassword.length > 0 && form.newPassword !== form.currentPassword,
  }
  const allOk = Object.values(reqs).every(Boolean)

  async function save() {
    setError('')
    if (!allOk) return setError('Revisá los requisitos de la contraseña.')
    setSaving(true)
    try {
      const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null
      const { data } = await api.post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
        closeOtherSessions: closeOthers,
        refreshToken,
      })
      onDone(data.message || 'Contraseña actualizada.')
      setForm({ currentPassword: '', newPassword: '', confirm: '' })
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center gap-2">
        <Lock size={18} className="text-slate-600 dark:text-white/60" />
        <h2 className="font-semibold text-slate-900 dark:text-white">Cambiar contraseña</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PwdInput id="current-password" label="Contraseña actual" value={form.currentPassword} onChange={v => setForm(f => ({ ...f, currentPassword: v }))} />
        <PwdInput label="Nueva contraseña" value={form.newPassword} onChange={v => setForm(f => ({ ...f, newPassword: v }))} />
        <PwdInput label="Confirmar" value={form.confirm} onChange={v => setForm(f => ({ ...f, confirm: v }))} />
      </div>

      {/* Requisitos visibles */}
      <ul className="text-xs space-y-1">
        <Req ok={reqs.len}>Al menos 8 caracteres</Req>
        <Req ok={reqs.alpha}>Contiene letras</Req>
        <Req ok={reqs.num}>Contiene números</Req>
        <Req ok={reqs.match}>La confirmación coincide</Req>
        <Req ok={reqs.diff}>Distinta a la contraseña actual</Req>
      </ul>

      <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none dark:text-white/70">
        <input type="checkbox" checked={closeOthers} onChange={e => setCloseOthers(e.target.checked)} className="w-4 h-4 accent-blue-600" />
        Cerrar mis otras sesiones al cambiar la contraseña
      </label>

      <div className="flex justify-end">
        <button onClick={save} disabled={saving || !form.currentPassword || !allOk}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
          {saving ? 'Guardando…' : 'Actualizar contraseña'}
        </button>
      </div>
    </div>
  )
}
function Req({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? 'text-emerald-600' : 'text-slate-400 dark:text-white/40'}`}>
      <CheckCircle size={13} className={ok ? '' : 'opacity-40'} /> {children}
    </li>
  )
}
function PwdInput({ label, value, onChange, id }: { label: string; value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">{label}</label>
      <input id={id} type="password" value={value} onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]"
        autoComplete="new-password" />
    </div>
  )
}

// ─── Sesiones activas ───────────────────────────────────────────
function SessionsCard({ data, reload, setMsg, setError }: {
  data: SecurityData | null; reload: () => void; setMsg: (s: string) => void; setError: (s: string) => void
}) {
  const [closing, setClosing] = useState(false)
  const fmt = (v?: string | null) => v ? new Date(v).toLocaleString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
  const uaShort = (ua?: string | null) => {
    if (!ua) return 'Dispositivo desconocido'
    const m = ua.match(/(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/)
    const os = ua.match(/\(([^)]+)\)/)?.[1]?.split(';')[0] || ''
    return [m?.[0]?.replace('Edg', 'Edge').replace('OPR', 'Opera'), os].filter(Boolean).join(' · ') || ua.slice(0, 40)
  }

  async function closeOthers() {
    if (!confirm('¿Cerrar todas tus otras sesiones? Deberás volver a iniciar sesión en esos dispositivos.')) return
    setError(''); setMsg('')
    setClosing(true)
    try {
      const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null
      const { data } = await api.post('/api/me/security/close-sessions', { refreshToken })
      setMsg(`Se cerraron ${data.closed} sesión(es).`)
      reload()
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
    finally { setClosing(false) }
  }

  const sessions = data?.sessions || []
  const others = sessions.filter(s => !s.is_current).length

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Monitor size={18} className="text-slate-600 dark:text-white/60" />
          <h2 className="font-semibold text-slate-900 dark:text-white">Sesiones y accesos</h2>
        </div>
        {others > 0 && (
          <button onClick={closeOthers} disabled={closing}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium disabled:opacity-60">
            <LogOut size={14} /> {closing ? 'Cerrando…' : 'Cerrar otras sesiones'}
          </button>
        )}
      </div>

      <p className="text-sm text-slate-500 dark:text-white/40 flex items-center gap-2">
        <Clock size={14} /> Último acceso: <strong className="text-slate-700 dark:text-white/70">{fmt(data?.last_login)}</strong>
      </p>

      <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
        {sessions.length === 0 && <p className="text-sm text-slate-400 py-3 dark:text-white/30">No hay sesiones activas registradas.</p>}
        {sessions.map(s => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800 dark:text-white/90 truncate">
                {uaShort(s.user_agent)}
                {s.is_current && <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">Este dispositivo</span>}
              </p>
              <p className="text-xs text-slate-400 dark:text-white/30 truncate">
                {s.ip_address || 'IP desconocida'} · último uso {fmt(s.last_used_at || s.created_at)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 2FA ────────────────────────────────────────────────────────
function TwoFaCard({ status, reload, setError, setMsg }: {
  status: { enabled: boolean; enabledAt: string | null } | null
  reload: () => void; setError: (s: string) => void; setMsg: (s: string) => void
}) {
  const [setupOpen, setSetupOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Smartphone size={18} className="text-slate-600 dark:text-white/60" />
          <h2 className="font-semibold text-slate-900 dark:text-white">Verificación en dos pasos (2FA)</h2>
        </div>
        {status?.enabled
          ? <span className="text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-medium">Habilitado</span>
          : <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-medium dark:bg-white/[0.06] dark:text-white/60">Deshabilitado</span>}
      </div>
      <p className="text-sm text-slate-500 dark:text-white/40">
        Agrega una capa extra pidiendo un código de 6 dígitos generado por una app
        (Google Authenticator, Authy, Microsoft Authenticator, 1Password).
      </p>
      {status?.enabled && status.enabledAt && (
        <p className="text-xs text-slate-400 dark:text-white/30">Habilitado el {new Date(status.enabledAt).toLocaleString()}</p>
      )}
      <div className="flex gap-2">
        {!status?.enabled
          ? <button onClick={() => setSetupOpen(true)} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium">Habilitar 2FA</button>
          : <button onClick={() => setDisableOpen(true)} className="px-4 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium">Deshabilitar 2FA</button>}
      </div>

      {setupOpen && <Setup2faModal onClose={() => setSetupOpen(false)} onDone={() => { setSetupOpen(false); reload(); setMsg('2FA habilitado correctamente.') }} setError={setError} />}
      {disableOpen && <Disable2faModal onClose={() => setDisableOpen(false)} onDone={() => { setDisableOpen(false); reload(); setMsg('2FA deshabilitado.') }} setError={setError} />}
    </div>
  )
}

function Setup2faModal({ onClose, onDone, setError }: { onClose: () => void; onDone: () => void; setError: (s: string) => void }) {
  const [secret, setSecret] = useState('')
  const [url, setUrl]       = useState('')
  const [otp, setOtp]       = useState('')
  const [step, setStep]     = useState<'qr'|'verify'>('qr')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.post('/api/auth/2fa/setup')
      .then(r => { setSecret(r.data.secret); setUrl(r.data.otpauthUrl) })
      .catch(e => setError(e.response?.data?.error || e.message))
  }, [])

  async function verify() {
    setLoading(true)
    try { await api.post('/api/auth/2fa/verify', { otp }); onDone() }
    catch (e: any) { setError(e.response?.data?.error || 'Código incorrecto') }
    finally { setLoading(false) }
  }

  const trapRef = useFocusTrap(true, onClose)
  return (
    <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="setup2fa-title" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
        <div className="flex items-center justify-between">
          <h3 id="setup2fa-title" className="font-bold text-slate-900 dark:text-white">Habilitar 2FA {step === 'verify' && '(paso 2/2)'}</h3>
          <button aria-label="Cerrar" onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} aria-hidden="true" /></button>
        </div>
        {step === 'qr' && (
          <>
            <ol className="text-sm text-slate-600 space-y-1 list-decimal pl-5 dark:text-white/60">
              <li>Instalá una app como Google Authenticator o Authy.</li>
              <li>Escaneá el QR o ingresá la clave manualmente.</li>
              <li>Ingresá el código de 6 dígitos que aparece en la app.</li>
            </ol>
            <div role="img" aria-label="Código QR de configuración 2FA." className="flex justify-center bg-slate-50 rounded-xl p-4 dark:bg-white/[0.03]">
              {QRCodeComp && url
                ? <QRCodeComp value={url} size={180} level="M" />
                : <div className="text-xs text-slate-500 dark:text-white/40"><p className="mb-2">Pegá esta URL en tu app:</p><textarea readOnly value={url} rows={4} aria-label="URL de configuración 2FA" className="w-full bg-white border border-slate-200 rounded p-2 font-mono text-[10px] dark:bg-white/[0.04] dark:border-white/[0.08]" /></div>}
            </div>
            {secret && (
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Clave manual</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono tracking-widest dark:bg-white/[0.03] dark:border-white/[0.08]">{secret}</code>
                  <button onClick={() => { navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500) }} className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-white/[0.06] dark:text-white/60">
                    {copied ? <CheckCircle size={14} className="text-emerald-600" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            )}
            <button onClick={() => setStep('verify')} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-xl text-sm font-medium">Ya escaneé el código</button>
          </>
        )}
        {step === 'verify' && (
          <>
            <label className="text-sm text-slate-700 dark:text-white/80">Ingresá el código de 6 dígitos:</label>
            <input type="text" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-2xl tracking-[0.4em] text-center font-mono dark:border-white/[0.08] dark:bg-white/[0.03]" placeholder="000000" inputMode="numeric" autoFocus />
            <div className="flex gap-2">
              <button onClick={() => setStep('qr')} className="flex-1 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm dark:bg-white/[0.06]">Atrás</button>
              <button onClick={verify} disabled={loading || otp.length !== 6} className="flex-1 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-60">{loading ? 'Verificando…' : 'Activar 2FA'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Disable2faModal({ onClose, onDone, setError }: { onClose: () => void; onDone: () => void; setError: (s: string) => void }) {
  const [pwd, setPwd] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)

  async function disable() {
    setLoading(true)
    try { await api.post('/api/auth/2fa/disable', { currentPassword: pwd, otp }); onDone() }
    catch (e: any) { setError(e.response?.data?.error || 'Error') }
    finally { setLoading(false) }
  }

  const trapRef = useFocusTrap(true, onClose)
  return (
    <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="disable2fa-title" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
        <div className="flex items-center justify-between">
          <h3 id="disable2fa-title" className="font-bold text-slate-900 dark:text-white">Deshabilitar 2FA</h3>
          <button aria-label="Cerrar" onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} aria-hidden="true" /></button>
        </div>
        <p className="text-sm text-slate-500 dark:text-white/40">Ingresá tu contraseña y el código 2FA actual para confirmar.</p>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Contraseña</label>
          <input type="password" value={pwd} onChange={e => setPwd(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" autoFocus />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Código 2FA</label>
          <input type="text" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-center tracking-widest font-mono dark:border-white/[0.08] dark:bg-white/[0.03]" placeholder="000000" inputMode="numeric" />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={disable} disabled={loading || !pwd || otp.length !== 6} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60">
            <KeyRound size={14} /> {loading ? 'Verificando…' : 'Deshabilitar'}
          </button>
        </div>
      </div>
    </div>
  )
}
