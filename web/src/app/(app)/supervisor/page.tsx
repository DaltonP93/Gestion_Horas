'use client'
import { useEffect, useState } from 'react'
import { Users, CheckCircle, Clock, XCircle, Calendar, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTimePy } from '@/lib/datetime'

interface TeamMember {
  id: number; code: string; full_name: string
  department_id: number; department_name: string
  status: string | null; late_minutes: number | null
  worked_minutes: number | null; last_mark: string | null
}
interface Pending {
  id: number; type: string; start_date: string; end_date: string
  reason: string; status: string; created_at: string
  code: string; full_name: string; department_name: string
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  present:    { color: 'bg-emerald-100 text-emerald-800', label: 'Presente' },
  late:       { color: 'bg-amber-100 text-amber-800',     label: 'Con atraso' },
  absent:     { color: 'bg-red-100 text-red-800',         label: 'Ausente' },
  permission: { color: 'bg-blue-100 text-blue-800',       label: 'Permiso' },
}

export default function SupervisorPage() {
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [kpis, setKpis] = useState<any>({ total: 0, present: 0, late: 0, absent: 0, permission: 0 })
  const [team, setTeam] = useState<TeamMember[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [{ data: overview }, { data: pend }] = await Promise.all([
        api.get('/api/supervisor/team-overview', { params: { date } }),
        api.get('/api/supervisor/pending-approvals'),
      ])
      setKpis(overview.kpis); setTeam(overview.team); setPending(pend)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar equipo')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [date])

  const pct = (n: number) => kpis.total ? Math.round((n / kpis.total) * 100) : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center">
            <Users className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Mi equipo</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Estado de asistencia y aprobaciones pendientes.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          <button onClick={load}
            className="bg-slate-100 hover:bg-slate-200 rounded-xl px-3 py-2 text-sm flex items-center gap-1 dark:bg-white/[0.06]">
            <RefreshCw size={14} /> Actualizar
          </button>
        </div>
      </div>

      {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total equipo" value={kpis.total} icon={<Users size={18} />} color="slate" />
        <Kpi label="Presentes" value={kpis.present} pct={pct(kpis.present)} icon={<CheckCircle size={18} />} color="emerald" />
        <Kpi label="Con atraso" value={kpis.late} pct={pct(kpis.late)} icon={<Clock size={18} />} color="amber" />
        <Kpi label="Ausentes" value={kpis.absent} pct={pct(kpis.absent)} icon={<XCircle size={18} />} color="red" />
      </div>

      {/* Aprobaciones pendientes */}
      {pending.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2 dark:text-white">
              <Calendar size={18} className="text-indigo-600" />
              Aprobaciones pendientes ({pending.length})
            </h2>
            <a href="/aprobaciones" className="text-indigo-600 hover:text-indigo-700 text-sm font-medium">Ver todas →</a>
          </div>
          <div className="space-y-2">
            {pending.slice(0, 5).map(p => (
              <div key={p.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100 text-sm dark:bg-white/[0.03] dark:border-white/[0.06]">
                <div>
                  <span className="font-medium text-slate-900 dark:text-white">{p.full_name}</span>
                  <span className="text-slate-400 ml-2 dark:text-white/30">·</span>
                  <span className="text-slate-500 ml-2 dark:text-white/40">{p.type} · {p.start_date}{p.end_date !== p.start_date && ` → ${p.end_date}`}</span>
                </div>
                <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">{p.status === 'pending' ? 'Pendiente' : 'Esp. aprobación final'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lista del equipo */}
      <div className="bg-white rounded-2xl shadow border border-slate-100 overflow-x-auto dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase dark:bg-white/[0.03] dark:text-white/60">
            <tr>
              <th className="px-3 py-2 text-left">Empleado</th>
              <th className="px-3 py-2 text-left">Departamento</th>
              <th className="px-3 py-2 text-left">Estado</th>
              <th className="px-3 py-2 text-right">Atraso (min)</th>
              <th className="px-3 py-2 text-right">Horas trab.</th>
              <th className="px-3 py-2 text-left">Última marca</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && team.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-slate-400 dark:text-white/30">
                No tienes equipo asignado. Pide al admin que te designe como manager/coordinador de un departamento.
              </td></tr>
            )}
            {team.map(t => {
              const m = STATUS_META[t.status || ''] || { color: 'bg-slate-100 text-slate-600', label: t.status || '—' }
              return (
                <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900 dark:text-white">{t.full_name}</div>
                    <div className="text-xs text-slate-400 font-mono dark:text-white/30">{t.code}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-500 dark:text-white/40">{t.department_name || '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${m.color}`}>{m.label}</span>
                  </td>
                  <td className="px-3 py-2 text-right">{t.late_minutes ?? 0}</td>
                  <td className="px-3 py-2 text-right">{t.worked_minutes ? (t.worked_minutes / 60).toFixed(1) : '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-white/40">{fmtTimePy(t.last_mark)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Kpi({ label, value, pct, icon, color }: any) {
  const colors: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    amber: 'bg-amber-100 text-amber-600',
    red: 'bg-red-100 text-red-600',
  }
  return (
    <div className="bg-white rounded-2xl shadow border border-slate-100 p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between mb-2">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${colors[color]}`}>{icon}</div>
        {pct != null && <span className="text-xs text-slate-400 dark:text-white/30">{pct}%</span>}
      </div>
      <div className="text-2xl font-bold text-slate-900 dark:text-white">{value}</div>
      <div className="text-xs text-slate-500 mt-0.5 dark:text-white/40">{label}</div>
    </div>
  )
}
