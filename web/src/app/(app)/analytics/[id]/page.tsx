'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Cell, PieChart, Pie,
  AreaChart, Area,
} from 'recharts'
import { ArrowLeft, TrendingUp, Clock, AlertCircle, Calendar, Award } from 'lucide-react'
import Link from 'next/link'
import { api, employeesApi } from '@/lib/api'

function minsToHM(mins: number | null) {
  if (!mins || mins <= 0) return '0:00'
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

const STATUS_COLOR: Record<string, string> = {
  present:    '#22c55e',
  late:       '#f59e0b',
  absent:     '#ef4444',
  permission: '#8b5cf6',
  holiday:    '#3b82f6',
  weekend:    '#e2e8f0',
}

export default function AnalyticsPage() {
  const { id } = useParams<{ id: string }>()
  const [months, setMonths] = useState(3)

  const { data: emp } = useQuery({
    queryKey: ['employee', id],
    queryFn: () => employeesApi.get(+id),
    enabled: !!id,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', id, months],
    queryFn: () => api.get(`/api/reports/employee/${id}/analytics`, { params: { months } }).then(r => r.data),
    enabled: !!id,
  })

  if (isLoading || !data) {
    return <div className="p-6 text-slate-400 dark:text-white/30">Cargando analytics...</div>
  }

  const { summary, weekly, byDayOfWeek, daily, period } = data

  // Preparar datos para heatmap de calendario (últimos 30 días)
  const last30 = daily.slice(-30).map((d: any) => ({
    date:   d.date,
    label:  d.date ? format(new Date(d.date + 'T12:00'), 'dd/MM', { locale: es }) : '',
    horas:  d.worked_minutes ? +(d.worked_minutes / 60).toFixed(1) : 0,
    status: d.status || 'absent',
    color:  STATUS_COLOR[d.status] || '#e2e8f0',
  }))

  // Gráfica de horas semanales
  const weeklyChart = weekly.map((w: any) => ({
    label: w.week ? format(new Date(w.week + 'T12:00'), "'Sem' dd/MM", { locale: es }) : '',
    horas: +(w.worked / 60).toFixed(1),
    tardanza: w.late,
    presentes: w.present,
  }))

  const attendanceRate = summary.attendance_rate
  const rateColor = attendanceRate >= 90 ? '#22c55e' : attendanceRate >= 75 ? '#f59e0b' : '#ef4444'

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Back */}
      <div className="flex items-center justify-between">
        <Link href={`/empleados/${id}`} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 dark:text-white/40">
          <ArrowLeft size={16} /> Volver al empleado
        </Link>
        <div className="flex gap-2">
          {[1, 3, 6, 12].map(m => (
            <button key={m} onClick={() => setMonths(m)}
              className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                months === m ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}>
              {m === 1 ? '1 mes' : `${m} meses`}
            </button>
          ))}
        </div>
      </div>

      {/* Header empleado */}
      {emp && (
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-2xl font-bold">
            {emp.first_name?.[0]}{emp.last_name?.[0]}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{emp.first_name} {emp.last_name}</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">{emp.department_name || ''} · Analytics {period.from} – {period.to}</p>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { icon: <Award size={20} />, label: 'Asistencia',        value: `${attendanceRate}%`,          color: rateColor, bg: 'bg-white' },
          { icon: <Clock size={20} />, label: 'Horas trabajadas',  value: summary.total_worked,          color: '#3b82f6', bg: 'bg-white' },
          { icon: <AlertCircle size={20}/>, label: 'Días tardanza', value: String(summary.late),         color: '#f59e0b', bg: 'bg-white' },
          { icon: <Calendar size={20}/>, label: 'Ausencias',       value: String(summary.absent),        color: '#ef4444', bg: 'bg-white' },
          { icon: <TrendingUp size={20}/>, label: 'Hora prom. entrada', value: summary.avg_entry || '—', color: '#8b5cf6', bg: 'bg-white' },
        ].map((kpi, i) => (
          <div key={i} className={`${kpi.bg} rounded-2xl border border-slate-100 shadow-sm p-5`}>
            <div className="flex items-center gap-2 mb-2" style={{ color: kpi.color }}>
              {kpi.icon}
              <span className="text-xs font-medium text-slate-500 dark:text-white/40">{kpi.label}</span>
            </div>
            <p className="text-2xl font-bold text-slate-900 dark:text-white">{kpi.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Horas por semana */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-700 mb-4 text-sm dark:text-white/80">Horas trabajadas por semana</h2>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={weeklyChart}>
              <defs>
                <linearGradient id="horasGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => [`${v}h`, 'Horas']} />
              <Area type="monotone" dataKey="horas" stroke="#3b82f6" fill="url(#horasGrad)" strokeWidth={2} dot={{ r: 3 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Asistencia por día de semana */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-700 mb-4 text-sm dark:text-white/80">Asistencias por día de semana</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byDayOfWeek}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="present" name="Asistencias" radius={[6,6,0,0]}>
                {byDayOfWeek.map((_: any, i: number) => (
                  <Cell key={i} fill={i === 0 || i === 6 ? '#e2e8f0' : '#3b82f6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Heatmap de últimos 30 días */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-semibold text-slate-700 mb-4 text-sm dark:text-white/80">Últimos 30 días — Horas trabajadas</h2>
        <div className="flex flex-wrap gap-1.5">
          {last30.map((d: any, i: number) => (
            <div key={i} title={`${d.date}: ${d.horas}h (${d.status})`}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-medium text-white transition-transform hover:scale-110 cursor-default"
              style={{ backgroundColor: d.color }}>
              {d.horas > 0 ? d.horas : ''}
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-3 text-xs text-slate-500 flex-wrap dark:text-white/40">
          {Object.entries({ 'Presente': '#22c55e', 'Retardo': '#f59e0b', 'Ausente': '#ef4444', 'Permiso': '#8b5cf6', 'Festivo': '#3b82f6' }).map(([l, c]) => (
            <span key={l} className="flex items-center gap-1">
              <span className="w-3 h-3 rounded" style={{ background: c }} />{l}
            </span>
          ))}
        </div>
      </div>

      {/* Tabla detalle */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-700 text-sm dark:text-white/80">Detalle diario ({period.from} – {period.to})</h2>
        </div>
        <div className="overflow-y-auto max-h-80">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 sticky top-0 dark:bg-white/[0.03]">
              <tr>
                <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Fecha</th>
                <th className="text-center px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Estado</th>
                <th className="text-center px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Entrada</th>
                <th className="text-center px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Salida</th>
                <th className="text-center px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Trabajado</th>
                <th className="text-center px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Tardanza</th>
                <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Justificación</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {daily.map((d: any, i: number) => {
                const color = STATUS_COLOR[d.status] || '#94a3b8'
                return (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                    <td className="px-4 py-2.5 text-slate-600 font-mono text-xs dark:text-white/60">
                      {d.date ? format(new Date(d.date + 'T12:00'), "EEE dd/MM", { locale: es }) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    </td>
                    <td className="px-4 py-2.5 text-center font-mono text-xs text-slate-600 dark:text-white/60">
                      {d.first_in ? format(new Date(d.first_in), 'HH:mm') : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center font-mono text-xs text-slate-600 dark:text-white/60">
                      {d.last_out ? format(new Date(d.last_out), 'HH:mm') : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center font-mono text-xs">{minsToHM(d.worked_minutes)}</td>
                    <td className="px-4 py-2.5 text-center text-xs">
                      {d.late_minutes > 0 ? <span className="text-amber-600">+{d.late_minutes}m</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 text-xs dark:text-white/40">{d.justification || ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
