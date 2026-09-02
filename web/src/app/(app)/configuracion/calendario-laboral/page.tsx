'use client'
/**
 * Calendario laboral — vista mínima (FASE F3).
 *
 * Lista los calendarios laborales y muestra el calendario EFECTIVO de un rango
 * (resolutor de sólo lectura: feriados + excepciones + descanso dominical). La
 * escritura está protegida en la API por permiso y por CALENDAR_WRITE_ENABLED
 * (fail-closed); esta pantalla es de lectura/consulta.
 */
import { useEffect, useState } from 'react'
import { CalendarRange, Search } from 'lucide-react'
import { api } from '@/lib/api'

interface LaborCalendar { id: number; code: string; name: string; timezone: string; valid_from: string; valid_to: string | null; active: number }
interface EffectiveDay { date: string; working: boolean; reason: string }

const REASON_LABEL: Record<string, string> = {
  workday: 'Laborable', special: 'Especial', sunday: 'Domingo', rest_day: 'Descanso',
  holiday: 'Feriado', exception_working: 'Excepción laborable', exception_nonworking: 'Excepción no laborable',
}

export default function CalendarioLaboralPage() {
  const [cals, setCals] = useState<LaborCalendar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [days, setDays] = useState<EffectiveDay[] | null>(null)
  const [resolving, setResolving] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const data = await api.get('/api/labor-calendars').then(r => (r.data?.data ?? []) as LaborCalendar[])
      setCals(data)
      if (data.length && !selected) setSelected(String(data[0].id))
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function resolve() {
    if (!selected || !from || !to) return
    setResolving(true); setError('')
    try {
      const r = await api.get(`/api/labor-calendars/${selected}/effective`, { params: { from, to } })
      setDays((r.data?.days ?? []) as EffectiveDay[])
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al resolver')
      setDays(null)
    } finally { setResolving(false) }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center">
          <CalendarRange className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Calendario laboral</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Calendarios versionados y resolutor de días efectivos (sólo lectura).</p>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">Consultar rango efectivo</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Calendario</span>
            <select value={selected} onChange={e => setSelected(e.target.value)} className={inputCls}>
              {loading && <option>Cargando…</option>}
              {!loading && cals.length === 0 && <option value="">Sin calendarios</option>}
              {cals.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Desde</span>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Hasta</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className={inputCls} />
          </label>
          <button onClick={resolve} disabled={resolving || !selected || !from || !to}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60">
            <Search size={16} /> {resolving ? 'Resolviendo…' : 'Resolver'}
          </button>
        </div>
      </div>

      {days && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Motivo</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {days.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-slate-400 dark:text-white/30">Sin resultados</td></tr>}
              {days.map(d => (
                <tr key={d.date}>
                  <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{d.date}</td>
                  <td className="px-4 py-2">
                    {d.working
                      ? <span className="text-emerald-600 text-xs font-medium">Laborable</span>
                      : <span className="text-slate-400 text-xs">No laborable</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-white/50">{REASON_LABEL[d.reason] || d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const inputCls = 'border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08] bg-white dark:bg-transparent'
