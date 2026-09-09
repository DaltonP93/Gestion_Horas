'use client'
import { useEffect, useState, useCallback } from 'react'
import { MapPinOff, ArrowDownLeft, ArrowUpRight, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { downloadCsv } from '@/lib/csvExport'

interface Row {
  id: number; employee_id: number; code: string; name: string; department: string
  marked_at: string; type: string; source: string; distance_m: number | null
  latitude: number | null; longitude: number | null
}

const sourceLabel = (s: string) => ({ mobile: 'App móvil', qr: 'QR', geo: 'GPS', web: 'Web', biometric: 'Reloj', manual: 'Manual' } as Record<string, string>)[s] || s

export default function MarcacionesGeocercaPage() {
  const now = new Date()
  const [from, setFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [rows, setRows] = useState<Row[]>([])
  const [depts, setDepts] = useState<any[]>([])
  const [dept, setDept] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/attendance/out-of-geofence', { params: { from, to, dept: dept || undefined } })
      setRows(r.data?.data || [])
    } catch { setRows([]) } finally { setLoading(false) }
  }, [from, to, dept])

  useEffect(() => { load() }, [load])
  useEffect(() => { api.get('/api/employees/departments').then(r => setDepts(r.data || [])).catch(() => {}) }, [])

  function exportCsv() {
    if (!rows.length) return
    downloadCsv(
      `marcaciones-geocerca_${from}_${to}.csv`,
      ['Fecha/hora', 'Código', 'Empleado', 'Departamento', 'Tipo', 'Origen', 'Distancia (m)', 'Latitud', 'Longitud'],
      rows.map(r => [r.marked_at, r.code, r.name, r.department, r.type === 'in' ? 'Entrada' : 'Salida', sourceLabel(r.source), r.distance_m, r.latitude, r.longitude]),
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-orange-400 to-rose-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(251,146,60,0.5)]">
          <MapPinOff size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Marcaciones fuera de geocerca</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Marcajes registrados fuera del perímetro de la sede (modo &quot;advertir&quot;).</p>
        </div>
      </div>

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
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Departamento</label>
            <select value={dept} onChange={e => setDept(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
              <option value="">Todos</option>
              {depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button onClick={exportCsv} disabled={!rows.length}
            className="px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm flex items-center gap-2 disabled:opacity-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">
            <Download size={15} /> Exportar CSV
          </button>
        </div>
      </section>

      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {loading ? (
          <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Cargando...</p>
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
                <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                  <th className="px-3 py-2">Fecha/hora</th><th className="px-3 py-2">Empleado</th>
                  <th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Origen</th>
                  <th className="px-3 py-2 text-right">Distancia</th><th className="px-3 py-2 text-right">Ubicación</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                {rows.map(r => (
                  <tr key={r.id} className="text-slate-700 dark:text-white/70">
                    <td className="px-3 py-2 tabular-nums">{r.marked_at}</td>
                    <td className="px-3 py-2"><span className="font-mono text-xs text-slate-400">{r.code}</span> {r.name}<div className="text-[11px] text-slate-400">{r.department}</div></td>
                    <td className="px-3 py-2">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${r.type === 'in' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300'}`}>
                        {r.type === 'in' ? <><ArrowDownLeft size={11} /> Entrada</> : <><ArrowUpRight size={11} /> Salida</>}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500 dark:text-white/50">{sourceLabel(r.source)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-rose-600 dark:text-rose-400">{r.distance_m != null ? `${r.distance_m} m` : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {r.latitude != null && r.longitude != null ? (
                        <a href={`https://www.google.com/maps?q=${r.latitude},${r.longitude}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">ver mapa</a>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin marcaciones fuera de la geocerca en el período. ✅</p>
        )}
      </section>
    </div>
  )
}
