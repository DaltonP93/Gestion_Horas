'use client'
import { useEffect, useState } from 'react'
import { TrendingUp, TrendingDown, Users, Clock, AlertTriangle, Calendar } from 'lucide-react'
import { api } from '@/lib/api'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import KpiGoalsWidget from '@/components/KpiGoalsWidget'
import TrendsForecast from '@/components/TrendsForecast'

interface Overview {
  period: { year: number; month: number; from: string; to: string; branch_id: number | null }
  kpis: {
    current: any
    previous: any
  }
  byDepartment: any[]
  heatmap: any[]
  trend: any[]
}

const DOW_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

export default function EjecutivoPage() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [branchId, setBranchId] = useState<string>('')
  const [branches, setBranches] = useState<any[]>([])
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/api/branches').then(r => setBranches(r.data || [])).catch(() => {})
  }, [])

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/api/executive/overview', {
        params: { year, month, ...(branchId ? { branch_id: branchId } : {}) },
      })
      setData(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar dashboard ejecutivo')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [year, month, branchId])

  const kpi = data?.kpis.current || {}
  const prev = data?.kpis.previous || {}

  const delta = (c: number, p: number) => {
    if (!p) return null
    return Math.round(((c - p) / p) * 100)
  }

  const minsToHours = (m: number) => m ? Math.round(m / 60).toLocaleString() : '0'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Dashboard Ejecutivo</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">KPIs globales, ranking de departamentos y tendencias.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={e => setYear(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={month} onChange={e => setMonth(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            {Array.from({ length: 12 }).map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2000, i).toLocaleString('es', { month: 'long' })}
              </option>
            ))}
          </select>
          <select value={branchId} onChange={e => setBranchId(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            <option value="">Todas las sedes</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>

      {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

      {loading && <div className="text-center py-12 text-slate-400 dark:text-white/30">Cargando...</div>}

      {data && !loading && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi label="Empleados activos" value={kpi.employees || 0} icon={<Users size={20} />} color="blue" />
            <Kpi label="Días presentes" value={kpi.present_days || 0} prev={prev.present_days || 0} delta={delta(kpi.present_days, prev.present_days)} icon={<Calendar size={20} />} color="emerald" />
            <Kpi label="Minutos de atraso" value={kpi.late_minutes || 0} prev={prev.late_minutes || 0} delta={delta(kpi.late_minutes, prev.late_minutes)} icon={<Clock size={20} />} color="amber" invert />
            <Kpi label="Ausencias" value={kpi.absent_days || 0} prev={prev.absent_days || 0} delta={delta(kpi.absent_days, prev.absent_days)} icon={<AlertTriangle size={20} />} color="red" invert />
          </div>

          {/* Metas KPI */}
          <KpiGoalsWidget year={year} month={month} deptId={undefined} />

          {/* Forecast */}
          <TrendsForecast months={12} forecast={3} />

          {/* Tendencia 6 meses */}
          <div className="bg-white rounded-2xl shadow border border-slate-100 p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <h2 className="font-semibold text-slate-900 mb-4 dark:text-white">Tendencia últimos 6 meses</h2>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="period" stroke="#64748b" fontSize={12} />
                <YAxis stroke="#64748b" fontSize={12} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="present_days" name="Presentes" stroke="#10b981" strokeWidth={2} />
                <Line type="monotone" dataKey="late_days" name="Retardos" stroke="#f59e0b" strokeWidth={2} />
                <Line type="monotone" dataKey="absent_days" name="Ausencias" stroke="#ef4444" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Ranking departamentos */}
          <div className="bg-white rounded-2xl shadow border border-slate-100 p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <h2 className="font-semibold text-slate-900 mb-4 dark:text-white">Ranking por departamento (menos atrasos)</h2>
            <ResponsiveContainer width="100%" height={Math.max(200, 40 * (data.byDepartment?.length || 1))}>
              <BarChart data={data.byDepartment} layout="vertical" margin={{ left: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" stroke="#64748b" fontSize={12} />
                <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={11} width={120} />
                <Tooltip />
                <Bar dataKey="late_minutes" name="Minutos atraso" fill="#f59e0b" />
                <Bar dataKey="absent_days" name="Ausencias" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Heatmap día × semana */}
          <div className="bg-white rounded-2xl shadow border border-slate-100 p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <h2 className="font-semibold text-slate-900 mb-4 dark:text-white">Mapa de calor — atrasos por día del mes</h2>
            <Heatmap data={data.heatmap} />
          </div>

          {/* Resumen general */}
          <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4 text-sm text-slate-600 dark:bg-white/[0.03] dark:text-white/60 dark:border-white/[0.08]">
            <strong>Período:</strong> {data.period.from} → {data.period.to} &nbsp;·&nbsp;
            <strong>Horas trabajadas:</strong> {minsToHours(kpi.worked_minutes || 0)}h &nbsp;·&nbsp;
            <strong>Horas extra:</strong> {minsToHours(kpi.overtime_minutes || 0)}h
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, prev, delta, icon, color, invert }: any) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    amber: 'bg-amber-100 text-amber-600',
    red: 'bg-red-100 text-red-600',
  }
  const up = delta !== null && delta > 0
  const goodUp = !invert
  const isGood = (up && goodUp) || (!up && !goodUp && delta !== null && delta < 0)
  return (
    <div className="bg-white rounded-2xl shadow border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colors[color]}`}>{icon}</div>
        {delta !== null && (
          <div className={`flex items-center gap-1 text-xs font-semibold ${isGood ? 'text-emerald-600' : 'text-red-600'}`}>
            {up ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {Math.abs(delta)}%
          </div>
        )}
      </div>
      <div className="text-2xl font-bold text-slate-900 dark:text-white">{Number(value || 0).toLocaleString()}</div>
      <div className="text-sm text-slate-500 mt-0.5 dark:text-white/40">{label}</div>
      {prev !== undefined && (
        <div className="text-xs text-slate-400 mt-1 dark:text-white/30">mes anterior: {Number(prev || 0).toLocaleString()}</div>
      )}
    </div>
  )
}

function Heatmap({ data }: { data: any[] }) {
  if (!data?.length) return <div className="text-slate-400 text-sm dark:text-white/30">Sin datos</div>

  const weeks = Array.from(new Set(data.map(d => d.week_idx))).sort((a, b) => a - b)
  const max = Math.max(...data.map(d => Number(d.late_minutes || 0)), 1)
  const cell = (week: number, dow: number) => data.find(d => d.week_idx === week && d.dow === dow)
  const colorFor = (v: number) => {
    const p = v / max
    if (!v) return 'bg-slate-100'
    if (p < 0.25) return 'bg-amber-100'
    if (p < 0.5)  return 'bg-amber-300'
    if (p < 0.75) return 'bg-amber-500'
    return 'bg-red-500'
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="w-20"></th>
            {DOW_NAMES.map(d => <th key={d} className="text-xs text-slate-500 font-medium w-16 text-center dark:text-white/40">{d}</th>)}
          </tr>
        </thead>
        <tbody>
          {weeks.map(w => (
            <tr key={w}>
              <td className="text-xs text-slate-500 pr-2 dark:text-white/40">Sem {w}</td>
              {DOW_NAMES.map((_, dow) => {
                const c = cell(w, dow)
                const v = Number(c?.late_minutes || 0)
                return (
                  <td key={dow}
                    title={c ? `${DOW_NAMES[dow]} sem ${w}: ${v} min atraso · ${c.absent} ausencias · ${c.present} presentes` : ''}
                    className={`w-16 h-10 rounded ${colorFor(v)} text-xs text-center align-middle text-slate-700`}>
                    {v || ''}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
