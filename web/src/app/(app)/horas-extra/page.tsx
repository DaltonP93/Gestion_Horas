'use client'
import { useEffect, useState, useCallback } from 'react'
import { Clock, Check, X, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'

interface Row {
  employee_id: number; code: string; name: string; department: string
  date: string; overtime_minutes: number
  status: 'approved' | 'rejected' | null; note: string | null
}

const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`

export default function HorasExtraPage() {
  const user = useCurrentUser()
  const canConfig = hasRole(user, 'admin', 'gth')
  const now = new Date()
  const [from, setFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [state, setState] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const [rows, setRows] = useState<Row[]>([])
  const [requiresAuth, setRequiresAuth] = useState(false)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/overtime', { params: { from, to, state } })
      setRows(r.data?.data || [])
      setRequiresAuth(!!r.data?.requires_auth)
    } catch { setRows([]) } finally { setLoading(false) }
  }, [from, to, state])

  useEffect(() => { load() }, [load])

  async function toggleAuth() {
    if (!canConfig) return
    try {
      const r = await api.put('/api/overtime/config', { requires_auth: !requiresAuth })
      setRequiresAuth(!!r.data?.requires_auth)
      setMsg(r.data?.requires_auth ? 'Ahora las horas extra requieren aprobación.' : 'Las horas extra se computan automáticamente.')
    } catch { setMsg('No se pudo cambiar la configuración.') }
  }

  async function decide(r: Row, status: 'approved' | 'rejected') {
    try {
      await api.put('/api/overtime/decide', { employee_id: r.employee_id, date: r.date, status })
      load()
    } catch { setMsg('Error al registrar la decisión.') }
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(251,146,60,0.5)]">
          <Clock size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Horas extra</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Autorización de horas extra por empleado y día.</p>
        </div>
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}

      {/* Config */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 flex items-center justify-between gap-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className={requiresAuth ? 'text-emerald-500' : 'text-slate-400'} />
          <div>
            <div className="font-semibold text-slate-800 dark:text-white/90">Requerir autorización de horas extra</div>
            <div className="text-xs text-slate-400 dark:text-white/40">
              {requiresAuth
                ? 'El overtime se calcula pero sólo se paga/informa cuando se aprueba acá.'
                : 'El overtime se computa automáticamente (sin aprobación).'}
            </div>
          </div>
        </div>
        <button onClick={toggleAuth} disabled={!canConfig}
          className={`relative w-12 h-7 rounded-full transition-colors ${requiresAuth ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-white/[0.15]'} ${!canConfig ? 'opacity-50 cursor-not-allowed' : ''}`}>
          <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white transition-transform ${requiresAuth ? 'translate-x-5' : ''}`} />
        </button>
      </section>

      {/* Filtros */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Desde</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Hasta</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Estado</label>
            <select value={state} onChange={e => setState(e.target.value as any)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
              <option value="pending">Pendientes</option>
              <option value="approved">Aprobadas</option>
              <option value="rejected">Rechazadas</option>
              <option value="all">Todas</option>
            </select>
          </div>
        </div>
      </section>

      {/* Lista */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {loading ? (
          <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Cargando...</p>
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
                <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                  <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Empleado</th>
                  <th className="px-3 py-2">Depto.</th><th className="px-3 py-2 text-right">Horas extra</th>
                  <th className="px-3 py-2">Estado</th><th className="px-3 py-2 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                {rows.map((r, i) => (
                  <tr key={i} className="text-slate-700 dark:text-white/70">
                    <td className="px-3 py-2 tabular-nums">{r.date}</td>
                    <td className="px-3 py-2"><span className="font-mono text-xs text-slate-400">{r.code}</span> {r.name}</td>
                    <td className="px-3 py-2 text-slate-400 dark:text-white/40">{r.department || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{hhmm(r.overtime_minutes)}</td>
                    <td className="px-3 py-2">
                      {r.status === 'approved' && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">Aprobada</span>}
                      {r.status === 'rejected' && <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">Rechazada</span>}
                      {!r.status && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">Pendiente</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1.5 justify-end">
                        <button onClick={() => decide(r, 'approved')} title="Aprobar"
                          className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-400/10"><Check size={15} /></button>
                        <button onClick={() => decide(r, 'rejected')} title="Rechazar"
                          className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-400/10"><X size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin horas extra {state === 'pending' ? 'pendientes' : ''} en el período.</p>
        )}
      </section>
    </div>
  )
}
