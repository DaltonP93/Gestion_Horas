'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  GraduationCap, Plus, X, Send, ExternalLink, CheckCircle2, Clock, AlertCircle,
  BookOpen, Users, Calendar, Award, Trash2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'

const CATEGORY_COLORS: Record<string, string> = {
  seguridad: 'bg-rose-100 text-rose-700',
  compliance: 'bg-blue-100 text-blue-700',
  onboarding: 'bg-emerald-100 text-emerald-700',
  tecnico:    'bg-violet-100 text-violet-700',
  otro:       'bg-slate-100 text-slate-700',
}

export default function CapacitacionesPage() {
  const qc = useQueryClient()
  const user = useCurrentUser()
  const isAdmin = ['admin', 'gth', 'hr', 'super_admin'].includes(user?.role || '')
  const isEmployee = user?.role === 'employee'

  const [tab, setTab] = useState<'catalog' | 'mine'>(isEmployee ? 'mine' : 'catalog')
  const [showForm, setShowForm] = useState(false)
  const [showAssign, setShowAssign] = useState<any>(null)
  const [showProgress, setShowProgress] = useState<any>(null)
  const [form, setForm] = useState<any>({
    title: '', description: '', category: '', duration_hours: '',
    mandatory: 0, valid_until: '', resource_url: '',
  })
  const [assignForm, setAssignForm] = useState<any>({ mode: 'all', department_id: '', due_date: '' })

  const { data: catalog } = useQuery<any>({
    queryKey: ['courses-catalog'],
    queryFn: () => api.get('/api/courses').then(r => r.data),
    enabled: tab === 'catalog',
  })

  const { data: mine } = useQuery<any>({
    queryKey: ['courses-my'],
    queryFn: () => api.get('/api/courses/my').then(r => r.data),
    enabled: tab === 'mine',
  })

  const { data: depts } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const { data: progress } = useQuery<any>({
    queryKey: ['course-progress', showProgress?.id],
    queryFn: () => api.get(`/api/courses/${showProgress.id}/progress`).then(r => r.data),
    enabled: !!showProgress,
  })

  async function createCourse() {
    if (!form.title) return alert('Título es requerido')
    try {
      await api.post('/api/courses', form)
      qc.invalidateQueries({ queryKey: ['courses-catalog'] })
      setShowForm(false)
      setForm({ title: '', description: '', category: '', duration_hours: '', mandatory: 0, valid_until: '', resource_url: '' })
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    }
  }

  async function deleteCourse(id: number) {
    if (!confirm('¿Desactivar este curso?')) return
    await api.delete(`/api/courses/${id}`)
    qc.invalidateQueries({ queryKey: ['courses-catalog'] })
  }

  async function assignCourse() {
    try {
      const r = await api.post(`/api/courses/${showAssign.id}/assign`, assignForm)
      alert(`✅ ${r.data.inserted} asignación(es) nueva(s), ${r.data.skipped} ya existían`)
      qc.invalidateQueries({ queryKey: ['courses-catalog'] })
      setShowAssign(null)
      setAssignForm({ mode: 'all', department_id: '', due_date: '' })
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error al asignar')
    }
  }

  async function completeMyCourse(assignmentId: number) {
    if (!confirm('¿Marcar este curso como completado?')) return
    try {
      await api.post(`/api/courses/assignments/${assignmentId}/complete`, {})
      qc.invalidateQueries({ queryKey: ['courses-my'] })
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
            <GraduationCap className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Capacitaciones</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Cursos asignados, catálogo y seguimiento de completitud</p>
          </div>
        </div>
        {isAdmin && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium">
            <Plus size={14} /> Nuevo curso
          </button>
        )}
      </div>

      {!isEmployee && (
        <div className="flex bg-slate-100 rounded-xl p-1 w-fit dark:bg-white/[0.06]">
          <button onClick={() => setTab('catalog')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'catalog' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'
            }`}>Catálogo</button>
          <button onClick={() => setTab('mine')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'mine' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'
            }`}>Mis cursos</button>
        </div>
      )}

      {tab === 'catalog' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(catalog?.data || []).map((c: any) => {
            const completion = c.total_assigned > 0 ? Math.round((c.total_completed / c.total_assigned) * 100) : 0
            return (
              <div key={c.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex flex-col dark:bg-white/[0.04] dark:border-white/[0.06]">
                <div className="flex items-start justify-between mb-2">
                  {c.category && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[c.category] || CATEGORY_COLORS.otro}`}>
                      {c.category}
                    </span>
                  )}
                  {c.mandatory ? (
                    <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full font-medium">Obligatorio</span>
                  ) : null}
                </div>
                <h3 className="font-bold text-slate-900 mb-1 dark:text-white">{c.title}</h3>
                <p className="text-sm text-slate-500 mb-3 line-clamp-2 flex-1 dark:text-white/40">{c.description || '—'}</p>
                <div className="flex items-center gap-3 text-xs text-slate-400 mb-3 dark:text-white/30">
                  {c.duration_hours && <span className="flex items-center gap-1"><Clock size={11} /> {c.duration_hours}h</span>}
                  {c.valid_until && <span className="flex items-center gap-1"><Calendar size={11} /> Válido hasta {format(new Date(c.valid_until), 'd MMM yyyy', { locale: es })}</span>}
                </div>
                <div className="bg-slate-50 rounded-lg p-2.5 mb-3 dark:bg-white/[0.03]">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-600 flex items-center gap-1 dark:text-white/60"><Users size={11} /> {c.total_completed}/{c.total_assigned} completados</span>
                    <span className="font-bold text-slate-700 dark:text-white/80">{completion}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 transition-all" style={{ width: `${completion}%` }} />
                  </div>
                </div>
                <div className="flex gap-2">
                  {c.resource_url && (
                    <a href={c.resource_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-violet-600 hover:bg-violet-50 px-2.5 py-1.5 rounded-lg text-xs font-medium">
                      <ExternalLink size={12} /> Recurso
                    </a>
                  )}
                  {isAdmin && (
                    <>
                      <button onClick={() => setShowAssign(c)}
                        className="flex items-center gap-1 bg-violet-600 hover:bg-violet-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium ml-auto">
                        <Send size={12} /> Asignar
                      </button>
                      <button onClick={() => setShowProgress(c)}
                        className="flex items-center gap-1 border border-slate-200 hover:bg-slate-50 text-slate-700 px-2.5 py-1.5 rounded-lg text-xs font-medium dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                        <BookOpen size={12} /> Progreso
                      </button>
                      <button onClick={() => deleteCourse(c.id)}
                        className="text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg">
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {(catalog?.data || []).length === 0 && (
            <div className="col-span-full text-center py-12 text-slate-400 bg-white rounded-2xl border border-slate-100 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
              <BookOpen size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">Sin cursos en el catálogo</p>
            </div>
          )}
        </div>
      )}

      {tab === 'mine' && (
        <div className="space-y-3">
          {(mine?.data || []).map((c: any) => {
            const completed = !!c.completed_at
            const overdue = c.due_date && !completed && new Date(c.due_date) < new Date()
            return (
              <div key={c.assignment_id} className={`bg-white rounded-2xl border shadow-sm p-5 ${
                completed ? 'border-emerald-200' : overdue ? 'border-rose-200' : 'border-slate-100'
              }`}>
                <div className="flex items-start gap-4">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                    completed ? 'bg-emerald-100 text-emerald-600' :
                    overdue   ? 'bg-rose-100 text-rose-600' :
                                'bg-slate-100 text-slate-500'
                  }`}>
                    {completed ? <CheckCircle2 size={22} /> : overdue ? <AlertCircle size={22} /> : <BookOpen size={22} />}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-slate-900 dark:text-white">{c.title}</h3>
                      {c.mandatory ? <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">Obligatorio</span> : null}
                      {completed && <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1"><CheckCircle2 size={11} /> Completado</span>}
                      {overdue && !completed && <span className="text-xs text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full">Vencido</span>}
                    </div>
                    <p className="text-sm text-slate-500 mt-1 dark:text-white/40">{c.description || '—'}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-400 flex-wrap dark:text-white/30">
                      {c.due_date && <span>Vence: {format(new Date(c.due_date), "d 'de' MMM", { locale: es })}</span>}
                      {c.completed_at && <span>Completado {formatDistanceToNow(new Date(c.completed_at), { addSuffix: true, locale: es })}</span>}
                      {c.duration_hours && <span>{c.duration_hours}h</span>}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    {c.resource_url && (
                      <a href={c.resource_url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-lg text-xs font-medium dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                        <ExternalLink size={12} /> Acceder
                      </a>
                    )}
                    {!completed && (
                      <button onClick={() => completeMyCourse(c.assignment_id)}
                        className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium">
                        <CheckCircle2 size={12} /> Marcar completo
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {(mine?.data || []).length === 0 && (
            <div className="text-center py-12 text-slate-400 bg-white rounded-2xl border border-slate-100 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
              <Award size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">Sin cursos asignados</p>
            </div>
          )}
        </div>
      )}

      {/* Modal nuevo curso */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold flex items-center gap-2"><GraduationCap size={18} /> Nuevo curso</h3>
            <input placeholder="Título *" value={form.title}
              onChange={e => setForm((f: any) => ({ ...f, title: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <textarea placeholder="Descripción" value={form.description} rows={3}
              onChange={e => setForm((f: any) => ({ ...f, description: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <div className="grid grid-cols-2 gap-3">
              <select value={form.category} onChange={e => setForm((f: any) => ({ ...f, category: e.target.value }))}
                className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                <option value="">Categoría...</option>
                <option value="seguridad">Seguridad</option>
                <option value="compliance">Compliance</option>
                <option value="onboarding">Onboarding</option>
                <option value="tecnico">Técnico</option>
                <option value="otro">Otro</option>
              </select>
              <input type="number" step="0.5" placeholder="Duración (horas)" value={form.duration_hours}
                onChange={e => setForm((f: any) => ({ ...f, duration_hours: e.target.value }))}
                className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
            <input placeholder="Link a recurso (video, PDF, LMS)" value={form.resource_url}
              onChange={e => setForm((f: any) => ({ ...f, resource_url: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-600 mb-1 dark:text-white/60">Válido hasta</label>
                <input type="date" value={form.valid_until}
                  onChange={e => setForm((f: any) => ({ ...f, valid_until: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
              </div>
              <label className="flex items-center gap-2 pt-6 cursor-pointer">
                <input type="checkbox" checked={!!form.mandatory}
                  onChange={e => setForm((f: any) => ({ ...f, mandatory: e.target.checked ? 1 : 0 }))}
                  className="accent-amber-600 w-4 h-4" />
                <span className="text-sm">Obligatorio</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowForm(false)} className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={createCourse} className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium">Crear</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal asignar */}
      {showAssign && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowAssign(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold flex items-center gap-2"><Send size={18} /> Asignar: {showAssign.title}</h3>
            <select value={assignForm.mode}
              onChange={e => setAssignForm((f: any) => ({ ...f, mode: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="all">Todos los empleados activos</option>
              <option value="department">Un departamento específico</option>
            </select>
            {assignForm.mode === 'department' && (
              <select value={assignForm.department_id}
                onChange={e => setAssignForm((f: any) => ({ ...f, department_id: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                <option value="">Seleccionar...</option>
                {(depts || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
            <div>
              <label className="block text-xs text-slate-600 mb-1 dark:text-white/60">Fecha límite (opcional)</label>
              <input type="date" value={assignForm.due_date}
                onChange={e => setAssignForm((f: any) => ({ ...f, due_date: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAssign(null)} className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={assignCourse} className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium">Asignar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal progreso */}
      {showProgress && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowProgress(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] flex flex-col dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <h3 className="font-bold flex items-center gap-2"><BookOpen size={18} /> Progreso: {showProgress.title}</h3>
              <button onClick={() => setShowProgress(null)} className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100 sticky top-0 dark:bg-white/[0.03] dark:border-white/[0.06]">
                  <tr>
                    <th className="text-left px-4 py-2 text-slate-500 text-xs dark:text-white/40">Empleado</th>
                    <th className="text-left px-4 py-2 text-slate-500 text-xs dark:text-white/40">Estado</th>
                    <th className="text-right px-4 py-2 text-slate-500 text-xs dark:text-white/40">Asignado</th>
                    <th className="text-right px-4 py-2 text-slate-500 text-xs dark:text-white/40">Vence</th>
                    <th className="text-right px-4 py-2 text-slate-500 text-xs dark:text-white/40">Completado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                  {(progress?.data || []).map((p: any) => (
                    <tr key={p.assignment_id}>
                      <td className="px-4 py-2">
                        <p className="font-medium text-slate-800 dark:text-white/90">{p.employee_name}</p>
                        <p className="text-xs text-slate-400 dark:text-white/30">[{p.code}] {p.department || '—'}</p>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          p.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                          p.status === 'overdue'   ? 'bg-rose-100 text-rose-700' :
                          p.status === 'due_soon'  ? 'bg-amber-100 text-amber-700' :
                                                     'bg-slate-100 text-slate-600'
                        }`}>
                          {p.status === 'completed' ? 'Completado' :
                           p.status === 'overdue'   ? 'Vencido' :
                           p.status === 'due_soon'  ? 'Por vencer' :
                                                     'Pendiente'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-slate-500 dark:text-white/40">
                        {format(new Date(p.assigned_at), 'd MMM yyyy', { locale: es })}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-slate-500 dark:text-white/40">
                        {p.due_date ? format(new Date(p.due_date), 'd MMM yyyy', { locale: es }) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-slate-500 dark:text-white/40">
                        {p.completed_at ? format(new Date(p.completed_at), 'd MMM yyyy', { locale: es }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
