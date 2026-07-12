'use client'
import { useEffect, useMemo, useState, useCallback, Fragment } from 'react'
import { CalendarRange, Plus, Save, Download, Trash2, X, Check, Clock, Layers, ClipboardCheck, AlertTriangle } from 'lucide-react'
import { api, downloadUrl } from '@/lib/api'

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

interface Branch { id: number; name: string }
interface Dept { id: number; name: string }
interface Template { id: number; name: string; start_time: string | null; end_time: string | null; break_minutes: number; color: string; active: number }
interface Schedule {
  id: number; name: string; branch_id: number | null; department_id: number | null
  year: number; month: number; weekly_target_minutes: number; status: string
  branch_name?: string; department_name?: string
}
interface CalDay { date: string; day: number; dow: string; in_month: boolean }
interface CalWeek { start: string; end: string; days: CalDay[] }
interface Assignment {
  id?: number; employee_id: number; work_date: string; segment: number
  start_time: string | null; end_time: string | null; template_id: number | null
  kind: string; note: string | null; minutes?: number
}
interface Emp { id: number; code: string; name: string; department: string; branch: string }

const KIND_LABEL: Record<string, string> = {
  work: 'Trabajo', off: 'Libre', vacation: 'Vacaciones', permiso: 'Permiso', presupuesto: 'Presupuesto',
}
const KIND_BADGE: Record<string, string> = {
  off: 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/40',
  vacation: 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  permiso: 'bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300',
  presupuesto: 'bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
}

// Minutos de un tramo "HH:MM" (cruza medianoche si fin<inicio).
function segMinutes(start?: string | null, end?: string | null): number {
  if (!start || !end) return 0
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  let d = toMin(end) - toMin(start)
  if (d < 0) d += 24 * 60
  return d > 0 ? d : 0
}
function hhmm(min: number): string {
  const h = Math.floor(min / 60), m = min % 60
  return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`
}
const cellKey = (empId: number, date: string) => `${empId}|${date}`

export default function TurneraPage() {
  const now = new Date()
  const [branches, setBranches] = useState<Branch[]>([])
  const [depts, setDepts] = useState<Dept[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])

  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [branchId, setBranchId] = useState('')
  const [deptId, setDeptId] = useState('')

  const [activeId, setActiveId] = useState<number | null>(null)
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [calendar, setCalendar] = useState<{ weeks: CalWeek[] } | null>(null)
  const [employees, setEmployees] = useState<Emp[]>([])
  const [target, setTarget] = useState(2880)
  // Mapa editable: cellKey → tramos[]
  const [cells, setCells] = useState<Record<string, Assignment[]>>({})
  const [removed, setRemoved] = useState<number[]>([])
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [editing, setEditing] = useState<{ empId: number; date: string } | null>(null)
  const [compliance, setCompliance] = useState<any | null>(null)
  const [loadingComp, setLoadingComp] = useState(false)

  useEffect(() => {
    api.get('/api/branches').then(r => setBranches(r.data || [])).catch(() => {})
    api.get('/api/employees/departments').then(r => setDepts(r.data || [])).catch(() => {})
    loadTemplates()
    loadSchedules()
  }, [])

  const loadTemplates = () => api.get('/api/shifts/templates').then(r => setTemplates(r.data || [])).catch(() => {})
  const loadSchedules = useCallback(() => {
    api.get('/api/shifts/schedules').then(r => setSchedules(r.data || [])).catch(() => {})
  }, [])

  async function createSchedule() {
    setMsg('')
    try {
      const body = { year, month, branch_id: branchId ? +branchId : null, department_id: deptId ? +deptId : null }
      const r = await api.post('/api/shifts/schedules', body)
      await loadSchedules()
      openSchedule(r.data.id)
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al crear la turnera') }
  }

  const openSchedule = useCallback(async (id: number) => {
    setLoading(true); setActiveId(id); setMsg(''); setDirty(false); setRemoved([])
    try {
      const r = await api.get(`/api/shifts/schedules/${id}`)
      setSchedule(r.data.schedule)
      setCalendar(r.data.calendar)
      setEmployees(r.data.employees || [])
      setTarget(r.data.weekly_target_minutes || 2880)
      const map: Record<string, Assignment[]> = {}
      for (const a of (r.data.assignments || []) as Assignment[]) {
        (map[cellKey(a.employee_id, a.work_date)] ||= []).push(a)
      }
      setCells(map)
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al abrir la turnera') }
    finally { setLoading(false) }
  }, [])

  async function deleteSchedule(id: number) {
    if (!confirm('¿Eliminar esta turnera y todas sus asignaciones?')) return
    await api.delete(`/api/shifts/schedules/${id}`).catch(() => {})
    if (activeId === id) { setActiveId(null); setSchedule(null); setCells({}) }
    loadSchedules()
  }

  function setCell(empId: number, date: string, segs: Assignment[]) {
    setCells(prev => {
      const key = cellKey(empId, date)
      const old = prev[key] || []
      // Al reescribir la celda eliminamos TODAS las filas previas por id y
      // reinsertamos los tramos nuevos sin id. Como el backend hace upsert por
      // (schedule, employee, date, segment), reutilizar ids al renumerar
      // tramos dejaría filas huérfanas (p. ej. un segment 2 que quedó viejo).
      const toRemove = old.map(o => o.id).filter(Boolean) as number[]
      if (toRemove.length) setRemoved(r => [...r, ...toRemove])
      const fresh = segs.map(s => ({ ...s, id: undefined }))
      const next = { ...prev }
      if (fresh.length) next[key] = fresh; else delete next[key]
      return next
    })
    setDirty(true)
  }

  async function save() {
    if (!activeId) return
    setSaving(true); setMsg('')
    try {
      const assignments: Assignment[] = []
      for (const list of Object.values(cells)) for (const a of list) assignments.push(a)
      await api.put(`/api/shifts/schedules/${activeId}/assignments`, { assignments, removed })
      setMsg('Turnera guardada.')
      setDirty(false)
      openSchedule(activeId)
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al guardar') }
    finally { setSaving(false) }
  }

  async function loadCompliance() {
    if (!activeId) return
    setLoadingComp(true); setCompliance(null)
    try {
      const r = await api.get(`/api/shifts/schedules/${activeId}/compliance`)
      setCompliance(r.data)
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al comparar') }
    finally { setLoadingComp(false) }
  }

  // Descanso por plantilla (para descontarlo igual que el backend).
  const breakOf = useMemo(
    () => Object.fromEntries(templates.map(t => [t.id, t.break_minutes || 0])) as Record<number, number>,
    [templates]
  )

  // Minutos de una celda (suma de tramos work, descontando el break de la
  // plantilla para que el control de 48 hs coincida con lo guardado/exportado).
  const cellMinutes = (empId: number, date: string) =>
    (cells[cellKey(empId, date)] || []).reduce((s, a) => {
      if (a.kind !== 'work') return s
      const brk = a.template_id ? (breakOf[a.template_id] || 0) : 0
      return s + Math.max(0, segMinutes(a.start_time, a.end_time) - brk)
    }, 0)

  // Total semanal por empleado (para la columna de control 48h).
  const weekMinutes = (empId: number, week: CalWeek) =>
    week.days.reduce((s, d) => s + cellMinutes(empId, d.date), 0)

  const monthLabel = schedule ? `${MESES[schedule.month - 1]} ${schedule.year}` : ''

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-400 to-indigo-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(139,92,246,0.5)]">
          <CalendarRange size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Turnera</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Programación de turnos con control de 48 hs semanales.</p>
        </div>
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}

      {/* Crear / seleccionar turnera */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-bold text-slate-900 dark:text-white mb-4">Nueva turnera</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <Field label="Mes">
            <select value={month} onChange={e => setMonth(+e.target.value)} className={INPUT}>
              {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Año">
            <input type="number" value={year} onChange={e => setYear(+e.target.value)} className={`${INPUT} w-24`} />
          </Field>
          <Field label="Sede">
            <select value={branchId} onChange={e => setBranchId(e.target.value)} className={INPUT}>
              <option value="">Todas</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Departamento">
            <select value={deptId} onChange={e => setDeptId(e.target.value)} className={INPUT}>
              <option value="">Todos</option>
              {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <button onClick={createSchedule} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm flex items-center gap-2">
            <Plus size={15} /> Crear turnera
          </button>
        </div>

        {schedules.length > 0 && (
          <div className="mt-5">
            <div className="text-xs font-semibold text-slate-500 mb-2 dark:text-white/40">Turneras existentes</div>
            <div className="flex flex-wrap gap-2">
              {schedules.map(s => (
                <div key={s.id} className={`group flex items-center gap-2 pl-3 pr-1 py-1.5 rounded-xl border text-sm transition-all ${activeId === s.id ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-400/10 dark:border-indigo-400/40' : 'border-slate-200 hover:border-indigo-300 dark:border-white/[0.08]'}`}>
                  <button onClick={() => openSchedule(s.id)} className="text-left">
                    <span className="font-medium text-slate-800 dark:text-white/80">{s.name}</span>
                    {s.branch_name && <span className="text-slate-400 dark:text-white/30"> · {s.branch_name}</span>}
                    {s.status === 'published' && <span className="ml-1 text-[10px] text-emerald-600 dark:text-emerald-400">●</span>}
                  </button>
                  <button onClick={() => deleteSchedule(s.id)} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-400/10"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {loading && <p className="text-slate-400 text-sm text-center py-8 dark:text-white/30">Cargando turnera...</p>}

      {/* Grilla de la turnera */}
      {schedule && calendar && !loading && (
        <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 sm:p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="font-bold text-slate-900 dark:text-white">{schedule.name}</h2>
              <p className="text-xs text-slate-400 dark:text-white/40">{monthLabel} · objetivo {hhmm(target)} hs/semana · {employees.length} empleados</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={loadCompliance} disabled={loadingComp}
                className="px-3 py-2 rounded-xl border border-slate-200 hover:border-amber-300 text-sm flex items-center gap-2 text-slate-600 dark:border-white/[0.08] dark:text-white/70">
                <ClipboardCheck size={15} /> {loadingComp ? 'Comparando...' : 'Cumplimiento'}
              </button>
              <button onClick={() => window.open(downloadUrl(`/api/shifts/schedules/${schedule.id}/export`, { format: 'xlsx' }), '_blank')}
                className="px-3 py-2 rounded-xl border border-slate-200 hover:border-emerald-300 text-sm flex items-center gap-2 text-slate-600 dark:border-white/[0.08] dark:text-white/70">
                <Download size={15} /> Excel
              </button>
              <button onClick={save} disabled={saving || !dirty}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm flex items-center gap-2">
                <Save size={15} /> {saving ? 'Guardando...' : dirty ? 'Guardar cambios' : 'Guardado'}
              </button>
            </div>
          </div>

          {employees.length === 0 ? (
            <p className="text-slate-400 text-sm py-8 text-center dark:text-white/30">No hay empleados activos para esta sede/departamento.</p>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="text-xs border-separate border-spacing-0 min-w-max">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-white dark:bg-[#171821] px-3 py-2 text-left text-slate-500 dark:text-white/40 border-b border-slate-100 dark:border-white/[0.06]">Empleado</th>
                    {calendar.weeks.map((w, wi) => (
                      <th key={wi} colSpan={8} className="text-center text-[10px] uppercase tracking-wide text-slate-400 dark:text-white/30 border-b border-l border-slate-100 dark:border-white/[0.06] px-1 py-1">
                        Semana {wi + 1}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className="sticky left-0 z-10 bg-white dark:bg-[#171821] border-b border-slate-100 dark:border-white/[0.06]"></th>
                    {calendar.weeks.map((w, wi) => (
                      <WeekHead key={wi} week={w} first={wi === 0} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.map(emp => (
                    <tr key={emp.id} className="hover:bg-slate-50/50 dark:hover:bg-white/[0.02]">
                      <td className="sticky left-0 z-10 bg-white dark:bg-[#171821] px-3 py-1.5 font-medium text-slate-700 dark:text-white/80 border-b border-slate-50 dark:border-white/[0.04] whitespace-nowrap max-w-[160px] truncate" title={emp.name}>
                        {emp.name}
                      </td>
                      {calendar.weeks.map((w, wi) => {
                        const wm = weekMinutes(emp.id, w)
                        const ok = wm >= target
                        return (
                          <WeekCells key={wi} emp={emp} week={w} first={wi === 0}
                            cells={cells} onEdit={(date) => setEditing({ empId: emp.id, date })}
                            weekMin={wm} ok={ok} />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Legend />
        </section>
      )}

      {/* Cumplimiento: turno planificado vs. asistencia real */}
      {compliance && <CompliancePanel data={compliance} onClose={() => setCompliance(null)} />}

      {/* Plantillas de turno */}
      <TemplatesPanel templates={templates} reload={loadTemplates} />

      {editing && schedule && (
        <CellEditor
          empId={editing.empId} date={editing.date}
          empName={employees.find(e => e.id === editing.empId)?.name || ''}
          segs={cells[cellKey(editing.empId, editing.date)] || []}
          templates={templates}
          onClose={() => setEditing(null)}
          onSave={(segs) => { setCell(editing.empId, editing.date, segs); setEditing(null) }}
        />
      )}

    </div>
  )
}

const INPUT = 'border border-slate-200 rounded-xl px-3 py-2 text-sm bg-transparent dark:border-white/[0.08]'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">{label}</label>
      {children}
    </div>
  )
}

const FLAG_LABEL: Record<string, string> = { late: 'Atraso', absent: 'Ausencia', unplanned: 'Sin turno', ok: 'OK' }
const FLAG_CLS: Record<string, string> = {
  late: 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  absent: 'bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
  unplanned: 'bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300',
}

function CompliancePanel({ data, onClose }: { data: any; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const emps = data.employees || []
  const tot = emps.reduce((a: any, e: any) => ({
    ausencias: a.ausencias + e.summary.ausencias,
    atrasos: a.atrasos + e.summary.atrasos,
    sin_plan: a.sin_plan + e.summary.sin_plan,
  }), { ausencias: 0, atrasos: 0, sin_plan: 0 })

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={17} className="text-amber-500" />
          <h2 className="font-bold text-slate-900 dark:text-white">Cumplimiento vs. asistencia</h2>
          <span className="text-xs text-slate-400 dark:text-white/30">tolerancia {data.tolerance_min} min</span>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] text-slate-400"><X size={16} /></button>
      </div>
      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <span className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">Ausencias: <b>{tot.ausencias}</b></span>
        <span className="px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">Atrasos: <b>{tot.atrasos}</b></span>
        <span className="px-3 py-1.5 rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">Días sin turno: <b>{tot.sin_plan}</b></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
            <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
              <th className="px-3 py-2">Empleado</th>
              <th className="px-3 py-2 text-right">Planif.</th><th className="px-3 py-2 text-right">Trab.</th>
              <th className="px-3 py-2 text-right">Ausencias</th><th className="px-3 py-2 text-right">Atrasos</th>
              <th className="px-3 py-2 text-right">Sin turno</th><th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
            {emps.map((e: any) => (
              <Fragment key={e.id}>
                <tr className="text-slate-700 dark:text-white/70">
                  <td className="px-3 py-2">{e.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.summary.planificados}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.summary.trabajados}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.summary.ausencias ? <span className="text-rose-600 dark:text-rose-400 font-semibold">{e.summary.ausencias}</span> : 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.summary.atrasos ? <span className="text-amber-600 dark:text-amber-400 font-semibold">{e.summary.atrasos}</span> : 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.summary.sin_plan || 0}</td>
                  <td className="px-3 py-2 text-right">
                    {e.days.length ? (
                      <button onClick={() => setOpen(open === e.id ? null : e.id)} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                        {open === e.id ? 'Ocultar' : 'Ver'}
                      </button>
                    ) : <span className="text-emerald-500 text-xs">✓</span>}
                  </td>
                </tr>
                {open === e.id && e.days.map((d: any, i: number) => (
                  <tr key={`${e.id}-${i}`} className="bg-slate-50/60 dark:bg-white/[0.02] text-xs text-slate-500 dark:text-white/50">
                    <td className="px-3 py-1.5 pl-8">{d.date}</td>
                    <td className="px-3 py-1.5" colSpan={2}>
                      {d.planned ? `Plan ${d.planned.start}-${d.planned.end}` : 'Sin turno'}
                      {d.actual ? ` · Marcó ${d.actual.in || '—'}-${d.actual.out || '—'}` : ' · No marcó'}
                    </td>
                    <td className="px-3 py-1.5" colSpan={4}>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${FLAG_CLS[d.flag] || ''}`}>
                        {FLAG_LABEL[d.flag]}{d.flag === 'late' ? ` +${d.late_min}m` : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {!emps.some((e: any) => e.days.length) && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2 mt-3"><Check size={16} /> Sin desvíos: todos cumplieron el turno planificado.</p>
      )}
      <p className="text-[11px] text-slate-400 dark:text-white/30 mt-3 flex items-center gap-1.5">
        <AlertTriangle size={13} /> Compara el turno de la turnera con la marcación real. Requiere asistencia procesada del período.
      </p>
    </section>
  )
}

function WeekHead({ week, first }: { week: CalWeek; first: boolean }) {
  return (
    <>
      {week.days.map((d, i) => (
        <th key={i} className={`px-1 py-1 text-center border-b border-slate-100 dark:border-white/[0.06] ${i === 0 && !first ? 'border-l' : ''} ${!d.in_month ? 'text-slate-300 dark:text-white/20' : 'text-slate-500 dark:text-white/50'}`}>
          <div className="text-[10px]">{d.dow}</div>
          <div className="font-bold">{d.day}</div>
        </th>
      ))}
      <th className="px-2 py-1 text-center text-[10px] text-slate-400 dark:text-white/30 border-b border-l border-slate-100 dark:border-white/[0.06]">Σ hs</th>
    </>
  )
}

function WeekCells({ emp, week, first, cells, onEdit, weekMin, ok }: {
  emp: Emp; week: CalWeek; first: boolean; cells: Record<string, Assignment[]>
  onEdit: (date: string) => void; weekMin: number; ok: boolean
}) {
  return (
    <>
      {week.days.map((d, i) => {
        const list = cells[cellKey(emp.id, d.date)] || []
        const work = list.filter(a => a.kind === 'work' && a.start_time)
        const special = list.find(a => a.kind !== 'work')
        return (
          <td key={i} onClick={() => onEdit(d.date)}
            className={`px-1 py-1 text-center align-top cursor-pointer border-b border-slate-50 dark:border-white/[0.04] hover:bg-indigo-50/60 dark:hover:bg-indigo-400/10 ${i === 0 && !first ? 'border-l border-slate-100 dark:border-white/[0.06]' : ''} ${!d.in_month ? 'bg-slate-50/40 dark:bg-white/[0.015]' : ''}`}>
            {work.map((a, k) => (
              <div key={k} className="text-[10px] leading-tight text-slate-700 dark:text-white/80 whitespace-nowrap">
                {a.start_time?.slice(0, 5)}-{a.end_time?.slice(0, 5)}
              </div>
            ))}
            {special && !work.length && (
              <span className={`inline-block text-[9px] px-1.5 py-0.5 rounded ${KIND_BADGE[special.kind] || ''}`}>{KIND_LABEL[special.kind]}</span>
            )}
          </td>
        )
      })}
      <td className={`px-2 py-1 text-center font-bold border-b border-l border-slate-100 dark:border-white/[0.06] ${weekMin === 0 ? 'text-slate-300 dark:text-white/20' : ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
        {weekMin ? hhmm(weekMin) : '—'}
      </td>
    </>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-4 text-[11px] text-slate-400 dark:text-white/40">
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> ≥ 48 hs (objetivo cumplido)</span>
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> &lt; 48 hs</span>
      <span>Clic en una celda para asignar turno.</span>
    </div>
  )
}

// ── Editor de celda (turno de un empleado en un día) ───────────
function CellEditor({ empId, date, empName, segs, templates, onClose, onSave }: {
  empId: number; date: string; empName: string; segs: Assignment[]; templates: Template[]
  onClose: () => void; onSave: (segs: Assignment[]) => void
}) {
  const [kind, setKind] = useState(segs[0]?.kind || 'work')
  const [rows, setRows] = useState<{ id?: number; start: string; end: string; template_id: number | null }[]>(
    segs.filter(s => s.kind === 'work').length
      ? segs.filter(s => s.kind === 'work').map(s => ({ id: s.id, start: s.start_time?.slice(0, 5) || '', end: s.end_time?.slice(0, 5) || '', template_id: s.template_id }))
      : [{ start: '', end: '', template_id: null }]
  )
  const existingId = segs[0]?.id

  const applyTemplate = (i: number, tid: number) => {
    const t = templates.find(x => x.id === tid)
    setRows(r => r.map((row, k) => k === i ? { ...row, template_id: tid, start: t?.start_time?.slice(0, 5) || row.start, end: t?.end_time?.slice(0, 5) || row.end } : row))
  }

  const totalMin = rows.reduce((s, r) => s + segMinutes(r.start, r.end), 0)

  function handleSave() {
    if (kind !== 'work') {
      onSave([{ id: existingId, employee_id: empId, work_date: date, segment: 1, start_time: null, end_time: null, template_id: null, kind, note: null }])
      return
    }
    const out: Assignment[] = rows
      .filter(r => r.start && r.end)
      .map((r, i) => ({ id: r.id, employee_id: empId, work_date: date, segment: i + 1, start_time: r.start, end_time: r.end, template_id: r.template_id, kind: 'work', note: null }))
    onSave(out)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-[#1a1b26] rounded-2xl shadow-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white">{empName}</h3>
            <p className="text-xs text-slate-400 dark:text-white/40">{date}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] text-slate-400"><X size={16} /></button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${kind === k ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/60'}`}>
              {label}
            </button>
          ))}
        </div>

        {kind === 'work' ? (
          <div className="space-y-3">
            {rows.map((row, i) => (
              <div key={i} className="rounded-xl border border-slate-200 dark:border-white/[0.08] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-400 dark:text-white/40 flex items-center gap-1"><Layers size={12} /> Tramo {i + 1}</span>
                  {rows.length > 1 && <button onClick={() => setRows(r => r.filter((_, k) => k !== i))} className="text-rose-400 hover:text-rose-600"><Trash2 size={13} /></button>}
                </div>
                <div className="flex items-center gap-2">
                  <input type="time" value={row.start} onChange={e => setRows(r => r.map((x, k) => k === i ? { ...x, start: e.target.value } : x))} className="border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-sm bg-transparent flex-1" />
                  <span className="text-slate-300">→</span>
                  <input type="time" value={row.end} onChange={e => setRows(r => r.map((x, k) => k === i ? { ...x, end: e.target.value } : x))} className="border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-sm bg-transparent flex-1" />
                </div>
                {templates.length > 0 && (
                  <select value={row.template_id || ''} onChange={e => e.target.value && applyTemplate(i, +e.target.value)}
                    className="w-full border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-xs bg-transparent text-slate-500 dark:text-white/50">
                    <option value="">Aplicar plantilla…</option>
                    {templates.filter(t => t.active).map(t => <option key={t.id} value={t.id}>{t.name} {t.start_time ? `(${t.start_time.slice(0,5)}-${t.end_time?.slice(0,5)})` : ''}</option>)}
                  </select>
                )}
              </div>
            ))}
            {rows.length < 2 && (
              <button onClick={() => setRows(r => [...r, { start: '', end: '', template_id: null }])}
                className="w-full py-2 rounded-xl border border-dashed border-slate-300 dark:border-white/[0.12] text-xs text-slate-400 hover:border-indigo-400 hover:text-indigo-500 flex items-center justify-center gap-1">
                <Plus size={13} /> Agregar tramo (turno partido)
              </button>
            )}
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-white/50 pt-1">
              <Clock size={13} /> Total del día: <span className="font-bold text-slate-700 dark:text-white/80">{hhmm(totalMin)} hs</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-white/50 py-2">Día marcado como <b>{KIND_LABEL[kind]}</b> (no computa horas).</p>
        )}

        <div className="flex gap-2 mt-5">
          <button onClick={handleSave} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium flex items-center justify-center gap-2">
            <Check size={16} /> Aplicar
          </button>
          <button onClick={() => onSave([])} className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-white/[0.08] text-sm text-slate-500 dark:text-white/60">Limpiar día</button>
        </div>
      </div>
    </div>
  )
}

// ── Panel de plantillas de turno ───────────────────────────────
function TemplatesPanel({ templates, reload }: { templates: Template[]; reload: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', start_time: '', end_time: '', break_minutes: 0, color: '#0ea5e9' })

  async function add() {
    if (!form.name) return
    await api.post('/api/shifts/templates', form).catch(() => {})
    setForm({ name: '', start_time: '', end_time: '', break_minutes: 0, color: '#0ea5e9' })
    reload()
  }
  async function del(id: number) {
    await api.delete(`/api/shifts/templates/${id}`).catch(() => {})
    reload()
  }

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <button onClick={() => setOpen(o => !o)} className="flex items-center justify-between w-full">
        <h2 className="font-bold text-slate-900 dark:text-white">Plantillas de turno</h2>
        <span className="text-xs text-slate-400 dark:text-white/40">{open ? 'Ocultar' : `${templates.length} plantillas`}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {templates.map(t => (
              <div key={t.id} className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-lg border border-slate-200 dark:border-white/[0.08] text-xs">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.color }} />
                <span className="font-medium text-slate-700 dark:text-white/80">{t.name}</span>
                {t.start_time && <span className="text-slate-400 dark:text-white/40">{t.start_time.slice(0,5)}-{t.end_time?.slice(0,5)}</span>}
                <button onClick={() => del(t.id)} className="p-0.5 text-slate-300 hover:text-rose-500"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-end pt-2 border-t border-slate-100 dark:border-white/[0.06]">
            <Field label="Nombre"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Mañana" className="border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-sm bg-transparent w-32" /></Field>
            <Field label="Inicio"><input type="time" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} className="border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-sm bg-transparent" /></Field>
            <Field label="Fin"><input type="time" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} className="border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-sm bg-transparent" /></Field>
            <Field label="Descanso (min)"><input type="number" value={form.break_minutes} onChange={e => setForm(f => ({ ...f, break_minutes: +e.target.value }))} className="border border-slate-200 dark:border-white/[0.08] rounded-lg px-2 py-1.5 text-sm bg-transparent w-20" /></Field>
            <Field label="Color"><input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} className="w-10 h-9 rounded-lg border border-slate-200 dark:border-white/[0.08] bg-transparent" /></Field>
            <button onClick={add} className="px-3 py-2 rounded-lg bg-slate-800 dark:bg-white/[0.1] text-white text-sm flex items-center gap-1"><Plus size={14} /> Agregar</button>
          </div>
        </div>
      )}
    </section>
  )
}
