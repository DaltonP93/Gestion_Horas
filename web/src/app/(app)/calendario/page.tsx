'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cake, Award, ChevronLeft, ChevronRight, Calendar, Mail } from 'lucide-react'
import { api } from '@/lib/api'
import { useI18n } from '@/i18n/I18nProvider'

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

function ordinal(n: number) {
  if (n === 1) return '1er'
  if (n === 3) return '3er'
  return `${n}°`
}

export default function CalendarioPage() {
  const { t } = useI18n()
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [tab, setTab] = useState<'birthdays' | 'anniversaries'>('birthdays')

  const { data: birthData, isLoading: bLoad } = useQuery({
    queryKey: ['birthdays', month],
    queryFn: () => api.get('/api/milestones/birthdays', { params: { month } }).then(r => r.data),
  })

  const { data: annivData, isLoading: aLoad } = useQuery({
    queryKey: ['anniversaries', month],
    queryFn: () => api.get('/api/milestones/anniversaries', { params: { month } }).then(r => r.data),
  })

  const { data: today } = useQuery({
    queryKey: ['milestones-today'],
    queryFn: () => api.get('/api/milestones/today').then(r => r.data),
    refetchInterval: 60_000 * 30,
  })

  const items: any[] = (tab === 'birthdays' ? birthData?.data : annivData?.data) || []
  const isLoading = tab === 'birthdays' ? bLoad : aLoad

  // Agrupar por día
  const grouped: Record<number, any[]> = {}
  for (const it of items) {
    if (!grouped[it.day]) grouped[it.day] = []
    grouped[it.day].push(it)
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center">
          <Calendar className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('calendar.title')}</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">{t('calendar.subtitle')}</p>
        </div>
      </div>

      {/* Hoy */}
      {(today?.birthdays?.length > 0 || today?.anniversaries?.length > 0) && (
        <div className="bg-gradient-to-r from-pink-50 to-orange-50 border border-pink-100 rounded-2xl p-5">
          <h3 className="text-sm font-bold text-pink-900 mb-3">🎉 {t('calendar.today_celebrating')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {today?.birthdays?.map((p: any) => (
              <div key={`b${p.id}`} className="bg-white rounded-xl p-3 flex items-center gap-3 dark:bg-white/[0.04]">
                <div className="w-10 h-10 rounded-full bg-pink-100 flex items-center justify-center">
                  <Cake size={18} className="text-pink-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-900 truncate dark:text-white">{p.full_name}</p>
                  <p className="text-xs text-slate-500 truncate dark:text-white/40">
                    Cumple {p.turning_age} años · {p.department || '—'}
                  </p>
                </div>
                {p.email && (
                  <a href={`mailto:${p.email}?subject=¡Feliz cumpleaños!`}
                    className="text-pink-600 hover:bg-pink-50 p-1.5 rounded-lg" title="Enviar saludo">
                    <Mail size={16} />
                  </a>
                )}
              </div>
            ))}
            {today?.anniversaries?.map((p: any) => (
              <div key={`a${p.id}`} className="bg-white rounded-xl p-3 flex items-center gap-3 dark:bg-white/[0.04]">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                  <Award size={18} className="text-amber-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-900 truncate dark:text-white">{p.full_name}</p>
                  <p className="text-xs text-slate-500 truncate dark:text-white/40">
                    {ordinal(p.years)} aniversario · {p.department || '—'}
                  </p>
                </div>
                {p.email && (
                  <a href={`mailto:${p.email}?subject=¡Feliz aniversario laboral!`}
                    className="text-amber-600 hover:bg-amber-50 p-1.5 rounded-lg" title="Enviar saludo">
                    <Mail size={16} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Selector mes + tabs */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center justify-between gap-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth(m => m === 1 ? 12 : m - 1)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
            <ChevronLeft size={18} />
          </button>
          <select value={month} onChange={e => setMonth(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold min-w-[140px] dark:border-white/[0.08]">
            {MESES.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
          <button onClick={() => setMonth(m => m === 12 ? 1 : m + 1)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
            <ChevronRight size={18} />
          </button>
        </div>

        <div className="flex bg-slate-100 rounded-xl p-1 dark:bg-white/[0.06]">
          <button onClick={() => setTab('birthdays')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === 'birthdays' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-500'
            }`}>
            <Cake size={14} /> {t('calendar.birthdays')}
            <span className="bg-pink-100 text-pink-700 px-1.5 py-0.5 rounded text-xs">{birthData?.count ?? 0}</span>
          </button>
          <button onClick={() => setTab('anniversaries')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === 'anniversaries' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500'
            }`}>
            <Award size={14} /> {t('calendar.anniversaries')}
            <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-xs">{annivData?.count ?? 0}</span>
          </button>
        </div>
      </div>

      {/* Lista por día */}
      {isLoading ? (
        <div className="text-center py-12 text-slate-400 dark:text-white/30">Cargando...</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center text-slate-400 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
          <Calendar size={36} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">
            Sin {tab === 'birthdays' ? 'cumpleaños' : 'aniversarios'} en {MESES[month - 1]}
          </p>
          {tab === 'birthdays' && (
            <p className="text-xs mt-1">Asegurate de cargar la fecha de nacimiento en cada empleado.</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(grouped).sort(([a], [b]) => +a - +b).map(([day, people]: any) => (
            <div key={day} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className={`px-4 py-3 ${tab === 'birthdays' ? 'bg-pink-50' : 'bg-amber-50'}`}>
                <p className="text-xs uppercase tracking-wide text-slate-500 font-medium dark:text-white/40">
                  {MESES[month - 1]}
                </p>
                <p className={`text-2xl font-bold ${tab === 'birthdays' ? 'text-pink-700' : 'text-amber-700'}`}>
                  {String(day).padStart(2, '0')}
                </p>
              </div>
              <div className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                {people.map((p: any) => (
                  <div key={p.id} className="p-3 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-800 text-sm truncate dark:text-white/90">{p.full_name}</p>
                      <p className="text-xs text-slate-400 truncate dark:text-white/30">
                        {p.department || 'Sin depto'}
                        {tab === 'birthdays' && p.turning_age != null && ` · cumple ${p.turning_age}`}
                        {tab === 'anniversaries' && p.years != null && ` · ${ordinal(p.years)} año`}
                      </p>
                    </div>
                    {p.email && (
                      <a href={`mailto:${p.email}`}
                        className="text-slate-400 hover:text-blue-600 hover:bg-blue-50 p-1.5 rounded-lg dark:text-white/30" title="Enviar email">
                        <Mail size={14} />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
