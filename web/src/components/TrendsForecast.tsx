'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp, Sparkles } from 'lucide-react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { api } from '@/lib/api'

interface Props {
  months?: number
  forecast?: number
  deptId?: number | null
}

const SERIES = [
  { key: 'present',     name: 'Presentes', color: '#10b981' },
  { key: 'late_days',   name: 'Atrasos',   color: '#f59e0b' },
  { key: 'absent_days', name: 'Ausentes',  color: '#ef4444' },
]

export default function TrendsForecast({ months = 12, forecast = 3, deptId = null }: Props) {
  const [selected, setSelected] = useState<'present' | 'late_days' | 'absent_days'>('present')

  const { data, isLoading } = useQuery<any>({
    queryKey: ['trends-forecast', months, forecast, deptId],
    queryFn: () => api.get('/api/trends/attendance', {
      params: { months, forecast, ...(deptId ? { deptId } : {}) },
    }).then(r => r.data),
  })

  const points: any[] = (data?.data || []).map((p: any) => ({
    period: p.period,
    [`${selected}_real`]:     p.forecasted ? null : p[selected],
    [`${selected}_forecast`]: p.forecasted ? p[selected] : null,
    forecasted: p.forecasted,
  }))

  // El último punto real necesita aparecer también en la serie forecast para que se conecte
  const lastReal = data?.data?.findLast?.((p: any) => !p.forecasted)
  if (lastReal) {
    const i = points.findIndex(p => p.period === lastReal.period)
    if (i >= 0) points[i][`${selected}_forecast`] = lastReal[selected]
  }

  const transition = data?.data?.find((p: any) => p.forecasted)?.period

  const config = SERIES.find(s => s.key === selected)!

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-semibold text-slate-700 flex items-center gap-2 text-sm dark:text-white/80">
          <TrendingUp size={15} className="text-blue-600" />
          Tendencia + proyección ({months} meses históricos · {forecast} meses forecast)
          <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded-full">
            <Sparkles size={10} /> regresión lineal
          </span>
        </h3>
        <div className="flex bg-slate-100 rounded-xl p-1 dark:bg-white/[0.06]">
          {SERIES.map(s => (
            <button key={s.key} onClick={() => setSelected(s.key as any)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                selected === s.key ? 'bg-white shadow-sm' : 'text-slate-500'
              }`}
              style={selected === s.key ? { color: s.color } : {}}>
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div className="h-64 flex items-center justify-center text-slate-400 text-sm dark:text-white/30">Cargando...</div>}
      {!isLoading && (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={points}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="period" stroke="#64748b" fontSize={11} />
            <YAxis stroke="#64748b" fontSize={11} />
            <Tooltip />
            <Legend />
            {transition && (
              <ReferenceLine x={transition} stroke="#94a3b8" strokeDasharray="3 3"
                label={{ value: 'Forecast →', position: 'top', fontSize: 10, fill: '#64748b' }} />
            )}
            <Line type="monotone" dataKey={`${selected}_real`} name="Histórico"
              stroke={config.color} strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
            <Line type="monotone" dataKey={`${selected}_forecast`} name="Proyectado"
              stroke={config.color} strokeWidth={2} strokeDasharray="6 4"
              dot={{ r: 3, strokeDasharray: '0' }} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <p className="text-[11px] text-slate-400 mt-2 dark:text-white/30">
        Forecast calculado por regresión lineal sobre {data?.history_months || 0} meses de historia.
        Las proyecciones son estimaciones — solo válidas si la tendencia se mantiene.
      </p>
    </div>
  )
}
