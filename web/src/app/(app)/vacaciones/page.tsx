'use client'
import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Calendar, Plane, Stethoscope, Heart, Baby, Users as UsersIcon, AlertTriangle, Plus, X, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useI18n } from '@/i18n/I18nProvider'
import { useCurrentUser } from '@/lib/useCurrentUser'

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

const TYPE_COLORS: Record<string, string> = {
  vacation:   'bg-blue-500',
  sick:       'bg-rose-500',
  personal:   'bg-amber-500',
  maternity:  'bg-pink-500',
  paternity:  'bg-cyan-500',
  other:      'bg-slate-400',
}
const TYPE_ICONS: Record<string, any> = {
  vacation: Plane, sick: Stethoscope, personal: Heart,
  maternity: Baby, paternity: Baby, other: UsersIcon,
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function dateInRange(dateStr: string, from: string, to: string) {
  return dateStr >= from && dateStr <= to
}

const PERM_TYPES = [
  { value: 'vacation',  label: 'Vacaciones' },
  { value: 'sick',      label: 'Enfermedad' },
  { value: 'personal',  label: 'Personal' },
  { value: 'maternity', label: 'Maternidad' },
  { value: 'paternity', label: 'Paternidad' },
  { value: 'other',     label: 'Otro' },
]

function SolicitarModal({ onClose, onCreated, isAdmin }: {
  onClose: () => void; onCreated: () => void; isAdmin: boolean
}) {
  const [form, setForm] = useState({ type: 'vacation', date_from: '', date_to: '', reason: '', employee_id: '' })
  const [saving, setSaving] = useState(false)
  const [ok, setOk] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { data: emps } = useQuery({
    queryKey: ['employees-mini'],
    queryFn: () => api.get('/api/employees?limit=500').then(r => r.data.data || r.data || []),
    enabled: isAdmin,
  })

  async function submit() {
    if (!form.date_from || !form.date_to) { setErr('Las fechas son requeridas'); return }
    if (form.date_to < form.date_from) { setErr('La fecha de fin debe ser posterior a la de inicio'); return }
    setSaving(true); setErr(null)
    try {
      if (isAdmin && form.employee_id) {
        await api.post('/api/permissions', {
          employee_id: parseInt(form.employee_id),
          type: form.type, date_from: form.date_from, date_to: form.date_to, reason: form.reason,
        })
      } else {
        await api.post('/api/me/permissions', { type: form.type, date_from: form.date_from, date_to: form.date_to, reason: form.reason })
      }
      setOk(true); onCreated()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al enviar solicitud')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md dark:bg-white/[0.04]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Solicitar ausencia / vacaciones</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        {ok ? (
          <div className="px-6 py-10 text-center space-y-3">
            <CheckCircle2 size={48} className="text-emerald-500 mx-auto" />
            <p className="font-semibold text-slate-800 dark:text-white/90">Solicitud enviada</p>
            <p className="text-sm text-slate-500 dark:text-white/40">Queda pendiente de aprobación por RRHH o tu supervisor.</p>
            <button onClick={onClose} className="mt-2 px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700">Cerrar</button>
          </div>
        ) : (
          <>
            <div className="px-6 py-4 space-y-3">
              {isAdmin && (
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Empleado (dejar vacío = tu propia solicitud)</label>
                  <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                    <option value="">Mi propia solicitud</option>
                    {(emps || []).map((e: any) => <option key={e.id} value={e.id}>{e.full_name} ({e.code})</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Tipo *</label>
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                  {PERM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Desde *</label>
                  <input type="date" value={form.date_from} onChange={e => setForm(f => ({ ...f, date_from: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Hasta *</label>
                  <input type="date" value={form.date_to} onChange={e => setForm(f => ({ ...f, date_to: e.target.value }))}
                    min={form.date_from}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Motivo</label>
                <textarea rows={2} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="Opcional…"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none dark:border-white/[0.08]" />
              </div>
              {err && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-2 dark:border-white/[0.06]">
              <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={submit} disabled={saving}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium">
                {saving ? 'Enviando…' : 'Solicitar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function VacacionesPage() {
  const { t } = useI18n()
  const user = useCurrentUser()
  const qc = useQueryClient()
  const now = new Date()
  const [year, setYear]     = useState(now.getFullYear())
  const [month, setMonth]   = useState(now.getMonth() + 1)
  const [deptId, setDeptId] = useState('')
  const [showSolicitar, setShowSolicitar] = useState(false)
  const isAdmin = ['admin', 'gth', 'hr', 'coordinator', 'manager', 'super_admin'].includes(user?.role || '')

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['vacation-plan', year, month, deptId],
    queryFn: () => api.get('/api/vacations/plan', { params: { year, month, deptId: deptId || undefined } }).then(r => r.data),
  })

  const numDays = daysInMonth(year, month)
  const days = Array.from({ length: numDays }, (_, i) => i + 1)
  const employees: any[] = data?.employees || []
  const holidays: any[] = data?.holidays || []
  const holidaySet = useMemo(() => new Set((holidays || []).map((h: any) => h.date.slice(0, 10))), [holidays])

  function changeMonth(delta: number) {
    let m = month + delta, y = year
    if (m > 12) { m = 1; y++ }
    if (m < 1)  { m = 12; y-- }
    setMonth(m); setYear(y)
  }

  function dayOfWeek(d: number) {
    return new Date(year, month - 1, d).getDay() // 0 = Domingo
  }

  // Detección de conflictos (>3 personas mismo día mismo depto)
  const conflicts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const emp of employees) {
      for (const r of emp.ranges) {
        const from = String(r.date_from).slice(0, 10)
        const to   = String(r.date_to).slice(0, 10)
        for (let d = 1; d <= numDays; d++) {
          const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`
          if (dateInRange(dateStr, from, to)) map[dateStr] = (map[dateStr] || 0) + 1
        }
      }
    }
    return map
  }, [employees, numDays, year, month])

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center">
            <Plane className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Plan de Vacaciones</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Vista mensual de permisos y vacaciones aprobados/pendientes</p>
          </div>
        </div>
        <button onClick={() => setShowSolicitar(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-4 py-2.5 text-sm font-medium shadow-sm">
          <Plus size={16} /> Solicitar ausencia
        </button>
      </div>
      {showSolicitar && (
        <SolicitarModal
          isAdmin={isAdmin}
          onClose={() => setShowSolicitar(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ['vacation-plan'] })}
        />
      )}

      {/* Controles */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 flex-wrap dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-1">
          <button onClick={() => changeMonth(-1)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
            <ChevronLeft size={18} />
          </button>
          <select value={month} onChange={e => setMonth(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold min-w-[140px] dark:border-white/[0.08]">
            {MESES_ES.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
          <select value={year} onChange={e => setYear(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold dark:border-white/[0.08]">
            {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => changeMonth(1)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="border-l border-slate-200 pl-3 dark:border-white/[0.08]">
          <select value={deptId} onChange={e => setDeptId(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            <option value="">{t('common.all')} {t('employees.department').toLowerCase()}</option>
            {(deptsData || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {Object.entries(TYPE_COLORS).map(([type, cls]) => (
            <div key={type} className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded ${cls}`} />
              <span className="text-slate-600 capitalize dark:text-white/60">{type === 'vacation' ? 'Vacación' : type === 'sick' ? 'Enferm.' : type === 'personal' ? 'Personal' : type === 'maternity' ? 'Mater.' : type === 'paternity' ? 'Pater.' : 'Otro'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Calendario tipo Gantt */}
      {isLoading ? (
        <div className="text-center py-12 text-slate-400 dark:text-white/30">Cargando...</div>
      ) : employees.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center text-slate-400 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
          <Calendar size={36} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">Sin permisos en {MESES_ES[month - 1]} {year}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-x-auto dark:bg-white/[0.04] dark:border-white/[0.06]">
          <table className="w-full text-xs whitespace-nowrap">
            <thead className="border-b border-slate-100 dark:border-white/[0.06]">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-slate-500 sticky left-0 bg-white z-10 min-w-[200px] dark:bg-white/[0.04] dark:text-white/40">
                  Empleado
                </th>
                {days.map(d => {
                  const dow = dayOfWeek(d)
                  const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`
                  const isWeekend = dow === 0 || dow === 6
                  const isHoliday = holidaySet.has(dateStr)
                  const c = conflicts[dateStr] || 0
                  return (
                    <th key={d} className={`text-center px-1 py-2.5 font-medium w-[26px] ${
                      isHoliday ? 'bg-red-50 text-red-600' :
                      isWeekend ? 'bg-slate-50 text-slate-400' : 'text-slate-500'
                    }`}>
                      <div>{d}</div>
                      {c >= 3 && (
                        <div className="text-[9px] text-rose-600 font-bold mt-0.5" title={`${c} personas`}>
                          ⚠
                        </div>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {employees.map((emp: any) => (
                <tr key={emp.id} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                  <td className="px-4 py-2 sticky left-0 bg-white border-r border-slate-100 dark:bg-white/[0.04] dark:border-white/[0.06]">
                    <p className="font-medium text-slate-800 text-sm dark:text-white/90">{emp.employee_name}</p>
                    <p className="text-[11px] text-slate-400 dark:text-white/30">[{emp.code}] {emp.department || '—'}</p>
                  </td>
                  {days.map(d => {
                    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`
                    const dow = dayOfWeek(d)
                    const isWeekend = dow === 0 || dow === 6
                    const isHoliday = holidaySet.has(dateStr)
                    const range = emp.ranges.find((r: any) => {
                      const from = String(r.date_from).slice(0,10)
                      const to   = String(r.date_to).slice(0,10)
                      return dateInRange(dateStr, from, to)
                    })
                    if (range) {
                      const Icon = TYPE_ICONS[range.type] || UsersIcon
                      const color = TYPE_COLORS[range.type] || 'bg-slate-400'
                      const isPending = range.status === 'pending'
                      return (
                        <td key={d} className={`p-0 relative ${isHoliday ? 'bg-red-50' : isWeekend ? 'bg-slate-50' : ''}`}>
                          <div className={`h-7 ${color} ${isPending ? 'opacity-50 border-2 border-dashed border-slate-600' : ''}`}
                            title={`${range.type} (${range.status}) — ${range.date_from} a ${range.date_to}: ${range.reason || 'sin motivo'}`}>
                            {d === parseInt(String(range.date_from).slice(8,10)) || d === 1 ? (
                              <Icon size={10} className="text-white absolute top-1.5 left-1" />
                            ) : null}
                          </div>
                        </td>
                      )
                    }
                    return (
                      <td key={d} className={`${
                        isHoliday ? 'bg-red-50' : isWeekend ? 'bg-slate-50' : ''
                      }`}>&nbsp;</td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Avisos de conflicto */}
      {Object.entries(conflicts).filter(([_, c]) => c >= 3).length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold mb-1">Posibles conflictos de cobertura</p>
            <p>Hay días con 3 o más personas con permisos solapados. Revisá la columna marcada con ⚠</p>
          </div>
        </div>
      )}
    </div>
  )
}
