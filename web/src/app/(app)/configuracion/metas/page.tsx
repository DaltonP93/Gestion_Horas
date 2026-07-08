'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Target, Save, AlertTriangle, CheckCircle, TrendingUp, TrendingDown } from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

const METRIC_LABELS: Record<string, string> = {
  attendance_rate: 'Tasa de presentismo',
  late_rate:       'Tasa de atrasos',
  absent_rate:     'Tasa de ausentismo',
  overtime_avg:    'Promedio de horas extra',
}

const METRIC_DESC: Record<string, string> = {
  attendance_rate: 'Días con asistencia / total días esperados',
  late_rate:       'Días con atraso / total días',
  absent_rate:     'Días sin marcaje / total días',
  overtime_avg:    'Minutos extra promedio por empleado',
}

export default function MetasPage() {
  const qc = useQueryClient()
  const [edits, setEdits] = useState<Record<number, any>>({})
  const [saving, setSaving] = useState(false)

  const { data, isLoading } = useQuery<any>({
    queryKey: ['kpi-goals'],
    queryFn: () => api.get('/api/kpi-goals').then(r => r.data),
  })

  const goals: any[] = data?.data || []

  function setField(id: number, field: string, value: any) {
    setEdits(p => ({ ...p, [id]: { ...(p[id] || {}), [field]: value } }))
  }

  async function saveAll() {
    setSaving(true)
    try {
      for (const [idStr, changes] of Object.entries(edits)) {
        const id = parseInt(idStr, 10)
        await api.put(`/api/kpi-goals/${id}`, changes)
      }
      setEdits({})
      qc.invalidateQueries({ queryKey: ['kpi-goals'] })
      qc.invalidateQueries({ queryKey: ['kpi-progress'] })
      alert('Metas guardadas ✅')
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.keys(edits).length > 0

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <BackButton href="/configuracion" label="Configuración" />
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
          <Target className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Metas y objetivos KPI</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">
            Definí los umbrales que el sistema usa para evaluar el desempeño mensual.
          </p>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800 flex gap-3">
        <Target size={18} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold mb-1">Cómo funcionan las metas</p>
          <p>Cada métrica tiene una <strong>meta</strong> (verde), un <strong>umbral de advertencia</strong> (amarillo) y un <strong>umbral crítico</strong> (rojo). Estos valores se usan en el dashboard ejecutivo para señalar visualmente el estado del mes.</p>
        </div>
      </div>

      {isLoading && <div className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</div>}

      <div className="space-y-3">
        {goals.map((g: any) => {
          const e = edits[g.id] || {}
          const direction = e.direction ?? g.direction
          const isLowerBetter = direction === 'lower_is_better'
          return (
            <div key={g.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    isLowerBetter ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
                  }`}>
                    {isLowerBetter ? <TrendingDown size={18} /> : <TrendingUp size={18} />}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800 dark:text-white/90">{METRIC_LABELS[g.metric] || g.metric}</p>
                    <p className="text-xs text-slate-500 dark:text-white/40">
                      {g.scope === 'global' ? 'Global' : `Departamento: ${g.department_name || '—'}`} ·
                      {' '}{g.period_type === 'monthly' ? 'Mensual' : g.period_type === 'weekly' ? 'Semanal' : 'Diario'} ·
                      {' '}{METRIC_DESC[g.metric] || ''}
                    </p>
                  </div>
                </div>
                <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${
                  isLowerBetter ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                }`}>
                  {isLowerBetter ? 'Menor es mejor' : 'Mayor es mejor'}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1 dark:text-white/40">
                    <CheckCircle size={11} className="text-emerald-500" /> Meta ({g.unit})
                  </label>
                  <input type="number" step="0.01"
                    value={e.target_value ?? g.target_value}
                    onChange={ev => setField(g.id, 'target_value', parseFloat(ev.target.value))}
                    className="w-full border border-emerald-200 rounded-xl px-3 py-2 text-sm font-semibold text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1 dark:text-white/40">
                    <AlertTriangle size={11} className="text-amber-500" /> Advertencia ({g.unit})
                  </label>
                  <input type="number" step="0.01"
                    value={e.threshold_warn ?? g.threshold_warn ?? ''}
                    onChange={ev => setField(g.id, 'threshold_warn', parseFloat(ev.target.value))}
                    className="w-full border border-amber-200 rounded-xl px-3 py-2 text-sm font-semibold text-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1 font-medium flex items-center gap-1 dark:text-white/40">
                    <AlertTriangle size={11} className="text-rose-500" /> Crítico ({g.unit})
                  </label>
                  <input type="number" step="0.01"
                    value={e.threshold_crit ?? g.threshold_crit ?? ''}
                    onChange={ev => setField(g.id, 'threshold_crit', parseFloat(ev.target.value))}
                    className="w-full border border-rose-200 rounded-xl px-3 py-2 text-sm font-semibold text-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-500" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Activa</label>
                  <select value={e.active ?? g.active}
                    onChange={ev => setField(g.id, 'active', parseInt(ev.target.value, 10))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                    <option value={1}>Sí</option>
                    <option value={0}>No</option>
                  </select>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {dirty && (
        <div className="sticky bottom-4 flex justify-end">
          <button onClick={saveAll} disabled={saving}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white px-6 py-3 rounded-xl text-sm font-semibold shadow-lg transition-colors">
            <Save size={16} /> {saving ? 'Guardando...' : `Guardar cambios (${Object.keys(edits).length})`}
          </button>
        </div>
      )}
    </div>
  )
}
