'use client'
import { Suspense, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Lock, CheckCircle, AlertCircle } from 'lucide-react'
import { authApi } from '@/lib/api'

function ResetInner() {
  const sp = useSearchParams()
  const router = useRouter()
  const token = sp.get('token') || ''
  const [pwd, setPwd]       = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (pwd.length < 8) return setError('Mínimo 8 caracteres')
    if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) return setError('Debe contener letras y números')
    if (pwd !== confirm) return setError('Las contraseñas no coinciden')

    setLoading(true)
    try {
      await authApi.resetPassword(token, pwd)
      setDone(true)
      setTimeout(() => router.push('/login'), 2500)
    } catch (e: any) {
      setError(e.response?.data?.error || 'Token inválido o expirado')
    } finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-blue-900 p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-md dark:bg-white/[0.04]">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Lock size={24} className="text-blue-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Nueva contraseña</h1>
          <p className="text-sm text-slate-500 mt-1 dark:text-white/40">Elegí una nueva contraseña para tu cuenta.</p>
        </div>

        {!token && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 flex items-center gap-2">
            <AlertCircle size={16} /> Falta el token. Solicitá un nuevo enlace.
          </div>
        )}

        {done ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
            <CheckCircle className="text-emerald-600 shrink-0 mt-0.5" size={20} />
            <div className="text-sm text-emerald-900">
              Contraseña actualizada. Redirigiendo al login...
            </div>
          </div>
        ) : token && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="rp-pwd" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Nueva contraseña</label>
              <input id="rp-pwd" type="password" required value={pwd} onChange={e => setPwd(e.target.value)}
                aria-describedby="rp-pwd-hint" aria-invalid={!!error}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
                placeholder="••••••••" autoFocus />
              <p id="rp-pwd-hint" className="text-xs text-slate-500 mt-1 dark:text-white/40">Mínimo 8 caracteres, con letras y números.</p>
            </div>
            <div>
              <label htmlFor="rp-confirm" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Confirmar contraseña</label>
              <input id="rp-confirm" type="password" required value={confirm} onChange={e => setConfirm(e.target.value)}
                aria-invalid={!!error}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
                placeholder="••••••••" />
            </div>

            {error && (
              <div role="alert" aria-live="assertive"
                   className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-60">
              {loading ? 'Guardando...' : 'Restablecer contraseña'}
            </button>
          </form>
        )}

        <div className="text-center mt-6">
          <Link href="/login" className="text-xs text-slate-500 hover:text-slate-700 hover:underline dark:text-white/40">
            Volver al login
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-slate-400 dark:text-white/30">Cargando...</div>}>
      <ResetInner />
    </Suspense>
  )
}
