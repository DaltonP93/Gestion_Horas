'use client'
import { useQuery } from '@tanstack/react-query'
import { Target, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, Settings } from 'lucide-react'
import Link from 'next/link'
import { api } from '@/lib/api'

const METRIC_LABELS: Record<string, string> = {
  attendance_rate: 'Presentismo',
  late_rate:       'Atrasos',
  absent_rate:     'Ausentismo',
  overtime_avg:    'Horas extra (prom)',
}

const STATUS_COLORS: Record<string, string> = {
  ok:      'bg-emerald-50 border-emerald-200 text-emerald-700',
  warn:    'bg-amber-50 border-amber-200 text-amber-700',
  crit:    'bg-rose-50 border-rose-200 text-rose-700',
  unknown: 'bg-slate-50 border-slate-200 text-slate-600',
}

const STATUS_BAR: Record<string, string> = {
  ok:      'bg-emerald-500',
  warn:    'bg-amber-500',
  crit:    'bg-rose-500',
  unknown: 'bg-slate-300',
}

export default function KpiGoalsWidget({ year, month, deptId }: { year: number; month: number; deptId?: string | number }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ['kpi-progress', year, month, deptId],
    queryFn: () => api.get('/api/kpi-goals/progress', {
      params: { year, month, ...(deptId ? { deptId } : {}) },
    }).then(r => r.data),
    refetchInterval: 60_000,
  })

  const goals: any[] = data?.goals || []

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
            <Target size={16} className="text-emerald-600" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-800 text-sm dark:text-white/90">Metas y objetivos</h3>
            <p className="text-xs text-slate-400 dark:text-white/30">Avance del mes vs umbrales configurados</p>
          </div>
        </div>
        <Link href="/configuracion/metas"
          className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 dark:text-white/30">
          <Settings size={12} /> Configurar
        </Link>
      </div>

      {isLoading && <div className="text-center py-4 text-slate-400 text-sm dark:text-white/30">Cargando...</div>}
      {!isLoading && goals.length === 0 && (
        <div className="text-center py-6 text-slate-400 text-sm dark:text-white/30">
          <Target size={28} className="mx-auto mb-2 opacity-30" />
          Sin metas activas — <Link href="/configuracion/metas" className="text-blue-600 hover:underline">configurá las metas</Link>
        </div>
      )}

      <div className="space-y-3">
        {goals.map(g => {
          const isLowerBetter = g.direction === 'lower_is_better'
          const Icon = isLowerBetter ? TrendingDown : TrendingUp
          const StatusIcon = g.status === 'ok' ? CheckCircle : AlertTriangle
          return (
            <div key={g.id} className={`rounded-xl border px-4 py-3 ${STATUS_COLORS[g.status] || STATUS_COLORS.unknown}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon size={14} />
                  <span className="text-sm font-semibold">{METRIC_LABELS[g.metric] || g.metric}</span>
                </div>
                <div className="flex items-center gap-1 text-xs">
                  <StatusIcon size={13} />
                  <span className="font-bold">
                    {g.current != null ? `${g.current}${g.unit}` : '—'}
                  </span>
                  <span className="text-slate-500 dark:text-white/40"> / {g.target}{g.unit}</span>
                </div>
              </div>
              <div className="w-full h-1.5 bg-white/60 rounded-full overflow-hidden">
                <div className={`h-full ${STATUS_BAR[g.status] || STATUS_BAR.unknown} transition-all`}
                  style={{ width: `${Math.min(100, Math.max(0, g.pct))}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
