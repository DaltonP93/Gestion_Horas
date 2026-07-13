'use client'
import { useEffect, useState } from 'react'
import { Clock, Calendar, TrendingUp, AlertCircle, Download, QrCode } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtDateTimePy } from '@/lib/datetime'

interface Log { id: number; timestamp: string; type: 'in' | 'out'; source: string | null; device_id: number | null }
interface Summary {
  date: string
  first_in: string | null; last_out: string | null
  worked_minutes: number; late_minutes: number
  status: 'present' | 'absent' | 'late' | 'partial' | string
}

function todayISO()     { return new Date().toISOString().slice(0, 10) }
function nDaysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function fmtMins(m: number) {
  const h = Math.floor(m / 60), mm = m % 60
  return `${h}h ${mm.toString().padStart(2, '0')}m`
}

const STATUS_COLOR: Record<string, string> = {
  present: 'bg-emerald-100 text-emerald-800',
  late:    'bg-amber-100 text-amber-800',
  partial: 'bg-blue-100 text-blue-800',
  absent:  'bg-red-100 text-red-800',
}

export default function MiAsistenciaPage() {
  const [from, setFrom] = useState(nDaysAgoISO(14))
  const [to, setTo]     = useState(todayISO())
  const [logs, setLogs] = useState<Log[]>([])
  const [summary, setSummary] = useState<Summary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [a, s] = await Promise.all([
        api.get('/api/me/attendance', { params: { from, to } }).then(r => r.data as Log[]),
        api.get('/api/me/summary',    { params: { from, to } }).then(r => r.data as Summary[]),
      ])
      setLogs(a); setSummary(s)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [from, to])

  const totalWorked = summary.reduce((acc, d) => acc + (d.worked_minutes || 0), 0)
  const totalLate   = summary.reduce((acc, d) => acc + (d.late_minutes || 0), 0)
  const presentDays = summary.filter(d => ['present','late','partial'].includes(d.status)).length

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-emerald-500 flex items-center justify-center">
            <Clock className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Mi asistencia</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Tus marcajes y resumen diario.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href="/marcar" className="flex items-center gap-2 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm">
            <QrCode size={14} /> Marcar ahora
          </a>
          <button
            onClick={() => exportCsv(summary, logs, from, to)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm">
            <Download size={14} /> Exportar
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex flex-wrap items-end gap-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Desde</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Hasta</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </div>
        <div className="flex gap-2 ml-auto">
          <button onClick={() => { setFrom(todayISO()); setTo(todayISO()) }}
            className="px-3 py-2 text-xs rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06]">Hoy</button>
          <button onClick={() => { setFrom(nDaysAgoISO(7)); setTo(todayISO()) }}
            className="px-3 py-2 text-xs rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06]">7 días</button>
          <button onClick={() => { setFrom(nDaysAgoISO(30)); setTo(todayISO()) }}
            className="px-3 py-2 text-xs rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06]">30 días</button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900">{error}</div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Kpi label="Días presentes" value={`${presentDays}`} icon={Calendar} color="bg-emerald-500" />
        <Kpi label="Horas trabajadas" value={fmtMins(totalWorked)} icon={Clock} color="bg-blue-500" />
        <Kpi label="Atrasos" value={fmtMins(totalLate)} icon={TrendingUp} color="bg-amber-500" />
      </div>

      {/* Resumen diario */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-3 border-b bg-slate-50 dark:bg-white/[0.03]">
          <h2 className="font-semibold text-slate-900 text-sm dark:text-white">Resumen diario</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</div>
        ) : summary.length === 0 ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Sin datos en el rango.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Entrada</th>
                <th className="px-4 py-3">Salida</th>
                <th className="px-4 py-3">Trabajado</th>
                <th className="px-4 py-3">Atraso</th>
                <th className="px-4 py-3">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {summary.map(d => (
                <tr key={d.date}>
                  <td className="px-4 py-2.5 font-medium text-slate-900 dark:text-white">{d.date}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-white/60">{d.first_in || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-white/60">{d.last_out || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-white/60">{fmtMins(d.worked_minutes || 0)}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-white/60">{d.late_minutes ? fmtMins(d.late_minutes) : '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOR[d.status] || 'bg-slate-100 text-slate-600'}`}>
                      {d.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Marcajes crudos */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-3 border-b bg-slate-50 dark:bg-white/[0.03]">
          <h2 className="font-semibold text-slate-900 text-sm dark:text-white">Marcajes ({logs.length})</h2>
        </div>
        {logs.length === 0 ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Sin marcajes.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Fecha / Hora</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Origen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {logs.map(l => (
                <tr key={l.id}>
                  <td className="px-4 py-2.5 text-slate-900 dark:text-white">{fmtDateTimePy(l.timestamp)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${l.type === 'in' ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>
                      {l.type === 'in' ? 'Entrada' : 'Salida'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs dark:text-white/40">{l.source || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function exportCsv(summary: Summary[], logs: Log[], from: string, to: string) {
  const esc = (v: any) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const sumHeaders = ['fecha','entrada','salida','trabajado_min','atraso_min','estado']
  const sumRows = summary.map(d => [d.date, d.first_in || '', d.last_out || '', d.worked_minutes || 0, d.late_minutes || 0, d.status])
  const logHeaders = ['marcaje','tipo','origen']
  const logRows = logs.map(l => [fmtDateTimePy(l.timestamp), l.type, l.source || ''])
  const out = [
    `# Mi asistencia ${from} → ${to}`,
    '',
    '## Resumen diario',
    sumHeaders.join(';'),
    ...sumRows.map(r => r.map(esc).join(';')),
    '',
    '## Marcajes',
    logHeaders.join(';'),
    ...logRows.map(r => r.map(esc).join(';')),
  ].join('\r\n')
  const blob = new Blob(['\uFEFF' + out], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `mi_asistencia_${from}_${to}.csv`; a.click()
  URL.revokeObjectURL(url)
}

function Kpi({ label, value, icon: Icon, color }: { label: string; value: string; icon: any; color: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex items-center gap-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className={`w-12 h-12 rounded-xl ${color} flex items-center justify-center`}>
        <Icon className="text-white" size={22} />
      </div>
      <div>
        <p className="text-xs text-slate-500 uppercase tracking-wide dark:text-white/40">{label}</p>
        <p className="text-xl font-bold text-slate-900 dark:text-white">{value}</p>
      </div>
    </div>
  )
}
