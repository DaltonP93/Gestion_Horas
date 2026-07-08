'use client'
import { useQuery } from '@tanstack/react-query'
import { Clock, AlertTriangle, CheckCircle, Hourglass, Activity } from 'lucide-react'
import { api } from '@/lib/api'

export default function ApprovalsSlaWidget() {
  const { data } = useQuery<any>({
    queryKey: ['approvals-sla-stats'],
    queryFn: () => api.get('/api/approvals-sla/stats').then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data: overdue } = useQuery<any>({
    queryKey: ['approvals-sla-overdue'],
    queryFn: () => api.get('/api/approvals-sla/overdue', { params: { days: 30 } }).then(r => r.data),
    refetchInterval: 60_000,
  })

  const s = data?.stats
  const overdueList: any[] = overdue?.data || []

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-blue-600" />
          <h3 className="font-semibold text-slate-800 dark:text-white/90">Métricas de SLA — últimos 30 días</h3>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={<Hourglass size={16} />} label="En curso" value={s?.in_progress ?? 0} color="bg-blue-50 text-blue-700" />
        <Stat icon={<AlertTriangle size={16} />} label="Vencidos" value={s?.overdue ?? 0} color="bg-rose-50 text-rose-700" />
        <Stat icon={<CheckCircle size={16} />} label="Aprobados" value={s?.approved ?? 0} color="bg-emerald-50 text-emerald-700" />
        <Stat icon={<Clock size={16} />} label="Tiempo prom." value={s?.avg_hours_to_approve ? `${s.avg_hours_to_approve}h` : '—'} color="bg-amber-50 text-amber-700" />
      </div>

      {overdueList.length > 0 && (
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-3">
          <p className="text-sm font-semibold text-rose-700 mb-2 flex items-center gap-1">
            <AlertTriangle size={14} /> {overdueList.length} solicitud{overdueList.length !== 1 ? 'es' : ''} con SLA vencido
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {overdueList.slice(0, 6).map(p => (
              <div key={p.id} className="flex items-center justify-between text-xs text-rose-700">
                <span className="truncate">
                  <strong>{p.employee_name}</strong> · {p.type} · {p.department || '—'}
                </span>
                <span className="font-mono shrink-0 ml-2">+{p.hours_overdue}h</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ icon, label, value, color }: { icon: any; label: string; value: any; color: string }) {
  return (
    <div className={`rounded-xl p-3 ${color}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-80">
        {icon} {label}
      </div>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  )
}
