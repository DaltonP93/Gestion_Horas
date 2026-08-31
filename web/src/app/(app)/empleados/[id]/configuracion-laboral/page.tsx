'use client'

import { useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { format } from 'date-fns'
import {
  AlertTriangle, ArrowLeft, CalendarDays, CheckCircle2, Clock3, Edit3,
  History, Info, Plus, Save, ShieldCheck, X,
} from 'lucide-react'
import { api, employeesApi, workdayConfigApi } from '@/lib/api'
import { hasRole, useCurrentUser } from '@/lib/useCurrentUser'
import {
  DAY_LABELS,
  applyScheduleToForm,
  emptyWorkdayConfigForm,
  formFromHistory,
  isRetroactive,
  modeLabel,
  validateWorkdayConfigForm,
  workdayConfigPayloadForSave,
  type EffectiveWorkdayConfig,
  type WorkdayConfigForm,
  type WorkdayHistoryRow,
  type WorkdaySchedule,
} from '@/lib/workdayConfig'

const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white'
const labelCls = 'mb-1 block text-xs font-semibold text-slate-600 dark:text-white/60'

function hm(minutes: number | null | undefined) {
  if (minutes == null) return 'No configurado'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

function civil(v: string | null | undefined) {
  if (!v) return 'Actual'
  const [y, m, d] = String(v).slice(0, 10).split('-')
  return y && m && d ? `${d}/${m}/${y}` : String(v)
}

function modeClasses(mode?: string) {
  return mode === 'configured'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20'
    : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-white/[0.04] dark:text-white/60 dark:border-white/[0.08]'
}

export default function ConfiguracionLaboralEmpleadoPage() {
  const { id } = useParams<{ id: string }>()
  const employeeId = Number(id)
  const qc = useQueryClient()
  const user = useCurrentUser()
  const today = format(new Date(), 'yyyy-MM-dd')
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [editing, setEditing] = useState<WorkdayHistoryRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [closing, setClosing] = useState<WorkdayHistoryRow | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const allowed = hasRole(user, 'admin', 'gth', 'hr')

  const employeeQ = useQuery({
    queryKey: ['employee', employeeId],
    queryFn: () => employeesApi.get(employeeId),
    enabled: Number.isInteger(employeeId) && employeeId > 0,
  })
  const historyQ = useQuery({
    queryKey: ['workday-config-history', employeeId],
    queryFn: () => workdayConfigApi.history(employeeId),
    enabled: allowed && employeeId > 0,
  })
  const effectiveQ = useQuery({
    queryKey: ['workday-config-effective', employeeId, effectiveDate],
    queryFn: () => workdayConfigApi.effective(employeeId, effectiveDate),
    enabled: allowed && employeeId > 0 && !!effectiveDate,
  })
  const schedulesQ = useQuery({
    queryKey: ['schedules-active'],
    queryFn: () => api.get('/api/schedules').then(r => r.data),
    enabled: allowed,
    staleTime: 60_000,
  })

  const history = ((historyQ.data?.data || []) as WorkdayHistoryRow[])
  const effective = (effectiveQ.data?.data || null) as EffectiveWorkdayConfig | null
  const employee = employeeQ.data
  const schedules = (schedulesQ.data || []) as WorkdaySchedule[]

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['workday-config-history', employeeId] }),
      qc.invalidateQueries({ queryKey: ['workday-config-effective', employeeId] }),
    ])
  }

  if (!user) return <div className="p-6 text-slate-400">Cargando permisos...</div>
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
          No tenés permiso para administrar la configuración laboral.
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href={`/empleados/${employeeId}`}
            className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 dark:text-white/40"
          >
            <ArrowLeft size={16} /> Volver al empleado
          </Link>
          <h1 className="mt-3 text-2xl font-bold text-slate-900 dark:text-white">
            Configuración laboral
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-white/40">
            {employee ? `${employee.first_name} ${employee.last_name} · #${employee.code}` : 'Empleado'}
          </p>
        </div>
        <button
          onClick={() => { setCreating(true); setEditing(null) }}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Plus size={16} /> Nueva vigencia
        </button>
      </div>

      {notice && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm ${
            notice.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-5 dark:border-blue-500/20 dark:bg-blue-500/[0.06]">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 shrink-0 text-blue-600" size={20} />
          <div className="space-y-1 text-sm text-blue-900 dark:text-blue-200">
            <p className="font-semibold">La configuración es efectiva por fecha y no modifica marcaciones.</p>
            <p>
              Si una fecha no tiene una vigencia completa, SisHoras continúa en <strong>histórico sin configurar</strong>:
              reconstruye IN/OUT desde las marcaciones reales y no aplica el turno actual, metas, atrasos ni descansos automáticos.
            </p>
            <p>
              Guardar una vigencia <strong>no recalcula daily_summary</strong> y no cambia attendance_logs.
            </p>
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-slate-900 dark:text-white">Configuración efectiva por fecha</h2>
            <p className="text-xs text-slate-500 dark:text-white/40">
              Consultá cualquier fecha sin modificar datos.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <CalendarDays size={16} className="text-slate-400" />
            <input
              type="date"
              value={effectiveDate}
              onChange={e => setEffectiveDate(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>

        {effectiveQ.isLoading ? (
          <p className="py-6 text-center text-sm text-slate-400">Resolviendo configuración...</p>
        ) : effectiveQ.isError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            No se pudo resolver la configuración para esa fecha.
          </div>
        ) : effective ? (
          <EffectiveCard config={effective} />
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
        <div className="mb-4">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <History size={17} /> Historial de vigencias
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/40">
            Los snapshots son históricos: editar el catálogo de turnos no cambia estas filas.
          </p>
        </div>

        {historyQ.isLoading ? (
          <p className="py-8 text-center text-sm text-slate-400">Cargando historial...</p>
        ) : historyQ.isError ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            La configuración histórica todavía no está disponible en este ambiente. No afecta los reportes: permanecen en historical_fallback.
          </div>
        ) : history.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-white/[0.12]">
            <Clock3 className="mx-auto mb-2 text-slate-300" size={28} />
            <p className="font-medium text-slate-700 dark:text-white/70">Todavía no hay vigencias cargadas.</p>
            <p className="mt-1 text-sm text-slate-500 dark:text-white/40">
              Las marcaciones históricas siguen procesándose normalmente en modo fallback.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {history.map(row => (
              <HistoryRow
                key={row.id}
                row={row}
                onEdit={() => { setEditing(row); setCreating(false) }}
                onClose={() => setClosing(row)}
              />
            ))}
          </div>
        )}
      </section>

      {(creating || editing) && (
        <WorkdayConfigDialog
          employeeId={employeeId}
          employeeName={employee ? `${employee.first_name} ${employee.last_name}` : `#${employeeId}`}
          row={editing}
          schedules={schedules}
          today={today}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={async () => {
            setCreating(false); setEditing(null)
            setNotice({ kind: 'ok', text: 'Vigencia guardada. No se recalcularon marcaciones ni resúmenes.' })
            await refresh()
          }}
        />
      )}

      {closing && (
        <CloseDialog
          row={closing}
          today={today}
          onClose={() => setClosing(null)}
          onSaved={async () => {
            setClosing(null)
            setNotice({ kind: 'ok', text: 'Vigencia cerrada. El histórico anterior se conserva.' })
            await refresh()
          }}
        />
      )}
    </div>
  )
}

function EffectiveCard({ config }: { config: EffectiveWorkdayConfig }) {
  const configured = config.calculation_mode_candidate === 'configured'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${modeClasses(config.calculation_mode_candidate)}`}>
          {modeLabel(config.calculation_mode_candidate)}
        </span>
        <span className="text-xs text-slate-500">Fuente: {config.source}</span>
        {config.configuration_conflict && (
          <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
            Conflicto de Turnera
          </span>
        )}
      </div>

      {!configured && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white/70">
          Esta fecha no tiene una configuración histórica completa. El reporte utiliza únicamente las marcaciones observadas.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Horario" value={
          config.schedule_snapshot?.check_in && config.schedule_snapshot?.check_out
            ? `${String(config.schedule_snapshot.check_in).slice(0,5)}–${String(config.schedule_snapshot.check_out).slice(0,5)}`
            : 'No configurado'
        } />
        <Metric label="Objetivo semanal" value={hm(config.profile?.weekly_target_minutes)} />
        <Metric label="Objetivo diario" value={hm(config.profile?.daily_target_minutes)} />
        <Metric label="Régimen" value={config.profile?.work_regime || 'No configurado'} />
        <Metric label="Descanso" value={
          config.profile?.break_mode
            ? `${config.profile.break_mode} · ${config.profile.break_minutes ?? 0} min`
            : 'No configurado'
        } />
        <Metric label="Día esperado" value={
          config.expected_workday === true ? 'Sí'
            : config.expected_workday === false ? 'No'
            : 'Desconocido'
        } />
        <Metric label="Redondeo" value={config.profile?.rounding_policy || 'No configurado'} />
        <Metric label="Horas extra" value={config.profile?.overtime_policy || 'No configurado'} />
      </div>

      {config.turnera && (
        <div className={`rounded-xl border p-4 text-sm ${
          config.turnera.pending_employee_configuration
            ? 'border-amber-200 bg-amber-50 text-amber-900'
            : 'border-indigo-200 bg-indigo-50 text-indigo-900'
        }`}>
          <p className="font-semibold">Turnera del día</p>
          <p className="mt-1">
            {config.turnera.check_in && config.turnera.check_out
              ? `${String(config.turnera.check_in).slice(0,5)}–${String(config.turnera.check_out).slice(0,5)}`
              : config.turnera.kind}
            {' · '}{config.turnera.segments || 0} segmento(s)
          </p>
          {config.turnera.pending_employee_configuration && (
            <p className="mt-2 font-medium">
              Planificación visible, pero todavía NO activa para el cálculo porque falta una vigencia histórica completa del empleado.
            </p>
          )}
        </div>
      )}

      {(config.permission || config.holiday) && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800">
          Existe una excepción de calendario aprobada para esta fecha.
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-white/[0.03]">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-800 dark:text-white/80">{value}</p>
    </div>
  )
}

function HistoryRow({
  row, onEdit, onClose,
}: {
  row: WorkdayHistoryRow
  onEdit: () => void
  onClose: () => void
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-white/[0.08]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-900 dark:text-white">
              {civil(row.valid_from)} → {row.valid_to ? civil(row.valid_to) : 'Actual'}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              row.snapshot_complete === false
                ? 'bg-amber-100 text-amber-700'
                : 'bg-emerald-100 text-emerald-700'
            }`}>
              {row.snapshot_complete === false ? 'Incompleto' : 'Snapshot'}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600 dark:text-white/60">
            {row.schedule_name_snapshot || 'Horario manual'} · {String(row.check_in || '').slice(0,5) || '—'}–{String(row.check_out || '').slice(0,5) || '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/40">
            {row.work_days?.map(d => DAY_LABELS[d]).join(' ') || 'Días sin configurar'}
            {' · '}Semanal: {hm(row.weekly_target_minutes)}
            {' · '}Régimen: {row.work_regime || 'no configurado'}
          </p>
          {row.change_reason && (
            <p className="mt-2 text-xs text-slate-500">Motivo: {row.change_reason}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium hover:bg-slate-50">
            <Edit3 size={13} /> Corregir
          </button>
          {!row.valid_to && (
            <button onClick={onClose} className="inline-flex items-center gap-1 rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50">
              <X size={13} /> Cerrar vigencia
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkdayConfigDialog({
  employeeId, employeeName, row, schedules, today, onClose, onSaved,
}: {
  employeeId: number
  employeeName: string
  row: WorkdayHistoryRow | null
  schedules: WorkdaySchedule[]
  today: string
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!row
  const [form, setForm] = useState<WorkdayConfigForm>(
    row ? formFromHistory(row) : emptyWorkdayConfigForm(today),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const retro = isRetroactive(form.valid_from, today)
  const errors = useMemo(() => validateWorkdayConfigForm(form), [form])

  function set<K extends keyof WorkdayConfigForm>(key: K, value: WorkdayConfigForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function chooseSchedule(value: string) {
    if (!value) {
      set('schedule_id', '')
      return
    }
    const schedule = schedules.find(s => s.id === Number(value))
    if (schedule) setForm(prev => applyScheduleToForm(prev, schedule))
  }

  function toggleDay(day: number) {
    setForm(prev => ({
      ...prev,
      work_days: prev.work_days.includes(day)
        ? prev.work_days.filter(d => d !== day)
        : [...prev.work_days, day].sort((a, b) => a - b),
    }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (errors.length) { setError(errors[0]); return }
    if (!form.reason.trim()) {
      setError('Indicá el motivo del cambio para la auditoría.')
      return
    }
    if (retro && !confirm(
      'Esta vigencia es retroactiva. No se modificarán marcaciones ni se recalcularán resúmenes automáticamente. ¿Guardar igualmente?'
    )) return

    setSaving(true)
    try {
      const payload = workdayConfigPayloadForSave(form, row)
      if (editing && row) await workdayConfigApi.update(row.id, payload)
      else await workdayConfigApi.create(employeeId, payload)
      await onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.response?.data?.message || e.message || 'No se pudo guardar')
    } finally {
      setSaving(false)
    }
  }

  // No se lee employees.schedule_id en ningún caso: el usuario selecciona
  // explícitamente el catálogo que quiere snapshotear.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0d0d0f]">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              {editing ? 'Corregir vigencia histórica' : 'Nueva vigencia laboral'}
            </h2>
            <p className="text-sm text-slate-500">{employeeName}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 hover:bg-slate-100" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        {retro && (
          <div className="mb-5 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Configuración retroactiva</p>
              <p>
                Puede cambiar cálculos derivados de este período cuando se haga un recálculo explícito futuro.
                No modifica attendance_logs y guardar ahora no ejecuta ningún recálculo.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={submit} className="space-y-6">
          <fieldset className="grid gap-4 rounded-2xl border border-slate-200 p-4 md:grid-cols-3 dark:border-white/[0.08]">
            <legend className="px-2 text-sm font-semibold">Vigencia</legend>
            <div>
              <label className={labelCls}>Vigente desde *</label>
              <input type="date" value={form.valid_from} onChange={e => set('valid_from', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Vigente hasta</label>
              <input type="date" value={form.valid_to} min={form.valid_from} onChange={e => set('valid_to', e.target.value)} className={inputCls} />
              <p className="mt-1 text-[11px] text-slate-400">Vacío = vigente. La fecha de cierre es inclusiva.</p>
            </div>
            <div>
              <label className={labelCls}>Catálogo de turno</label>
              <select value={form.schedule_id} onChange={e => chooseSchedule(e.target.value)} className={inputCls}>
                <option value="">Horario manual</option>
                {schedules.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">
                Se copia como snapshot. Cambios futuros al catálogo no alteran esta vigencia.
              </p>
            </div>
          </fieldset>

          <fieldset className="space-y-4 rounded-2xl border border-slate-200 p-4 dark:border-white/[0.08]">
            <legend className="px-2 text-sm font-semibold">Horario y días</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Entrada *"><input type="time" value={form.check_in} onChange={e => set('check_in', e.target.value)} className={inputCls} /></Field>
              <Field label="Salida *"><input type="time" value={form.check_out} onChange={e => set('check_out', e.target.value)} className={inputCls} /></Field>
              <Field label="Tolerancia entrada"><input type="number" min={0} max={1440} value={form.tolerance_in} onChange={e => set('tolerance_in', e.target.value)} className={inputCls} /></Field>
              <Field label="Tolerancia salida"><input type="number" min={0} max={1440} value={form.tolerance_out} onChange={e => set('tolerance_out', e.target.value)} className={inputCls} /></Field>
            </div>
            <div>
              <span className={labelCls}>Días laborables *</span>
              <div className="flex flex-wrap gap-2">
                {[1,2,3,4,5,6,7].map(day => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    aria-pressed={form.work_days.includes(day)}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                      form.work_days.includes(day)
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 bg-white text-slate-600'
                    }`}
                  >
                    {DAY_LABELS[day]}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>

          <fieldset className="grid gap-4 rounded-2xl border border-slate-200 p-4 md:grid-cols-3 dark:border-white/[0.08]">
            <legend className="px-2 text-sm font-semibold">Descanso</legend>
            <Field label="Modo">
              <select value={form.break_mode} onChange={e => set('break_mode', e.target.value as WorkdayConfigForm['break_mode'])} className={inputCls}>
                <option value="none">Sin descuento automático</option>
                <option value="punched">Marcado OUT/IN</option>
                <option value="fixed_unpaid">Fijo no remunerado</option>
              </select>
            </Field>
            <Field label="Minutos de descanso">
              <input type="number" min={0} max={1440} value={form.break_minutes} onChange={e => set('break_minutes', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Aplicar después de (min)">
              <input type="number" min={0} max={1440} value={form.break_after_minutes} onChange={e => set('break_after_minutes', e.target.value)} className={inputCls} />
            </Field>
          </fieldset>

          <fieldset className="grid gap-4 rounded-2xl border border-slate-200 p-4 md:grid-cols-3 dark:border-white/[0.08]">
            <legend className="px-2 text-sm font-semibold">Perfil laboral</legend>
            <Field label="Objetivo semanal (horas)">
              <input type="number" min={0} step="0.25" value={form.weekly_target_hours} onChange={e => set('weekly_target_hours', e.target.value)} className={inputCls} placeholder="Ej: 36, 42, 45, 48" />
            </Field>
            <Field label="Objetivo diario (horas)">
              <input type="number" min={0} step="0.25" value={form.daily_target_hours} onChange={e => set('daily_target_hours', e.target.value)} className={inputCls} placeholder="Opcional" />
            </Field>
            <Field label="Régimen">
              <select value={form.work_regime} onChange={e => set('work_regime', e.target.value as WorkdayConfigForm['work_regime'])} className={inputCls}>
                <option value="">No configurado</option>
                <option value="day">Diurno</option>
                <option value="night">Nocturno</option>
                <option value="mixed">Mixto</option>
                <option value="special">Especial</option>
                <option value="custom">Personalizado</option>
              </select>
            </Field>
            <Field label="Inicio franja nocturna">
              <input type="time" value={form.night_start} onChange={e => set('night_start', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Fin franja nocturna">
              <input type="time" value={form.night_end} onChange={e => set('night_end', e.target.value)} className={inputCls} />
            </Field>
          </fieldset>

          <details className="rounded-2xl border border-slate-200 p-4 dark:border-white/[0.08]">
            <summary className="cursor-pointer text-sm font-semibold text-slate-800 dark:text-white/80">
              Políticas avanzadas
            </summary>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Policy de redondeo">
                <input value={form.rounding_policy} onChange={e => set('rounding_policy', e.target.value)} className={inputCls} placeholder="exact, nearest_5, ..." />
              </Field>
              <Field label="Versión redondeo">
                <input type="number" min={1} value={form.rounding_policy_version} onChange={e => set('rounding_policy_version', e.target.value)} className={inputCls} />
              </Field>
              <Field label="Policy horas extra">
                <input value={form.overtime_policy} onChange={e => set('overtime_policy', e.target.value)} className={inputCls} placeholder="rrhh_review, ..." />
              </Field>
              <Field label="Versión horas extra">
                <input type="number" min={1} value={form.overtime_policy_version} onChange={e => set('overtime_policy_version', e.target.value)} className={inputCls} />
              </Field>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Definir una policy no la aplica mágicamente: sólo se usa cuando el motor tenga una implementación versionada correspondiente.
            </p>
          </details>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Motivo del cambio *">
              <input required value={form.reason} onChange={e => set('reason', e.target.value)} className={inputCls} placeholder="Asignación inicial, cambio contractual, corrección histórica..." />
            </Field>
            <Field label="Notas">
              <input value={form.notes} onChange={e => set('notes', e.target.value)} className={inputCls} placeholder="Observación opcional" />
            </Field>
          </div>

          {errors.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {errors[0]}
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-white/[0.06]">
            <button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || errors.length > 0}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Save size={15} /> {saving ? 'Guardando...' : 'Guardar vigencia'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  )
}

function CloseDialog({
  row, today, onClose, onSaved,
}: {
  row: WorkdayHistoryRow
  today: string
  onClose: () => void
  onSaved: () => void
}) {
  const [date, setDate] = useState(today)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!date || date < row.valid_from) {
      setError('La fecha de cierre no puede ser anterior al inicio de la vigencia.')
      return
    }
    if (!reason.trim()) {
      setError('Indicá el motivo del cierre.')
      return
    }
    setSaving(true)
    try {
      await workdayConfigApi.close(row.id, date, reason.trim())
      await onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'No se pudo cerrar la vigencia')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl dark:bg-[#0d0d0f]">
        <div>
          <h2 className="font-bold text-slate-900 dark:text-white">Cerrar vigencia</h2>
          <p className="mt-1 text-sm text-slate-500">
            Inició el {civil(row.valid_from)}. La fecha de cierre es inclusiva.
          </p>
        </div>
        <Field label="Último día de vigencia">
          <input type="date" min={String(row.valid_from).slice(0,10)} value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Motivo *">
          <input value={reason} onChange={e => setReason(e.target.value)} className={inputCls} placeholder="Cambio de turno, baja, traslado..." />
        </Field>
        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
          Esta acción conserva todo el snapshot anterior. No modifica marcaciones ni recalcula resúmenes.
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
          <button disabled={saving} className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? 'Cerrando...' : 'Cerrar vigencia'}
          </button>
        </div>
      </form>
    </div>
  )
}
