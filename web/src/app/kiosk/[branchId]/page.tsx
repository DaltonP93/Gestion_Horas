'use client'
import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { api } from '@/lib/api'

export default function KioskPage({ params }: { params: { branchId: string } }) {
  const branchId = params.branchId
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [branch, setBranch] = useState<any>(null)
  const [now, setNow] = useState<Date | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    api.get(`/api/branches/${branchId}`).then(r => setBranch(r.data)).catch(() => {})
  }, [branchId])

  async function rotate() {
    try {
      const r = await api.post('/api/self-checkin/qr-token', { branch_id: +branchId })
      setToken(r.data.token); setExpiresAt(r.data.expires_at); setErr('')
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al generar QR. ¿Sesión expirada?')
    }
  }

  async function loadCurrent() {
    try {
      const r = await api.get(`/api/self-checkin/qr-token/${branchId}/current`)
      if (r.data.token) { setToken(r.data.token); setExpiresAt(r.data.expires_at) }
      else rotate()
    } catch { rotate() }
  }

  useEffect(() => { loadCurrent() /* eslint-disable-next-line */ }, [branchId])
  useEffect(() => {
    const id = setInterval(rotate, 4 * 60 * 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line
  }, [branchId])

  const qrSrc = token ? `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=0&data=${encodeURIComponent(token)}` : ''
  const left = expiresAt && now ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000)) : 0

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 text-white flex flex-col">
      <div className="flex items-center justify-between px-10 py-6">
        <div>
          <h1 className="text-3xl font-bold">{branch?.name || 'Sede'}</h1>
          <p className="text-blue-200 text-sm">Marcación de asistencia</p>
        </div>
        <div className="text-right">
          <div className="text-5xl font-mono font-bold tabular-nums" suppressHydrationWarning>
            {now ? now.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--'}
          </div>
          <div className="text-blue-200 text-sm capitalize" suppressHydrationWarning>
            {now ? now.toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ' '}
          </div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-8 px-10 pb-10">
        <div className="bg-white rounded-3xl p-8 flex flex-col items-center justify-center text-slate-900 shadow-2xl dark:bg-white/[0.04] dark:text-white">
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-4 dark:text-white/40">
            <Clock size={16} /> Código rota en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </div>
          {qrSrc ? (
            <img src={qrSrc} alt="QR" className="w-[420px] h-[420px]" />
          ) : (
            <div className="w-[420px] h-[420px] bg-slate-100 rounded-2xl animate-pulse dark:bg-white/[0.06]" />
          )}
          <p className="mt-6 text-slate-600 text-sm text-center max-w-md dark:text-white/60">
            Escanea con la app SisHoras en tu celular para marcar entrada o salida.
          </p>
        </div>

        <div className="space-y-6 flex flex-col justify-center">
          <div className="bg-white/10 backdrop-blur rounded-2xl p-6">
            <h2 className="font-semibold text-lg mb-2">Instrucciones</h2>
            <ol className="text-blue-100 text-sm space-y-2 list-decimal list-inside">
              <li>Abre SisHoras en tu celular.</li>
              <li>Inicia sesión con tu usuario.</li>
              <li>Ve a <b>Marcar (QR/GPS)</b>.</li>
              <li>Escanea o pega el código.</li>
              <li>Selecciona entrada o salida.</li>
            </ol>
          </div>
          {branch?.address && (
            <div className="bg-white/10 backdrop-blur rounded-2xl p-6 text-sm">
              <div className="text-blue-200 uppercase tracking-wide text-xs mb-1">Ubicación</div>
              <div>{branch.address}{branch.city ? `, ${branch.city}` : ''}</div>
            </div>
          )}
          {err && <div className="bg-red-500/20 border border-red-400 rounded-2xl p-4 text-sm">{err}</div>}
        </div>
      </div>
    </div>
  )
}
