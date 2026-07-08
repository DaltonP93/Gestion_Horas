'use client'
import { useEffect, useRef, useState } from 'react'
import { Shield, Lock, Smartphone, Copy, CheckCircle, AlertCircle, KeyRound, X } from 'lucide-react'
import { api } from '@/lib/api'

// Focus trap minimal: foco cicla dentro del modal, restaura al cerrar, Esc cierra.
function useFocusTrap(active: boolean, onEscape: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active || !ref.current) return
    const container = ref.current
    const prev = document.activeElement as HTMLElement | null
    const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(selector))
    const first = focusables()[0]
    first?.focus()
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

// QR renderer: usa chart vía API externa? No — usa <img> con QR data URL embebido.
// Para minimizar deps, renderizamos el QR usando una lib ligera inline.
// qrcode.react se instala en el server.
// Si no está disponible, mostramos la otpauth URL + secret para ingreso manual.

let QRCodeComp: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  QRCodeComp = require('qrcode.react').QRCodeSVG
} catch {}

interface Status { enabled: boolean; enabledAt: string | null }

export default function SeguridadPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError]   = useState('')
  const [msg, setMsg]       = useState('')

  async function loadStatus() {
    try {
      const { data } = await api.get('/api/auth/2fa/status')
      setStatus(data)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    }
  }
  useEffect(() => { loadStatus() }, [])

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center">
          <Shield className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Seguridad</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Autenticación en dos pasos y contraseña.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900">{error}</div>
        </div>
      )}
      {msg && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-2 text-sm text-emerald-900">
          <CheckCircle size={16} /> {msg}
        </div>
      )}

      {/* Password card */}
      <ChangePasswordCard onDone={() => setMsg('Contraseña actualizada.')} setError={setError} />

      {/* 2FA card */}
      <TwoFaCard status={status} reload={loadStatus} setError={setError} setMsg={setMsg} />
    </div>
  )
}

// ─── Cambio de contraseña ───────────────────────────────────────
function ChangePasswordCard({ onDone, setError }: { onDone: () => void; setError: (s: string) => void }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [saving, setSaving] = useState(false)

  async function save() {
    setError('')
    if (form.newPassword.length < 8) return setError('Mínimo 8 caracteres')
    if (!/[A-Za-z]/.test(form.newPassword) || !/[0-9]/.test(form.newPassword)) return setError('Debe contener letras y números')
    if (form.newPassword !== form.confirm) return setError('Las contraseñas no coinciden')

    setSaving(true)
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      })
      onDone()
      setForm({ currentPassword: '', newPassword: '', confirm: '' })
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center gap-2">
        <Lock size={18} className="text-slate-600 dark:text-white/60" />
        <h2 className="font-semibold text-slate-900 dark:text-white">Cambiar contraseña</h2>
      </div>
      <p className="text-sm text-slate-500 dark:text-white/40">Se cerrarán todas las sesiones abiertas en otros dispositivos.</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PwdInput label="Contraseña actual" value={form.currentPassword}
          onChange={v => setForm(f => ({ ...f, currentPassword: v }))} />
        <PwdInput label="Nueva contraseña" value={form.newPassword}
          onChange={v => setForm(f => ({ ...f, newPassword: v }))} />
        <PwdInput label="Confirmar" value={form.confirm}
          onChange={v => setForm(f => ({ ...f, confirm: v }))} />
      </div>
      <div className="flex justify-end">
        <button onClick={save} disabled={saving || !form.currentPassword || !form.newPassword}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
          {saving ? 'Guardando...' : 'Actualizar contraseña'}
        </button>
      </div>
    </div>
  )
}
function PwdInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">{label}</label>
      <input type="password" value={value} onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
        autoComplete="new-password" />
    </div>
  )
}

// ─── 2FA ────────────────────────────────────────────────────────
function TwoFaCard({ status, reload, setError, setMsg }: {
  status: { enabled: boolean; enabledAt: string | null } | null
  reload: () => void
  setError: (s: string) => void
  setMsg: (s: string) => void
}) {
  const [setupOpen, setSetupOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Smartphone size={18} className="text-slate-600 dark:text-white/60" />
          <h2 className="font-semibold text-slate-900 dark:text-white">Autenticación en dos pasos (2FA)</h2>
        </div>
        {status?.enabled
          ? <span className="text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-medium">Habilitado</span>
          : <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-medium dark:bg-white/[0.06] dark:text-white/60">Deshabilitado</span>}
      </div>
      <p className="text-sm text-slate-500 dark:text-white/40">
        Agrega una capa extra de seguridad pidiendo un código de 6 dígitos generado por una app
        (Google Authenticator, Authy, Microsoft Authenticator, 1Password).
      </p>
      {status?.enabled && status.enabledAt && (
        <p className="text-xs text-slate-400 dark:text-white/30">Habilitado el {new Date(status.enabledAt).toLocaleString()}</p>
      )}
      <div className="flex gap-2">
        {!status?.enabled
          ? <button onClick={() => setSetupOpen(true)}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium">
              Habilitar 2FA
            </button>
          : <button onClick={() => setDisableOpen(true)}
              className="px-4 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium">
              Deshabilitar 2FA
            </button>
        }
      </div>

      {setupOpen && (
        <Setup2faModal onClose={() => setSetupOpen(false)}
          onDone={() => { setSetupOpen(false); reload(); setMsg('2FA habilitado correctamente.') }}
          setError={setError} />
      )}
      {disableOpen && (
        <Disable2faModal onClose={() => setDisableOpen(false)}
          onDone={() => { setDisableOpen(false); reload(); setMsg('2FA deshabilitado.') }}
          setError={setError} />
      )}
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
    try {
      await api.post('/api/auth/2fa/verify', { otp })
      onDone()
    } catch (e: any) {
      setError(e.response?.data?.error || 'Código incorrecto')
    } finally { setLoading(false) }
  }

  const trapRef = useFocusTrap(true, onClose)
  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup2fa-title"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
    >
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h3 id="setup2fa-title" className="font-bold text-slate-900 dark:text-white">Habilitar 2FA {step === 'verify' && '(paso 2/2)'}</h3>
          <button aria-label="Cerrar" onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {step === 'qr' && (
          <>
            <ol className="text-sm text-slate-600 space-y-1 list-decimal pl-5 dark:text-white/60">
              <li>Instalá una app como Google Authenticator o Authy.</li>
              <li>Escaneá el QR o ingresá la clave manualmente.</li>
              <li>Ingresá el código de 6 dígitos que aparece en la app.</li>
            </ol>

            <div role="img" aria-label="Código QR de configuración 2FA. Escanealo con tu app autenticadora."
                 className="flex justify-center bg-slate-50 rounded-xl p-4 dark:bg-white/[0.03]">
              {QRCodeComp && url
                ? <QRCodeComp value={url} size={180} level="M" />
                : <div className="text-xs text-slate-500 dark:text-white/40">
                    <p className="mb-2">Pegá esta URL en tu app:</p>
                    <textarea readOnly value={url} rows={4}
                      aria-label="URL de configuración 2FA"
                      className="w-full bg-white border border-slate-200 rounded p-2 font-mono text-[10px] dark:bg-white/[0.04] dark:border-white/[0.08]" />
                  </div>
              }
            </div>

            {secret && (
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Clave manual</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono tracking-widest dark:bg-white/[0.03] dark:border-white/[0.08]">{secret}</code>
                  <button onClick={() => {
                    navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500)
                  }} className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-white/[0.06] dark:text-white/60">
                    {copied ? <CheckCircle size={14} className="text-emerald-600" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            )}

            <button onClick={() => setStep('verify')}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-xl text-sm font-medium">
              Ya escaneé el código
            </button>
          </>
        )}

        {step === 'verify' && (
          <>
            <label className="text-sm text-slate-700 dark:text-white/80">Ingresá el código de 6 dígitos:</label>
            <input type="text" value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-2xl tracking-[0.4em] text-center font-mono dark:border-white/[0.08]"
              placeholder="000000" inputMode="numeric" autoFocus />
            <div className="flex gap-2">
              <button onClick={() => setStep('qr')} className="flex-1 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm dark:bg-white/[0.06]">
                Atrás
              </button>
              <button onClick={verify} disabled={loading || otp.length !== 6}
                className="flex-1 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-60">
                {loading ? 'Verificando...' : 'Activar 2FA'}
              </button>
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
    try {
      await api.post('/api/auth/2fa/disable', { currentPassword: pwd, otp })
      onDone()
    } catch (e: any) {
      setError(e.response?.data?.error || 'Error')
    } finally { setLoading(false) }
  }

  const trapRef = useFocusTrap(true, onClose)
  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="disable2fa-title"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
    >
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h3 id="disable2fa-title" className="font-bold text-slate-900 dark:text-white">Deshabilitar 2FA</h3>
          <button aria-label="Cerrar" onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm text-slate-500 dark:text-white/40">Ingresá tu contraseña y el código 2FA actual para confirmar.</p>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Contraseña</label>
          <input type="password" value={pwd} onChange={e => setPwd(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" autoFocus />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Código 2FA</label>
          <input type="text" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-center tracking-widest font-mono dark:border-white/[0.08]"
            placeholder="000000" inputMode="numeric" />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={disable} disabled={loading || !pwd || otp.length !== 6}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60">
            <KeyRound size={14} /> {loading ? 'Verificando...' : 'Deshabilitar'}
          </button>
        </div>
      </div>
    </div>
  )
}
