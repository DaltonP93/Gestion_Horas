'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  UserCheck, Plus, X, Save, CheckCircle2, Clock, AlertCircle,
  ChevronRight, User, Calendar, FileText, RefreshCw, MoreVertical,
  LogIn, LogOut, Circle, CheckSquare
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Template {
  id: number; name: string; type: 'onboarding' | 'offboarding'
  description: string; task_count: number; active: number
}
interface TemplateTask { id: number; title: string; description: string; due_days: number; default_assignee_role: string }
interface Process {
  id: number; type: 'onboarding' | 'offboarding'; status: 'active' | 'completed' | 'cancelled'
  start_date: string; employee_name: string; employee_code: string
  department_name: string; template_name: string
  total_tasks: number; done_tasks: number; overdue_tasks: number; created_at: string
}
interface Task {
  id: number; title: string; description: string; status: 'pending' | 'in_progress' | 'done' | 'skipped'
  due_date: string; assignee_id: number | null; assignee_name: string | null
  notes: string | null; completed_at: string | null; sort_order: number
}

const TASK_STATUS = {
  pending:     { label: 'Pendiente',    color: 'bg-slate-100 text-slate-600',   icon: <Circle size={12} /> },
  in_progress: { label: 'En progreso',  color: 'bg-blue-100 text-blue-700',     icon: <RefreshCw size={12} /> },
  done:        { label: 'Hecho',        color: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 size={12} /> },
  skipped:     { label: 'Omitido',      color: 'bg-slate-100 text-slate-400',   icon: <X size={12} /> },
}

const ADMIN_ROLES = ['admin', 'gth', 'hr', 'super_admin']

// ─── ProcessDetail ───────────────────────────────────────────────────────────

function ProcessDetail({ id, onClose, onUpdated }: {
  id: number; onClose: () => void; onUpdated: () => void
}) {
  const [data, setData] = useState<(Process & { tasks: Task[] }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<any[]>([])
  const [saving, setSaving] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, ru] = await Promise.all([
        api.get(`/api/onboarding/${id}`),
        api.get('/api/users?limit=200').catch(() => ({ data: [] })),
      ])
      setData(r.data.data)
      setUsers(ru.data?.data || ru.data || [])
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function updateTask(taskId: number, patch: Record<string, any>) {
    setSaving(taskId)
    try {
      await api.patch(`/api/onboarding/tasks/${taskId}`, patch)
      await load(); onUpdated()
    } finally { setSaving(null) }
  }

  async function closeProcess(action: 'complete' | 'cancel') {
    await api.post(`/api/onboarding/${id}/${action}`)
    onUpdated(); onClose()
  }

  if (loading || !data) return (
    <div className="flex items-center justify-center h-48 text-slate-400 text-sm dark:text-white/30">Cargando…</div>
  )

  const progress = data.total_tasks > 0 ? Math.round((data.done_tasks / data.total_tasks) * 100) : 0
  const typeIcon = data.type === 'onboarding' ? <LogIn size={16} className="text-emerald-600" /> : <LogOut size={16} className="text-rose-500" />
  const typeLabel = data.type === 'onboarding' ? 'Onboarding' : 'Offboarding'

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            {typeIcon}
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{data.employee_name}</h2>
          </div>
          <p className="text-sm text-slate-500 dark:text-white/40">{typeLabel} · {data.template_name}</p>
          <p className="text-xs text-slate-400 mt-0.5 dark:text-white/30">Inicio: {data.start_date} · {data.department_name}</p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg shrink-0 dark:hover:bg-white/[0.06]">
          <X size={18} className="text-slate-400 dark:text-white/30" />
        </button>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1 dark:text-white/40">
          <span>{data.done_tasks}/{data.total_tasks} tareas completadas</span>
          <span className="font-semibold">{progress}%</span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden dark:bg-white/[0.06]">
          <div className="h-full bg-emerald-500 rounded-full transition-all duration-500"
               style={{ width: `${progress}%` }} />
        </div>
        {data.overdue_tasks > 0 && (
          <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
            <AlertCircle size={11} /> {data.overdue_tasks} tarea{data.overdue_tasks !== 1 ? 's' : ''} vencida{data.overdue_tasks !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* Tasks */}
      <div className="space-y-2">
        {data.tasks.map(task => {
          const si = TASK_STATUS[task.status]
          const isOverdue = task.status === 'pending' && task.due_date && new Date(task.due_date) < new Date()
          return (
            <div key={task.id}
              className={`rounded-xl border p-3 space-y-2 transition-colors
                ${task.status === 'done' ? 'bg-emerald-50 border-emerald-100' :
                  isOverdue ? 'bg-red-50 border-red-100' : 'bg-white border-slate-200'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${task.status === 'done' ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                    {task.title}
                  </p>
                  {task.description && <p className="text-xs text-slate-500 mt-0.5 dark:text-white/40">{task.description}</p>}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${si.color}`}>
                      {si.icon} {si.label}
                    </span>
                    {task.due_date && (
                      <span className={`text-[10px] flex items-center gap-1 ${isOverdue ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
                        <Calendar size={10} /> {task.due_date}
                      </span>
                    )}
                    {task.assignee_name && (
                      <span className="text-[10px] text-slate-400 flex items-center gap-1 dark:text-white/30">
                        <User size={10} /> {task.assignee_name}
                      </span>
                    )}
                  </div>
                </div>
                {/* Quick action buttons */}
                {data.status === 'active' && task.status !== 'done' && (
                  <div className="flex gap-1 shrink-0">
                    {task.status === 'pending' && (
                      <button onClick={() => updateTask(task.id, { status: 'in_progress' })}
                        disabled={saving === task.id}
                        title="Marcar en progreso"
                        className="p-1.5 hover:bg-blue-50 text-blue-500 rounded-lg disabled:opacity-40">
                        <RefreshCw size={14} />
                      </button>
                    )}
                    <button onClick={() => updateTask(task.id, { status: 'done' })}
                      disabled={saving === task.id}
                      title="Marcar hecho"
                      className="p-1.5 hover:bg-emerald-50 text-emerald-600 rounded-lg disabled:opacity-40">
                      {saving === task.id ? <RefreshCw size={14} className="animate-spin" /> : <CheckSquare size={14} />}
                    </button>
                    <button onClick={() => updateTask(task.id, { status: 'skipped' })}
                      disabled={saving === task.id}
                      title="Omitir"
                      className="p-1.5 hover:bg-slate-50 text-slate-400 rounded-lg disabled:opacity-40 dark:text-white/30 dark:hover:bg-white/[0.04]">
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>
              {/* Assignee selector */}
              {data.status === 'active' && task.status !== 'done' && (
                <select
                  value={task.assignee_id || ''}
                  onChange={e => updateTask(task.id, { assignee_id: e.target.value || null })}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-600 dark:text-white/60 dark:border-white/[0.08]">
                  <option value="">Sin responsable asignado</option>
                  {users.map((u: any) => (
                    <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                  ))}
                </select>
              )}
            </div>
          )
        })}
      </div>

      {/* Process actions */}
      {data.status === 'active' && (
        <div className="flex gap-2 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
          <button onClick={() => closeProcess('complete')}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2 text-sm font-medium flex items-center justify-center gap-1.5">
            <CheckCircle2 size={15} /> Cerrar proceso
          </button>
          <button onClick={() => closeProcess('cancel')}
            className="flex-1 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl py-2 text-sm font-medium flex items-center justify-center gap-1.5 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            <X size={15} /> Cancelar
          </button>
        </div>
      )}
    </div>
  )
}

// ─── TemplateModal ───────────────────────────────────────────────────────────

function TemplateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', type: 'onboarding' as 'onboarding' | 'offboarding', description: '' })
  const [tasks, setTasks] = useState([{ title: '', description: '', default_assignee_role: '', due_days: 3 }])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    const validTasks = tasks.filter(t => t.title.trim())
    if (!form.name) { setErr('El nombre es requerido'); return }
    if (!validTasks.length) { setErr('Se requiere al menos una tarea'); return }
    setSaving(true); setErr(null)
    try {
      await api.post('/api/onboarding/templates', { ...form, tasks: validTasks })
      onCreated(); onClose()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  function addTask() { setTasks(t => [...t, { title: '', description: '', default_assignee_role: '', due_days: 3 }]) }
  function removeTask(i: number) { setTasks(t => t.filter((_, idx) => idx !== i)) }
  function updateTask(i: number, field: string, value: any) {
    setTasks(t => t.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col dark:bg-white/[0.04]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Nuevo template de checklist</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Nombre *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ej: Onboarding estándar"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Tipo</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                <option value="onboarding">Onboarding</option>
                <option value="offboarding">Offboarding</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Descripción</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide dark:text-white/60">Tareas del checklist</p>
              <button onClick={addTask} className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1">
                <Plus size={13} /> Agregar tarea
              </button>
            </div>
            <div className="space-y-2">
              {tasks.map((task, i) => (
                <div key={i} className="bg-slate-50 rounded-xl p-3 space-y-2 dark:bg-white/[0.03]">
                  <div className="flex items-center gap-2">
                    <input value={task.title} onChange={e => updateTask(i, 'title', e.target.value)}
                      placeholder={`Tarea ${i + 1} *`}
                      className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]" />
                    {tasks.length > 1 && (
                      <button onClick={() => removeTask(i)} className="p-1 hover:bg-red-50 text-red-400 rounded-lg">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={task.default_assignee_role} onChange={e => updateTask(i, 'default_assignee_role', e.target.value)}
                      placeholder="Rol responsable (IT, HR…)"
                      className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white dark:bg-white/[0.04] dark:border-white/[0.08]" />
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-500 shrink-0 dark:text-white/40">Vence en</span>
                      <input type="number" min={1} value={task.due_days}
                        onChange={e => updateTask(i, 'due_days', parseInt(e.target.value))}
                        className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white text-center dark:bg-white/[0.04] dark:border-white/[0.08]" />
                      <span className="text-xs text-slate-500 shrink-0 dark:text-white/40">días</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2 text-sm flex items-center gap-2">
              <AlertCircle size={14} /> {err}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 dark:border-white/[0.06]">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2">
            <Save size={14} /> {saving ? 'Guardando…' : 'Crear template'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NewProcessModal ──────────────────────────────────────────────────────────

function NewProcessModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [employees, setEmployees] = useState<any[]>([])
  const [form, setForm] = useState({ template_id: '', employee_id: '', start_date: new Date().toISOString().split('T')[0] })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.get('/api/onboarding/templates').then(r => setTemplates(r.data.data || []))
    api.get('/api/employees?limit=500').then(r => setEmployees(r.data.data || r.data || []))
  }, [])

  async function submit() {
    if (!form.template_id || !form.employee_id || !form.start_date) {
      setErr('Todos los campos son requeridos'); return
    }
    setSaving(true); setErr(null)
    try {
      await api.post('/api/onboarding', {
        template_id: parseInt(form.template_id),
        employee_id: parseInt(form.employee_id),
        start_date: form.start_date,
      })
      onCreated(); onClose()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al crear')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md dark:bg-white/[0.04]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Iniciar proceso</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Template *</label>
            <select value={form.template_id} onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">Seleccionar…</option>
              <optgroup label="Onboarding">
                {templates.filter(t => t.type === 'onboarding').map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.task_count} tareas)</option>
                ))}
              </optgroup>
              <optgroup label="Offboarding">
                {templates.filter(t => t.type === 'offboarding').map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.task_count} tareas)</option>
                ))}
              </optgroup>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Empleado *</label>
            <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">Seleccionar empleado…</option>
              {employees.map((e: any) => (
                <option key={e.id} value={e.id}>{e.full_name} ({e.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Fecha de inicio *</label>
            <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          </div>
          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2 text-sm flex items-center gap-2">
              <AlertCircle size={14} /> {err}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 dark:border-white/[0.06]">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2">
            <Plus size={14} /> {saving ? 'Iniciando…' : 'Iniciar proceso'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const user = useCurrentUser()
  const [processes, setProcesses] = useState<Process[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'active' | 'completed' | 'templates'>('active')
  const [typeFilter, setTypeFilter] = useState<'' | 'onboarding' | 'offboarding'>('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNewProcess, setShowNewProcess]   = useState(false)
  const [showNewTemplate, setShowNewTemplate] = useState(false)

  const isAdmin = ADMIN_ROLES.includes(user?.role || '')

  const loadProcesses = useCallback(async () => {
    setLoading(true)
    try {
      const status = tab === 'active' ? 'active' : tab === 'completed' ? 'completed' : null
      if (!status) return
      const params = new URLSearchParams({ status })
      if (typeFilter) params.set('type', typeFilter)
      const res = await api.get(`/api/onboarding?${params}`)
      setProcesses(res.data.data || [])
    } finally { setLoading(false) }
  }, [tab, typeFilter])

  const loadTemplates = useCallback(async () => {
    const res = await api.get('/api/onboarding/templates?all=1')
    setTemplates(res.data.data || [])
  }, [])

  useEffect(() => {
    if (tab !== 'templates') loadProcesses()
    else loadTemplates()
  }, [tab, typeFilter, loadProcesses, loadTemplates])

  const onboarding = processes.filter(p => p.type === 'onboarding')
  const offboarding = processes.filter(p => p.type === 'offboarding')
  const totalOverdue = processes.reduce((acc, p) => acc + (p.overdue_tasks || 0), 0)

  async function toggleTemplate(id: number, active: number) {
    await api.put(`/api/onboarding/templates/${id}`, { active: active ? 0 : 1 })
    loadTemplates()
  }

  function ProcessCard({ p }: { p: Process }) {
    const pct = p.total_tasks > 0 ? Math.round((p.done_tasks / p.total_tasks) * 100) : 0
    const isOver = (p.overdue_tasks || 0) > 0
    return (
      <button onClick={() => setSelectedId(p.id)}
        className={`w-full text-left p-4 rounded-2xl border transition-all hover:shadow-sm
          ${selectedId === p.id ? 'ring-2 ring-blue-400' : ''}
          ${p.type === 'onboarding' ? 'border-emerald-100 bg-emerald-50/50' : 'border-rose-100 bg-rose-50/50'}`}>
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <p className="font-semibold text-slate-800 text-sm dark:text-white/90">{p.employee_name}</p>
            <p className="text-xs text-slate-500 dark:text-white/40">{p.template_name}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium
              ${p.type === 'onboarding' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
              {p.type === 'onboarding' ? <LogIn size={10} /> : <LogOut size={10} />}
              {p.type === 'onboarding' ? 'Onboarding' : 'Offboarding'}
            </span>
            {isOver && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-600">
                <AlertCircle size={10} /> {p.overdue_tasks} vencida{p.overdue_tasks !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-white/40">
            <span>{p.done_tasks}/{p.total_tasks} tareas</span>
            <span className="font-semibold">{pct}%</span>
          </div>
          <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${isOver ? 'bg-amber-500' : 'bg-emerald-500'}`}
                 style={{ width: `${pct}%` }} />
          </div>
        </div>
        <p className="text-[10px] text-slate-400 mt-1.5 dark:text-white/30">Inicio: {p.start_date} · {p.department_name}</p>
      </button>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2 dark:text-white">
            <UserCheck className="text-blue-600" size={24} /> Onboarding & Offboarding
          </h1>
          <p className="text-sm text-slate-500 mt-0.5 dark:text-white/40">Checklists de incorporación y baja de empleados.</p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <button onClick={() => setShowNewTemplate(true)}
              className="flex items-center gap-1.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl px-4 py-2 text-sm font-medium dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <FileText size={16} /> Nuevo template
            </button>
            <button onClick={() => setShowNewProcess(true)}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-4 py-2 text-sm font-medium">
              <Plus size={16} /> Iniciar proceso
            </button>
          </div>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
          <p className="text-2xl font-bold text-emerald-700">{onboarding.length}</p>
          <p className="text-xs text-emerald-600 flex items-center gap-1 mt-0.5"><LogIn size={11} /> Onboardings activos</p>
        </div>
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-3">
          <p className="text-2xl font-bold text-rose-600">{offboarding.length}</p>
          <p className="text-xs text-rose-500 flex items-center gap-1 mt-0.5"><LogOut size={11} /> Offboardings activos</p>
        </div>
        <div className={`rounded-xl p-3 border ${totalOverdue > 0 ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'}`}>
          <p className={`text-2xl font-bold ${totalOverdue > 0 ? 'text-red-600' : 'text-slate-700'}`}>{totalOverdue}</p>
          <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5 dark:text-white/40"><AlertCircle size={11} /> Tareas vencidas</p>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
          <p className="text-2xl font-bold text-blue-700">{templates.length}</p>
          <p className="text-xs text-blue-600 flex items-center gap-1 mt-0.5"><FileText size={11} /> Templates</p>
        </div>
      </div>

      {/* Tabs + filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl dark:bg-white/[0.06]">
          {(['active', 'completed', 'templates'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setSelectedId(null) }}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
                ${tab === t ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {t === 'active' ? 'Activos' : t === 'completed' ? 'Completados' : 'Templates'}
            </button>
          ))}
        </div>
        {tab !== 'templates' && (
          <div className="flex gap-1">
            {(['', 'onboarding', 'offboarding'] as const).map(f => (
              <button key={f} onClick={() => setTypeFilter(f)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors
                  ${typeFilter === f
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                {f === '' ? 'Todos' : f === 'onboarding' ? 'Onboarding' : 'Offboarding'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex gap-5 items-start">
        <div className={`flex-1 min-w-0 ${selectedId ? 'hidden lg:block' : ''}`}>
          {tab === 'templates' ? (
            <div className="bg-white rounded-2xl shadow border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
                <p className="text-sm font-semibold text-slate-700 dark:text-white/80">{templates.length} templates</p>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3.5">
                    <span className={`p-1.5 rounded-lg ${t.type === 'onboarding' ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-500'}`}>
                      {t.type === 'onboarding' ? <LogIn size={14} /> : <LogOut size={14} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`font-medium text-sm ${t.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{t.name}</p>
                      <p className="text-xs text-slate-500 dark:text-white/40">{t.task_count} tareas · {t.type === 'onboarding' ? 'Onboarding' : 'Offboarding'}</p>
                    </div>
                    {isAdmin && (
                      <button onClick={() => toggleTemplate(t.id, t.active)}
                        className={`text-xs px-3 py-1 rounded-full font-medium border transition-colors
                          ${t.active ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                        {t.active ? 'Activo' : 'Inactivo'}
                      </button>
                    )}
                  </div>
                ))}
                {templates.length === 0 && (
                  <p className="text-center py-12 text-sm text-slate-400 dark:text-white/30">Sin templates</p>
                )}
              </div>
            </div>
          ) : loading ? (
            <div className="text-center py-12 text-slate-400 text-sm dark:text-white/30">Cargando…</div>
          ) : processes.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-sm dark:text-white/30">
              Sin procesos {tab === 'active' ? 'activos' : 'completados'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {processes.map(p => <ProcessCard key={p.id} p={p} />)}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedId && (
          <div className="w-full lg:w-[480px] shrink-0 bg-white rounded-2xl shadow border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <ProcessDetail
              id={selectedId}
              onClose={() => setSelectedId(null)}
              onUpdated={loadProcesses}
            />
          </div>
        )}
      </div>

      {showNewProcess  && <NewProcessModal  onClose={() => setShowNewProcess(false)}  onCreated={loadProcesses} />}
      {showNewTemplate && <TemplateModal     onClose={() => setShowNewTemplate(false)} onCreated={loadTemplates} />}
    </div>
  )
}
