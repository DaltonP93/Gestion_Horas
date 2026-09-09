'use client'
import { useEffect, useState, useCallback } from 'react'
import { AlertTriangle, Save, ArrowDownLeft, ArrowUpRight, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'
import { downloadCsv } from '@/lib/csvExport'

interface Row {
  employee_id: number; code: string; name: string; department: string
  date: string; first_in: string | null; last_out: string | null
  check_in: string | null; check_out: string | null
  early_min: number; late_out_min: number
}

export default function MarcasFueraRangoPage() {
  const user = useCurrentUser()
  const canConfig = hasRole(user, 'admin', 'gth')
  const now = new Date()
  const [from, setFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [rows, setRows] = useState<Row[]>([])
  const [th, setTh] = useState({ early_min: 30, late_min: 30 })
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/attendance/out-of-range', { params: { from, to } })
      setRows(r.data?.data || [])
      if (r.data?.thresholds) setTh({ early_min: r.data.thresholds.early_min, late_min: r.data.thresholds.late_min })
    } catch { setRows([]) } finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  function exportCsv() {
    if (!rows.length) return
    downloadCsv(
      `marcaciones-fuera-rango_${from}_${to}.csv`,
      ['Fecha', 'Código', 'Empleado', 'Departamento', 'Horario entrada', 'Horario salida', 'Marcó entrada', 'Marcó salida', 'Min antes', 'Min después'],
      rows.map(r => [r.date, r.code, r.name, r.department, r.check_in, r.check_out, r.first_in, r.last_out, r.early_min, r.late_out_min]),
    )
  }

  async function saveThresholds() {
    if (!canConfig) return
    try {
      await api.put('/api/settings', {
        att_early_mark_alert_min: String(th.early_min),
        att_late_mark_alert_min: String(th.late_min),
      })
      setMsg('Umbrales guardados.')
      load()
    } catch { setMsg('No se pudieron guardar los umbrales.') }
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-rose-400 to-red-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(244,63,94,0.5)]">
          <AlertTriangle size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Marcaciones fuera de rango</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Entradas muy tempranas o salidas muy tardías respecto al horario.</p>
        </div>
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}

      {/* Umbrales configurables */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-bold text-slate-900 dark:text-white mb-3">Umbrales de alerta</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Entrada temprana (min)</label>
            <input type="number" min={0} value={th.early_min} disabled={!canConfig}
              onChange={e => setTh(t => ({ ...t, early_min: +e.target.value }))}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-32 dark:border-white/[0.08] bg-transparent disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Salida tardía (min)</label>
            <input type="number" min={0} value={th.late_min} disabled={!canConfig}
              onChange={e => setTh(t => ({ ...t, late_min: +e.target.value }))}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-32 dark:border-white/[0.08] bg-transparent disabled:opacity-50" />
          </div>
          {canConfig && (
            <button onClick={saveThresholds} className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm flex items-center gap-2">
              <Save size={15} /> Guardar
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-400 dark:text-white/30 mt-2">Se alerta cuando la entrada es más de {th.early_min} min antes o la salida más de {th.late_min} min después del horario.</p>
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
          <button onClick={exportCsv} disabled={!rows.length}
            className="px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm flex items-center gap-2 disabled:opacity-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">
            <Download size={15} /> Exportar CSV
          </button>
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
                  <th className="px-3 py-2">Horario</th><th className="px-3 py-2">Marcó</th>
                  <th className="px-3 py-2 text-right">Desvío</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                {rows.map((r, i) => (
                  <tr key={i} className="text-slate-700 dark:text-white/70">
                    <td className="px-3 py-2 tabular-nums">{r.date}</td>
                    <td className="px-3 py-2"><span className="font-mono text-xs text-slate-400">{r.code}</span> {r.name}<div className="text-[11px] text-slate-400">{r.department}</div></td>
                    <td className="px-3 py-2 tabular-nums text-slate-400 dark:text-white/40">{r.check_in}–{r.check_out}</td>
                    <td className="px-3 py-2 tabular-nums">{r.first_in || '—'}–{r.last_out || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        {r.early_min > th.early_min && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300 inline-flex items-center gap-1">
                            <ArrowDownLeft size={11} /> {r.early_min}m antes
                          </span>
                        )}
                        {r.late_out_min > th.late_min && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300 inline-flex items-center gap-1">
                            <ArrowUpRight size={11} /> {r.late_out_min}m después
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin marcaciones fuera de rango en el período. ✅</p>
        )}
      </section>
    </div>
  )
}
