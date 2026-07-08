'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  Megaphone, Plus, Pin, AlertTriangle, Info, Users, Building2, Shield,
  CheckCircle2, Eye, Trash2, X, Send,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'

const PRIORITY_STYLE = {
  info:      { icon: Info,          color: 'bg-blue-50 border-blue-200 text-blue-800',     bar: 'bg-blue-500',     label: 'Informativo' },
  important: { icon: AlertTriangle, color: 'bg-amber-50 border-amber-200 text-amber-900',  bar: 'bg-amber-500',    label: 'Importante' },
  critical:  { icon: AlertTriangle, color: 'bg-rose-50 border-rose-200 text-rose-900',     bar: 'bg-rose-500',     label: 'Crítico' },
}

const AUDIENCE_LABEL: Record<string, string> = {
  all:        'Todos',
  department: 'Departamento',
  role:       'Por rol',
  employees:  'Empleados específicos',
}

export default function ComunicadosPage() {
  const qc = useQueryClient()
  const user = useCurrentUser()
  const isAdmin = ['admin', 'gth', 'hr', 'manager', 'super_admin'].includes(user?.role || '')

  const [selected, setSelected] = useState<any>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<any>({
    title: '', body: '', audience: 'all', audience_dept: '', audience_role: '',
    priority: 'info', require_ack: 0, pinned: 0, expires_at: '',
  })

  const { data: depts } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const { data: list } = useQuery<any>({
    queryKey: ['announcements'],
    queryFn: () => api.get('/api/announcements').then(r => r.data),
    refetchInterval: 60_000,
  })

  const items: any[] = list?.data || []

  async function markRead(id: number) {
    await api.post(`/api/announcements/${id}/read`)
    qc.invalidateQueries({ queryKey: ['announcements'] })
    qc.invalidateQueries({ queryKey: ['announcements-unread'] })
  }

  async function openDetail(a: any) {
    setSelected(a)
    if (!a.read_at) markRead(a.id)
  }

  async function createAnnouncement() {
    if (!form.title || !form.body) return alert('Título y mensaje son requeridos')
    try {
      await api.post('/api/announcements', form)
      qc.invalidateQueries({ queryKey: ['announcements'] })
      setShowForm(false)
      setForm({ title: '', body: '', audience: 'all', audience_dept: '', audience_role: '',
                priority: 'info', require_ack: 0, pinned: 0, expires_at: '' })
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error al publicar')
    }
  }

  async function remove(id: number) {
    if (!confirm('¿Eliminar este comunicado?')) return
    await api.delete(`/api/announcements/${id}`)
    qc.invalidateQueries({ queryKey: ['announcements'] })
    if (selected?.id === id) setSelected(null)
  }

  const unreadCount = items.filter(a => !a.read_at).length

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-orange-500 to-pink-500 flex items-center justify-center">
            <Megaphone className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Comunicados</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">
              {items.length} comunicado{items.length !== 1 ? 's' : ''}
              {unreadCount > 0 && (
                <span className="ml-2 bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full text-xs font-medium">
                  {unreadCount} sin leer
                </span>
              )}
            </p>
          </div>
        </div>
        {isAdmin && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
            <Plus size={14} /> Nuevo comunicado
          </button>
        )}
      </div>

      {/* Lista */}
      <div className="space-y-3">
        {items.length === 0 && (
          <div className="text-center py-12 text-slate-400 bg-white rounded-2xl border border-slate-100 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
            <Megaphone size={36} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Sin comunicados activos</p>
          </div>
        )}
        {items.map(a => {
          const style = PRIORITY_STYLE[a.priority as keyof typeof PRIORITY_STYLE] || PRIORITY_STYLE.info
          const Icon = style.icon
          return (
            <div key={a.id} onClick={() => openDetail(a)}
              className={`bg-white rounded-2xl border shadow-sm overflow-hidden cursor-pointer hover:shadow-md transition-all ${
                !a.read_at ? 'ring-2 ring-blue-200' : ''
              }`}>
              <div className={`h-1 ${style.bar}`} />
              <div className="p-5">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl ${style.color} flex items-center justify-center shrink-0`}>
                    <Icon size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {a.pinned ? <Pin size={13} className="text-amber-600" /> : null}
                      <h3 className="font-bold text-slate-900 dark:text-white">{a.title}</h3>
                      {!a.read_at && (
                        <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs font-medium">Nuevo</span>
                      )}
                      {a.require_ack && a.read_at && (
                        <span className="flex items-center gap-1 bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-xs font-medium">
                          <CheckCircle2 size={11} /> Confirmado
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-600 mt-1 line-clamp-2 dark:text-white/60">{a.body}</p>
                    <div className="flex items-center gap-3 mt-3 text-xs text-slate-400 dark:text-white/30">
                      <span>{a.author_name || a.author_username}</span>
                      <span>·</span>
                      <span>{format(new Date(a.created_at), "d 'de' MMM yyyy", { locale: es })}</span>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        {a.audience === 'department' ? <Building2 size={11} /> :
                         a.audience === 'role'       ? <Shield size={11} /> :
                                                       <Users size={11} />}
                        {AUDIENCE_LABEL[a.audience]}
                        {a.audience === 'department' && a.audience_dept_name && `: ${a.audience_dept_name}`}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Modal detalle */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col dark:bg-white/[0.04]"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <div className="flex items-center gap-2">
                {selected.pinned && <Pin size={14} className="text-amber-600" />}
                <h3 className="font-bold text-lg text-slate-900 dark:text-white">{selected.title}</h3>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600 dark:text-white/30">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap dark:text-white/40">
                <span>Por <strong>{selected.author_name || selected.author_username}</strong></span>
                <span>·</span>
                <span>{format(new Date(selected.created_at), "d 'de' MMMM 'de' yyyy 'a las' HH:mm", { locale: es })}</span>
              </div>
              <div className="prose prose-sm max-w-none whitespace-pre-wrap text-slate-700 dark:text-white/80">
                {selected.body}
              </div>
              {isAdmin && (
                <button onClick={() => remove(selected.id)}
                  className="flex items-center gap-2 text-rose-600 hover:bg-rose-50 px-3 py-1.5 rounded-lg text-sm font-medium">
                  <Trash2 size={14} /> Eliminar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal crear */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col dark:bg-white/[0.04]"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <h3 className="font-bold text-slate-900 flex items-center gap-2 dark:text-white">
                <Megaphone size={18} className="text-orange-600" /> Nuevo comunicado
              </h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600 dark:text-white/30">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Título *</label>
                <input value={form.title} onChange={e => setForm((f: any) => ({ ...f, title: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Mensaje *</label>
                <textarea value={form.body} rows={5}
                  onChange={e => setForm((f: any) => ({ ...f, body: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Prioridad</label>
                  <select value={form.priority}
                    onChange={e => setForm((f: any) => ({ ...f, priority: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]">
                    <option value="info">Informativo</option>
                    <option value="important">Importante</option>
                    <option value="critical">Crítico</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Audiencia</label>
                  <select value={form.audience}
                    onChange={e => setForm((f: any) => ({ ...f, audience: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]">
                    <option value="all">Todos los usuarios</option>
                    <option value="department">Departamento específico</option>
                    <option value="role">Por rol</option>
                  </select>
                </div>
              </div>
              {form.audience === 'department' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Departamento</label>
                  <select value={form.audience_dept}
                    onChange={e => setForm((f: any) => ({ ...f, audience_dept: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]">
                    <option value="">Seleccionar...</option>
                    {(depts || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              )}
              {form.audience === 'role' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Rol</label>
                  <select value={form.audience_role}
                    onChange={e => setForm((f: any) => ({ ...f, audience_role: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]">
                    <option value="">Seleccionar...</option>
                    <option value="employee">Empleados</option>
                    <option value="supervisor">Supervisores</option>
                    <option value="manager">Gerentes</option>
                    <option value="hr">RRHH</option>
                    <option value="admin">Administradores</option>
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Expira</label>
                  <input type="datetime-local" value={form.expires_at}
                    onChange={e => setForm((f: any) => ({ ...f, expires_at: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm dark:border-white/[0.08]" />
                </div>
                <div className="flex flex-col gap-2 pt-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!form.pinned}
                      onChange={e => setForm((f: any) => ({ ...f, pinned: e.target.checked ? 1 : 0 }))}
                      className="accent-amber-600 w-4 h-4" />
                    <span className="text-sm text-slate-700 dark:text-white/80">Fijar arriba</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!form.require_ack}
                      onChange={e => setForm((f: any) => ({ ...f, require_ack: e.target.checked ? 1 : 0 }))}
                      className="accent-emerald-600 w-4 h-4" />
                    <span className="text-sm text-slate-700 dark:text-white/80">Requiere confirmación</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 dark:border-white/[0.06]">
              <button onClick={() => setShowForm(false)}
                className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={createAnnouncement}
                className="flex items-center gap-2 bg-gradient-to-r from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600 text-white px-4 py-2 rounded-xl text-sm font-medium">
                <Send size={14} /> Publicar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
