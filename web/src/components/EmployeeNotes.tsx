'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Plus, Pin, Trash2, AlertTriangle, Award, Stethoscope, BookOpen, MoreHorizontal, Eye, EyeOff, Users as UsersIcon, User } from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'

const TYPES: { value: string; label: string; icon: any; color: string }[] = [
  { value: 'observation',  label: 'Observación',          icon: MessageSquare, color: 'bg-slate-100 text-slate-700' },
  { value: 'warning',      label: 'Llamada de atención',  icon: AlertTriangle, color: 'bg-rose-100 text-rose-700' },
  { value: 'recognition',  label: 'Reconocimiento',       icon: Award,         color: 'bg-emerald-100 text-emerald-700' },
  { value: 'medical',      label: 'Médico',               icon: Stethoscope,   color: 'bg-blue-100 text-blue-700' },
  { value: 'training',     label: 'Capacitación',         icon: BookOpen,      color: 'bg-violet-100 text-violet-700' },
  { value: 'other',        label: 'Otro',                 icon: MoreHorizontal,color: 'bg-amber-100 text-amber-700' },
]

const VISIBILITY_LABELS: Record<string, { label: string; icon: any }> = {
  hr_only:  { label: 'Solo RRHH',     icon: EyeOff },
  managers: { label: 'Supervisores',  icon: UsersIcon },
  employee: { label: 'Visible al empleado', icon: Eye },
}

export default function EmployeeNotes({ employeeId }: { employeeId: number }) {
  const qc = useQueryClient()
  const user = useCurrentUser()
  const isManager = user && ['admin', 'gth', 'hr', 'manager'].includes(user.role)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    type: 'observation', visibility: 'hr_only',
    title: '', body: '', pinned: false,
  })

  const { data, isLoading } = useQuery<any>({
    queryKey: ['employee-notes', employeeId],
    queryFn: () => api.get(`/api/employee-notes/by-employee/${employeeId}`).then(r => r.data),
  })

  const notes: any[] = data?.data || []

  async function create() {
    if (!form.title.trim()) return alert('El título es requerido')
    try {
      await api.post('/api/employee-notes', {
        ...form,
        pinned: form.pinned ? 1 : 0,
        employee_id: employeeId,
      })
      qc.invalidateQueries({ queryKey: ['employee-notes', employeeId] })
      setShowForm(false)
      setForm({ type: 'observation', visibility: 'hr_only', title: '', body: '', pinned: false })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al crear nota')
    }
  }

  async function togglePinned(n: any) {
    try {
      await api.put(`/api/employee-notes/${n.id}`, { pinned: n.pinned ? 0 : 1 })
      qc.invalidateQueries({ queryKey: ['employee-notes', employeeId] })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Sin permiso')
    }
  }

  async function deleteNote(id: number) {
    if (!confirm('¿Eliminar esta nota?')) return
    try {
      await api.delete(`/api/employee-notes/${id}`)
      qc.invalidateQueries({ queryKey: ['employee-notes', employeeId] })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al eliminar')
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <MessageSquare size={18} className="text-blue-600" />
          <h3 className="font-semibold text-slate-800 dark:text-white/90">Notas y observaciones</h3>
          <span className="text-xs text-slate-400 dark:text-white/30">({notes.length})</span>
        </div>
        {isManager && (
          <button onClick={() => setShowForm(s => !s)}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-xs font-medium transition-colors">
            <Plus size={13} /> Nueva nota
          </button>
        )}
      </div>

      {showForm && (
        <div className="p-5 space-y-3 border-b border-slate-100 bg-blue-50/30 dark:border-white/[0.06]">
          <div className="grid grid-cols-2 gap-2">
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <select value={form.visibility} onChange={e => setForm(f => ({ ...f, visibility: e.target.value }))}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
              <option value="hr_only">Solo RRHH</option>
              <option value="managers">Supervisores</option>
              <option value="employee">Visible al empleado</option>
            </select>
          </div>
          <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Título"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            rows={4} placeholder="Detalle (opcional)"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none dark:border-white/[0.08]" />
          <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700 dark:text-white/80">
            <input type="checkbox" checked={form.pinned} onChange={e => setForm(f => ({ ...f, pinned: e.target.checked }))}
              className="accent-blue-600 w-4 h-4" />
            <Pin size={13} /> Fijar al inicio
          </label>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowForm(false)}
              className="border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
            <button onClick={create}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium">Guardar</button>
          </div>
        </div>
      )}

      {isLoading && <div className="text-center py-8 text-slate-400 text-sm dark:text-white/30">Cargando...</div>}
      {!isLoading && notes.length === 0 && (
        <div className="text-center py-12 text-slate-400 dark:text-white/30">
          <MessageSquare size={28} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">Sin notas registradas</p>
        </div>
      )}

      <div className="divide-y divide-slate-50 dark:divide-white/[0.05]">
        {notes.map(n => {
          const typeMeta = TYPES.find(t => t.value === n.type) || TYPES[0]
          const Icon = typeMeta.icon
          const VisIcon = VISIBILITY_LABELS[n.visibility]?.icon || EyeOff
          const canEdit = isManager
          return (
            <div key={n.id} className={`p-4 ${n.pinned ? 'bg-amber-50/40' : ''}`}>
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${typeMeta.color}`}>
                  <Icon size={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {n.pinned && <Pin size={12} className="text-amber-500 fill-amber-500" />}
                    <p className="font-semibold text-slate-800 text-sm dark:text-white/90">{n.title}</p>
                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${typeMeta.color}`}>
                      {typeMeta.label}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-white/30">
                      <VisIcon size={10} /> {VISIBILITY_LABELS[n.visibility]?.label}
                    </span>
                  </div>
                  {n.body && <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap dark:text-white/60">{n.body}</p>}
                  <div className="flex items-center gap-3 mt-2 text-xs text-slate-400 dark:text-white/30">
                    <span className="flex items-center gap-1">
                      <User size={10} /> {n.author_name || n.author_username || '—'}
                    </span>
                    <span>{format(new Date(n.created_at), "d MMM yyyy 'a las' HH:mm", { locale: es })}</span>
                  </div>
                </div>
                {canEdit && (
                  <div className="flex flex-col gap-1 opacity-60 hover:opacity-100">
                    <button onClick={() => togglePinned(n)} title={n.pinned ? 'Desfijar' : 'Fijar'}
                      className={`p-1.5 rounded-lg hover:bg-amber-50 ${n.pinned ? 'text-amber-600' : 'text-slate-400'}`}>
                      <Pin size={13} />
                    </button>
                    <button onClick={() => deleteNote(n.id)} title="Eliminar"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:text-white/30">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
