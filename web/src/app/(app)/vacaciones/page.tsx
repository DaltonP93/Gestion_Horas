'use client'
import { useState, useMemo, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Calendar, Plane, Stethoscope, Heart, Baby, Users as UsersIcon, AlertTriangle, Plus, X, CheckCircle2, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { downloadCsv } from '@/lib/csvExport'
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
  const [tab, setTab] = useState<'plan' | 'saldos' | 'politica'>('plan')
  const isAdmin = ['admin', 'gth', 'hr', 'coordinator', 'manager', 'super_admin'].includes(user?.role || '')
  const canManagePolicy = ['admin', 'gth', 'hr', 'super_admin'].includes(user?.role || '')

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

      {/* Pestañas */}
      {isAdmin && (
        <div className="flex items-center gap-1 border-b border-slate-100 dark:border-white/[0.06]">
          {([['plan', 'Plan mensual'], ['saldos', 'Saldos'], ...(canManagePolicy ? [['politica', 'Política']] : [])] as [string, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k as any)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === k ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-white/40 dark:hover:text-white/70'}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'saldos' && isAdmin && <SaldosTab deptsData={deptsData} canManage={canManagePolicy} />}
      {tab === 'politica' && canManagePolicy && <PoliticaTab />}

      {tab === 'plan' && (<>
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
      </>)}
    </div>
  )
}

// ─── Pestaña: Saldos por empleado y año ──────────────────────────
function SaldosTab({ deptsData, canManage }: { deptsData: any; canManage: boolean }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [deptId, setDeptId] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [dayType, setDayType] = useState('habiles')
  const [loading, setLoading] = useState(false)
  const [edit, setEdit] = useState<any | null>(null)
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/vacations/balances', { params: { year, deptId: deptId || undefined } })
      setRows(r.data?.data || []); setDayType(r.data?.day_type || 'habiles')
    } catch { setRows([]) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [year, deptId]) // eslint-disable-line react-hooks/exhaustive-deps

  function exportCsv() {
    if (!rows.length) return
    downloadCsv(
      `vacaciones-saldos_${year}.csv`,
      ['Código', 'Empleado', 'Departamento', 'Antigüedad (años)', 'Derecho', 'Asignado', 'Ajuste', 'Tomado', 'Disponible', 'Conteo'],
      rows.map(r => [r.code, r.name, r.department || '', r.antiguedad_years, r.entitlement, r.assigned, r.adjustment || 0, r.taken, r.available, dayType === 'corridos' ? 'corridos' : 'hábiles']),
    )
  }

  async function saveBalance() {
    if (!edit) return
    try {
      await api.put('/api/vacations/balances', {
        employee_id: edit.employee_id, year,
        assigned: edit.assignedInput === '' ? null : parseInt(edit.assignedInput, 10),
        adjustment: parseInt(edit.adjustmentInput || '0', 10) || 0,
        note: edit.noteInput || null,
      })
      setMsg('Saldo actualizado.'); setEdit(null); load()
    } catch { setMsg('No se pudo guardar el saldo.') }
  }

  return (
    <div className="space-y-4">
      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-2.5 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 flex-wrap dark:bg-white/[0.04] dark:border-white/[0.06]">
        <select value={year} onChange={e => setYear(+e.target.value)}
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold dark:border-white/[0.08] bg-transparent">
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={deptId} onChange={e => setDeptId(e.target.value)}
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
          <option value="">Todos los departamentos</option>
          {(deptsData || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={exportCsv} disabled={!rows.length}
          className="px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm flex items-center gap-2 disabled:opacity-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">
          <Download size={15} /> Exportar CSV
        </button>
        <span className="text-xs text-slate-400 dark:text-white/30 ml-auto">Conteo: días {dayType === 'corridos' ? 'corridos' : 'hábiles'}</span>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-x-auto dark:bg-white/[0.04] dark:border-white/[0.06]">
        {loading ? (
          <p className="text-slate-400 text-sm py-8 text-center dark:text-white/30">Cargando...</p>
        ) : rows.length === 0 ? (
          <p className="text-slate-400 text-sm py-8 text-center dark:text-white/30">Sin empleados.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                <th className="px-3 py-2">Empleado</th><th className="px-3 py-2 text-right">Antig.</th>
                <th className="px-3 py-2 text-right">Derecho</th><th className="px-3 py-2 text-right">Asignado</th>
                <th className="px-3 py-2 text-right">Ajuste</th><th className="px-3 py-2 text-right">Tomado</th>
                <th className="px-3 py-2 text-right">Disponible</th>{canManage && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {rows.map(r => (
                <tr key={r.employee_id} className="text-slate-700 dark:text-white/70">
                  <td className="px-3 py-2"><span className="font-mono text-xs text-slate-400">{r.code}</span> {r.name}<div className="text-[11px] text-slate-400">{r.department || '—'}</div></td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.antiguedad_years}a</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{r.entitlement}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{r.assigned}{r.overridden && <span className="text-[10px] text-amber-500 ml-1" title="Sobrescrito por RRHH">✎</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.adjustment ? (r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.taken}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${r.available < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>{r.available}</td>
                  {canManage && (
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setEdit({ ...r, assignedInput: r.overridden ? String(r.assigned) : '', adjustmentInput: String(r.adjustment || 0), noteInput: r.note || '' })}
                        className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 hover:border-blue-300 text-slate-600 dark:border-white/[0.08] dark:text-white/70">Asignar</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {edit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
              <h3 className="font-bold text-slate-900 dark:text-white">Saldo · {edit.name} · {year}</h3>
              <button onClick={() => setEdit(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-3">
              <p className="text-xs text-slate-500 dark:text-white/40">Derecho por antigüedad: <b>{edit.entitlement}</b> días. Dejá &quot;Asignado&quot; vacío para usar el derecho.</p>
              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-white/40 block mb-1">Días asignados (override)</label>
                <input type="number" value={edit.assignedInput} placeholder={`${edit.entitlement} (derecho)`}
                  onChange={e => setEdit((s: any) => ({ ...s, assignedInput: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-white/40 block mb-1">Ajuste (+/−)</label>
                <input type="number" value={edit.adjustmentInput}
                  onChange={e => setEdit((s: any) => ({ ...s, adjustmentInput: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 dark:text-white/40 block mb-1">Nota</label>
                <input value={edit.noteInput} onChange={e => setEdit((s: any) => ({ ...s, noteInput: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 dark:border-white/[0.06] flex gap-2">
              <button onClick={() => setEdit(null)} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={saveBalance} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-medium">Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Pestaña: Política de vacaciones (tramos por antigüedad) ─────
function PoliticaTab() {
  const [brackets, setBrackets] = useState<any[]>([])
  const [dayType, setDayType] = useState('habiles')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/vacations/policy')
      setBrackets((r.data?.brackets || []).map((b: any) => ({ ...b })))
      setDayType(r.data?.day_type || 'habiles')
    } catch { setBrackets([]) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const upd = (i: number, patch: any) => setBrackets(bs => bs.map((b, idx) => idx === i ? { ...b, ...patch } : b))
  const addRow = () => setBrackets(bs => [...bs, { min_years: 0, max_years: '', days: 0, active: true }])
  const removeRow = (i: number) => setBrackets(bs => bs.filter((_, idx) => idx !== i))

  async function save() {
    setSaving(true); setMsg('')
    try {
      await api.put('/api/vacations/policy', {
        day_type: dayType,
        brackets: brackets.map(b => ({
          min_years: parseInt(b.min_years, 10) || 0,
          max_years: b.max_years === '' || b.max_years == null ? null : parseInt(b.max_years, 10),
          days: parseInt(b.days, 10) || 0,
          active: b.active !== false,
        })),
      })
      setMsg('Política guardada.'); load()
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al guardar') } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-2.5 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06] space-y-4">
        <div>
          <h2 className="font-bold text-slate-900 dark:text-white mb-1">Días por antigüedad</h2>
          <p className="text-xs text-slate-400 dark:text-white/30">Definí cuántos días de vacaciones corresponden según los años de servicio. Dejá &quot;Hasta&quot; vacío para el último tramo (sin tope).</p>
        </div>
        {loading ? <p className="text-slate-400 text-sm py-4 text-center dark:text-white/30">Cargando...</p> : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-2 text-[11px] font-semibold text-slate-400 uppercase dark:text-white/30 px-1">
              <span>Desde (años)</span><span>Hasta (años)</span><span>Días</span><span>Activo</span><span></span>
            </div>
            {brackets.map((b, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-2 items-center">
                <input type="number" min={0} value={b.min_years} onChange={e => upd(i, { min_years: e.target.value })}
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent" />
                <input type="number" min={0} value={b.max_years ?? ''} placeholder="sin tope" onChange={e => upd(i, { max_years: e.target.value })}
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent" />
                <input type="number" min={0} value={b.days} onChange={e => upd(i, { days: e.target.value })}
                  className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent" />
                <input type="checkbox" checked={b.active !== false} onChange={e => upd(i, { active: e.target.checked })} className="h-4 w-4 accent-blue-600 mx-auto" />
                <button onClick={() => removeRow(i)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600"><X size={15} /></button>
              </div>
            ))}
            <button onClick={addRow} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 hover:border-blue-300 text-slate-600 dark:border-white/[0.08] dark:text-white/70 flex items-center gap-1 mt-1"><Plus size={13} /> Tramo</button>
          </div>
        )}
        <div className="pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center gap-3 flex-wrap">
          <div>
            <label className="text-xs font-semibold text-slate-500 dark:text-white/40 block mb-1">Conteo de días</label>
            <select value={dayType} onChange={e => setDayType(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
              <option value="habiles">Días hábiles (excluye fines de semana y feriados)</option>
              <option value="corridos">Días corridos</option>
            </select>
          </div>
          <button onClick={save} disabled={saving} className="ml-auto px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-50 self-end">
            {saving ? 'Guardando...' : 'Guardar política'}
          </button>
        </div>
      </div>
    </div>
  )
}
