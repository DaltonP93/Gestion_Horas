'use client'
import { useEffect, useState } from 'react'
import { RefreshCw, QrCode, ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'

export default function QRAsistenciaPage() {
  const [branches, setBranches] = useState<any[]>([])
  const [branchId, setBranchId] = useState<string>('')
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string>('')

  useEffect(() => {
    api.get('/api/branches').then(r => {
      setBranches(r.data || [])
      if (r.data?.[0]) setBranchId(String(r.data[0].id))
    }).catch(() => {})
  }, [])

  async function loadCurrent(bid: string) {
    if (!bid) return
    try {
      const r = await api.get(`/api/self-checkin/qr-token/${bid}/current`)
      setToken(r.data.token)
      setExpiresAt(r.data.expires_at || null)
    } catch {}
  }

  async function rotate() {
    if (!branchId) return
    setLoading(true)
    try {
      const r = await api.post('/api/self-checkin/qr-token', { branch_id: +branchId })
      setToken(r.data.token)
      setExpiresAt(r.data.expires_at)
    } finally { setLoading(false) }
  }

  useEffect(() => { loadCurrent(branchId) }, [branchId])

  // Auto-rotación cada 4 min
  useEffect(() => {
    if (!branchId) return
    const id = setInterval(() => rotate(), 4 * 60 * 1000)
    return () => clearInterval(id)
  }, [branchId])

  // Generar QR vía API pública (sin dependencia extra)
  useEffect(() => {
    if (!token) { setQrDataUrl(''); return }
    setQrDataUrl(`https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`)
  }, [token])

  const timeLeft = expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)) : 0
  const [tick, setTick] = useState(0)
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id) }, [])

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <a href="/configuracion" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-white/40">
        <ArrowLeft size={16} /> Volver
      </a>
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">QR de marcación</h1>
        <p className="text-sm text-slate-500 dark:text-white/40">Genera y muestra el código QR rotativo para que los empleados marquen en esta sede.</p>
      </div>

      <div className="flex items-center gap-2">
        <select value={branchId} onChange={e => setBranchId(e.target.value)}
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm flex-1 dark:border-white/[0.08]">
          <option value="">Selecciona sede...</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button onClick={rotate} disabled={loading || !branchId}
          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50">
          <RefreshCw size={16} /> Rotar ahora
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow border border-slate-100 p-6 flex flex-col items-center gap-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="QR de marcación" className="w-80 h-80" />
        ) : (
          <div className="w-80 h-80 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400 dark:bg-white/[0.06] dark:text-white/30">
            <QrCode size={64} />
          </div>
        )}
        {token && (
          <>
            <div className="text-xs text-slate-500 font-mono break-all text-center dark:text-white/40">{token}</div>
            <div className="text-sm text-slate-600 dark:text-white/60">
              Expira en: <strong>{Math.floor((timeLeft - tick % 60) / 60)}:{String(Math.max(0, timeLeft - tick) % 60).padStart(2, '0')}</strong>
            </div>
          </>
        )}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <strong>Tip:</strong> mantén esta pantalla abierta en un monitor/tablet en la entrada de la sede. El QR rota automáticamente cada 4 minutos.
      </div>
    </div>
  )
}
