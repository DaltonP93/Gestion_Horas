'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Mail, ArrowLeft, CheckCircle } from 'lucide-react'
import { authApi } from '@/lib/api'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await authApi.forgotPassword(email)
      setSent(true)
    } catch (e: any) {
      setError(e.response?.data?.error || 'Error. Intentá de nuevo.')
    } finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-blue-900 p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-md dark:bg-white/[0.04]">
        <Link href="/login" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-4 dark:text-white/40">
          <ArrowLeft size={14} /> Volver al login
        </Link>

        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Mail size={24} className="text-blue-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">¿Olvidaste tu contraseña?</h1>
          <p className="text-sm text-slate-500 mt-1 dark:text-white/40">
            Ingresá tu email y te enviaremos un enlace para restablecerla.
          </p>
        </div>

        {sent ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
            <CheckCircle className="text-emerald-600 shrink-0 mt-0.5" size={20} />
            <div className="text-sm text-emerald-900">
              Si el email existe en nuestros registros, recibirás un enlace en los próximos minutos.
              Revisá tu bandeja de entrada y spam.
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="fp-email" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Email</label>
              <input id="fp-email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
                aria-invalid={!!error}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
                placeholder="tu@email.com" autoFocus />
            </div>

            {error && (
              <div role="alert" aria-live="assertive"
                   className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-colors disabled:opacity-60">
              {loading ? 'Enviando...' : 'Enviar enlace de recuperación'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
