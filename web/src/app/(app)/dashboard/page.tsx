'use client'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  Users, Clock, AlertTriangle, UserCheck, Activity, RefreshCw,
  Calendar, ArrowDownLeft, ArrowUpRight,
} from 'lucide-react'
import { attendanceApi, api } from '@/lib/api'
import { getSocket, reconnectSocket } from '@/lib/socket'
import { useI18n } from '@/i18n/I18nProvider'
import { Bento, Ring, GlowDot, Avatar, StatCard } from '@/components/futurista'

interface AttendanceEvent {
  employeeId: number
  employeeName?: string
  employee_name?: string
  timestamp: string
  type: 'in' | 'out' | 'unknown'
  source: 'device' | 'mobile' | 'manual'
  deviceId?: number
}

// Normaliza "YYYY-MM-DD HH:mm:ss" (sin TZ) a hora de Paraguay para display
function formatPunchTime(raw: string) {
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + '-03:00'
  return new Date(iso).toLocaleTimeString('es-PY', {
    timeZone: 'America/Asuncion',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export default function DashboardPage() {
  const { t, locale } = useI18n()
  const qc = useQueryClient()
  const [liveEvents, setLiveEvents] = useState<AttendanceEvent[]>([])
  const [today, setToday] = useState('')
  const [recalcLoading, setRecalcLoading] = useState(false)
  const [socketConnected, setSocketConnected] = useState(false)

  useEffect(() => {
    setToday(format(new Date(), "EEEE d 'de' MMMM", { locale: es }))
  }, [locale])

  const { data } = useQuery({
    queryKey: ['attendance-live'],
    queryFn: attendanceApi.live,
    refetchInterval: 30_000,
  })

  useEffect(() => {
    reconnectSocket()
    const socket = getSocket()
    const onConnect = () => setSocketConnected(true)
    const onDisconnect = () => setSocketConnected(false)
    const onNew = (event: AttendanceEvent) => {
      setLiveEvents(prev => [event, ...prev].slice(0, 50))
      qc.invalidateQueries({ queryKey: ['attendance-live'] })
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('attendance:new', onNew)
    setSocketConnected(socket.connected)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('attendance:new', onNew)
    }
  }, [qc])

  const stats = data?.stats || {}
  const recentLogs: AttendanceEvent[] = [...liveEvents, ...(data?.recentLogs || [])].slice(0, 20)

  const total = stats.total_employees || 0
  const presentes = (stats.present || 0) + (stats.late || 0)
  const pct = total ? Math.round((presentes / total) * 100) : 0

  async function recalc() {
    setRecalcLoading(true)
    try {
      await api.post('/api/attendance/recalc-summary')
      await qc.invalidateQueries({ queryKey: ['attendance-live'] })
    } finally {
      setRecalcLoading(false)
    }
  }

  return (
    <div className="px-4 md:px-8 py-5 md:py-7 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="font-display text-lg md:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            {t('nav.dashboard')}
          </h1>
          <p className="text-[11px] text-slate-400 dark:text-white/30 capitalize" suppressHydrationWarning>
            {today || ' '}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={recalc}
            disabled={recalcLoading}
            title="Recalcular resumen del día"
            className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-white/50
              hover:text-cyan-600 dark:hover:text-cyan-400 px-3 py-1.5 rounded-xl
              border border-slate-200 dark:border-white/[0.08] hover:border-cyan-300 dark:hover:border-cyan-400/30
              transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={recalcLoading ? 'animate-spin' : ''} />
            Actualizar KPIs
          </button>
          <div className={`flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-xl border ${
            socketConnected
              ? 'bg-emerald-50 dark:bg-emerald-400/[0.08] border-emerald-100 dark:border-emerald-400/20'
              : 'bg-amber-50 dark:bg-amber-400/[0.08] border-amber-100 dark:border-amber-400/20'
          }`}>
            <GlowDot color={socketConnected ? 'green' : 'amber'} />
            <span className={`text-[11px] font-bold ${socketConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
              {socketConnected ? t('dashboard.live_feed') : 'Reconectando...'}
            </span>
          </div>
        </div>
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 md:gap-4 auto-rows-[minmax(90px,auto)]">
        {/* HERO — Presentes con ring */}
        <Bento span="col-span-2 lg:col-span-2 row-span-2" delay={0} className="p-5 md:p-7 flex flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <GlowDot color="green" />
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 dark:text-white/40">En vivo</span>
              </div>
              <h2 className="text-sm font-semibold text-slate-500 dark:text-white/60">{t('dashboard.present')}</h2>
            </div>
            <div className="w-9 h-9 rounded-2xl bg-emerald-50 dark:bg-emerald-400/10 flex items-center justify-center text-emerald-500 dark:text-emerald-400">
              <Users size={17} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 mt-2">
            <div>
              <div className="text-5xl md:text-6xl font-extrabold tracking-tighter text-slate-900 dark:text-white leading-none tabular-nums">
                {presentes}
              </div>
              <div className="flex items-center gap-1.5 mt-3">
                <span className="text-[11px] font-bold text-emerald-500 bg-emerald-50 dark:bg-emerald-400/10 px-2 py-0.5 rounded-full tabular-nums">
                  {pct}%
                </span>
                <span className="text-[11px] text-slate-400 dark:text-white/30">de {total} empleados</span>
              </div>
            </div>
            <Ring pct={pct} size={110} stroke={9} color="#22d3ee" label={`${pct}%`} sublabel="asistencia" />
          </div>
        </Bento>

        <StatCard delay={80} tone="amber" icon={<Clock size={15} />} value={stats.late || 0} label={t('dashboard.late')} span="col-span-1 row-span-1" />
        <StatCard delay={120} tone="rose" icon={<AlertTriangle size={15} />} value={stats.absent || 0} label={t('dashboard.absent')} span="col-span-1 row-span-1" />

        {/* Distribución (barras) */}
        <Bento span="col-span-2 lg:col-span-2 row-span-2" delay={160} className="p-5 md:p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('dashboard.today_attendance')}</h3>
            <UserCheck size={15} className="text-slate-300 dark:text-white/20" />
          </div>
          <div className="space-y-3.5">
            {[
              { n: t('dashboard.present'), v: stats.present || 0, c: '#34d399' },
              { n: t('dashboard.late'), v: stats.late || 0, c: '#fbbf24' },
              { n: t('dashboard.absent'), v: stats.absent || 0, c: '#fb7185' },
              { n: t('dashboard.permissions'), v: stats.on_permission || 0, c: '#a78bfa' },
            ].map((d, i) => {
              const max = total || 1
              const w = Math.round((d.v / max) * 100)
              return (
                <div key={d.n}>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <span className="text-[12px] font-semibold text-slate-600 dark:text-white/70">{d.n}</span>
                    <span className="text-[11px] font-bold text-slate-900 dark:text-white tabular-nums">{d.v}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-white/[0.05] overflow-hidden">
                    <div className="h-full rounded-full bar-grow" style={{ width: `${w}%`, animationDelay: `${300 + i * 150}ms`, background: d.c, boxShadow: `0 0 8px ${d.c}66` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Bento>

        <StatCard delay={200} tone="violet" icon={<Calendar size={15} />} value={stats.on_permission || 0} label={t('dashboard.permissions')} span="col-span-1 row-span-1" />
        <StatCard delay={240} tone="cyan" icon={<Users size={15} />} value={total} label={t('nav.employees')} span="col-span-1 row-span-1" />

        {/* LIVE FEED */}
        <Bento span="col-span-2 lg:col-span-4 row-span-3" delay={280} className="p-5 md:p-6 flex flex-col" hover={false}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-cyan-50 dark:bg-cyan-400/10 flex items-center justify-center text-cyan-500 dark:text-cyan-400">
                <Activity size={15} />
              </div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('dashboard.live_feed')}</h3>
            </div>
            <GlowDot color="cyan" />
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto max-h-[380px] pr-1">
            {recentLogs.length === 0 && (
              <p className="text-slate-400 dark:text-white/30 text-sm text-center py-10">{t('dashboard.no_marks_today')}</p>
            )}
            {recentLogs.map((e, i) => {
              const name = e.employeeName || e.employee_name || '—'
              const isIn = e.type === 'in'
              return (
                <div
                  key={`${name}-${e.timestamp}-${i}`}
                  className={`flex items-center justify-between p-2.5 rounded-2xl transition-all duration-500
                    ${i === 0 && liveEvents.length ? 'feed-enter bg-cyan-50/80 dark:bg-cyan-400/[0.06] ring-1 ring-cyan-200 dark:ring-cyan-400/20' : 'bg-slate-50/80 dark:bg-white/[0.03]'}`}
                >
                  <div className="flex items-center gap-3">
                    <Avatar name={name} size={34} />
                    <div>
                      <div className="text-[13px] font-semibold text-slate-800 dark:text-white/90">{name}</div>
                      <div className="text-[10px] text-slate-400 dark:text-white/30 tabular-nums">{formatPunchTime(e.timestamp)}</div>
                    </div>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full
                    ${isIn
                      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400'
                      : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/50'}`}>
                    {isIn ? <ArrowDownLeft size={10} /> : <ArrowUpRight size={10} />}
                    {isIn ? t('attendance.in') : e.type === 'out' ? t('attendance.out') : 'Marcaje'}
                  </span>
                </div>
              )
            })}
          </div>
        </Bento>

        {/* Ring resumen lateral */}
        <Bento span="col-span-2 lg:col-span-2 row-span-3" delay={320} className="p-5 md:p-6 flex flex-col items-center justify-center gap-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white self-start">Cobertura del día</h3>
          <Ring pct={pct} size={160} stroke={12} color="#22d3ee" label={`${presentes}`} sublabel={`de ${total}`} />
          <div className="grid grid-cols-2 gap-3 w-full mt-2">
            <div className="text-center p-3 rounded-2xl bg-slate-50 dark:bg-white/[0.03]">
              <div className="text-lg font-extrabold text-emerald-500 tabular-nums">{stats.present || 0}</div>
              <div className="text-[10px] text-slate-400 dark:text-white/30">{t('dashboard.present')}</div>
            </div>
            <div className="text-center p-3 rounded-2xl bg-slate-50 dark:bg-white/[0.03]">
              <div className="text-lg font-extrabold text-amber-500 tabular-nums">{stats.late || 0}</div>
              <div className="text-[10px] text-slate-400 dark:text-white/30">{t('dashboard.late')}</div>
            </div>
          </div>
        </Bento>
      </div>
    </div>
  )
}
