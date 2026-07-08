'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Calendar, Plus, CheckCircle, XCircle, Clock, Filter, Download } from 'lucide-react'
import { api, employeesApi } from '@/lib/api'

// ─── Tipos ────────────────────────────────────────────────────────
interface Permission {
  id: number
  employee_id: number
  employee_name: string
  department: string
  department_id: number
  type: string
  date_from: string
  date_to: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
  approved_by_name?: string
  rejection_reason?: string
}

const TYPE_LABELS: Record<string, string> = {
  vacation:  'Vacaciones',
  sick:      'Enfermedad',
  personal:  'Personal',
  maternity: 'Maternidad',
  paternity: 'Paternidad',
  study:     'Estudio',
  legal:     'Legal/Judicial',
  other:     'Otro',
}

const TYPE_COLORS: Record<string, string> = {
  vacation:  'bg-blue-100 text-blue-700',
  sick:      'bg-red-100 text-red-700',
  personal:  'bg-purple-100 text-purple-700',
  maternity: 'bg-pink-100 text-pink-700',
  paternity: 'bg-cyan-100 text-cyan-700',
  study:     'bg-green-100 text-green-700',
  legal:     'bg-amber-100 text-amber-700',
  other:     'bg-slate-100 text-slate-700',
}

const STATUS_CFG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  pending:  { label: 'Pendiente',  cls: 'bg-amber-50  text-amber-700  border border-amber-200', icon: <Clock size={12} />        },
  approved: { label: 'Aprobado',   cls: 'bg-green-50  text-green-700  border border-green-200', icon: <CheckCircle size={12} />  },
  rejected: { label: 'Rechazado',  cls: 'bg-red-50    text-red-700    border border-red-200',   icon: <XCircle size={12} />      },
}

// ─── Exportar a CSV ───────────────────────────────────────────────
function exportCSV(data: Permission[]) {
  const header = ['ID','Empleado','Departamento','Tipo','Desde','Hasta','Días','Motivo','Estado','Creado']
  const rows = data.map(p => {
    const days = Math.max(1, Math.round((new Date(p.date_to).getTime() - new Date(p.date_from).getTime()) / 86400000) + 1)
    return [
      p.id, p.employee_name, p.department || '', TYPE_LABELS[p.type] || p.type,
      p.date_from, p.date_to, days, `"${(p.reason || '').replace(/"/g, '""')}"`,
      p.status, p.created_at?.slice(0,10)
    ].join(',')
  })
  const csv = [header.join(','), ...rows].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `permisos_${format(new Date(),'yyyyMMdd')}.csv`
  a.click(); URL.revokeObjectURL(url)
}

// ─── Modal nuevo permiso ──────────────────────────────────────────
function NuevoPermisoModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    employee_id: '', type: 'personal',
    date_from: format(new Date(), 'yyyy-MM-dd'),
    date_to: format(new Date(), 'yyyy-MM-dd'),
    reason: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const { data: empsData } = useQuery({
    queryKey: ['employees-select'],
    queryFn: () => employeesApi.list({ limit: 500, status: 'active' }),
    staleTime: 60_000,
  })

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const [filterDept, setFilterDept] = useState('')

  const filteredEmps = (empsData?.data || []).filter((emp: any) =>
    !filterDept || String(emp.department_id) === filterDept
  )

  const days = Math.max(1, Math.round(
    (new Date(form.date_to).getTime() - new Date(form.date_from).getTime()) / 86400000
  ) + 1)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.employee_id) { setError('Selecciona un empleado'); return }
    setSaving(true); setError('')
    try {
      await api.post('/api/permissions', { ...form, employee_id: +form.employee_id })
      qc.invalidateQueries({ queryKey: ['permissions'] })
      onClose()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Error al crear permiso')
    } finally { setSaving(false) }
  }

  function set(key: string, val: string) { setForm(prev => ({ ...prev, [key]: val })) }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg dark:bg-white/[0.04]">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-t-2xl px-6 py-4">
          <h2 className="text-lg font-bold text-white">Nuevo Permiso / Ausencia</h2>
          <p className="text-blue-200 text-xs mt-0.5">Complete los datos del permiso solicitado</p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Filtro de departamento para el selector */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1 dark:text-white/40">Filtrar por departamento</label>
              <select value={filterDept} onChange={e => { setFilterDept(e.target.value); set('employee_id', '') }}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.08]">
                <option value="">Todos los departamentos</option>
                {(deptsData || []).map((d: any) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1 dark:text-white/80">Empleado <span className="text-red-500">*</span></label>
              <select required value={form.employee_id} onChange={e => set('employee_id', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
                <option value="">Seleccionar empleado...</option>
                {filteredEmps.map((emp: any) => (
                  <option key={emp.id} value={emp.id}>[{emp.code}] {emp.full_name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 dark:text-white/80">Tipo de permiso</label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(TYPE_LABELS).map(([v, l]) => (
                <button key={v} type="button"
                  onClick={() => set('type', v)}
                  className={`px-2 py-2 rounded-xl text-xs font-medium border-2 transition-all ${
                    form.type === v
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1 dark:text-white/80">Desde</label>
              <input type="date" required value={form.date_from}
                onChange={e => { set('date_from', e.target.value); if (e.target.value > form.date_to) set('date_to', e.target.value) }}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1 dark:text-white/80">Hasta</label>
              <input type="date" required value={form.date_to} min={form.date_from}
                onChange={e => set('date_to', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
          </div>

          {days > 0 && (
            <div className="bg-blue-50 rounded-xl px-4 py-2 text-sm text-blue-700 font-medium">
              Duración: <strong>{days}</strong> día{days > 1 ? 's' : ''} hábil{days > 1 ? 'es' : ''}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 dark:text-white/80">Motivo / Descripción</label>
            <textarea value={form.reason} onChange={e => set('reason', e.target.value)}
              rows={3} placeholder="Describa el motivo del permiso o ausencia..."
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none dark:border-white/[0.08]" />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors">
              {saving ? 'Guardando...' : 'Crear permiso'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────
export default function PermisosPage() {
  const qc = useQueryClient()
  const [showModal, setModal] = useState(false)
  const [filter, setFilter]   = useState<'all' | 'pending' | 'approved' | 'rejected'>('all')
  const [deptFilter, setDeptFilter] = useState('')

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const { data, isLoading } = useQuery<Permission[]>({
    queryKey: ['permissions', deptFilter],
    queryFn: () => api.get('/api/permissions', { params: { department_id: deptFilter || undefined } }).then(r => r.data),
    staleTime: 30_000,
  })

  async function approve(id: number) {
    try {
      await api.patch(`/api/permissions/${id}/approve`)
      qc.invalidateQueries({ queryKey: ['permissions'] })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al aprobar')
    }
  }

  async function reject(id: number) {
    const reason = prompt('Motivo del rechazo (opcional):') ?? ''
    try {
      await api.patch(`/api/permissions/${id}/reject`, { rejection_reason: reason })
      qc.invalidateQueries({ queryKey: ['permissions'] })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al rechazar')
    }
  }

  const allRows = data || []
  const rows = allRows.filter(r => filter === 'all' || r.status === filter)

  const pending  = allRows.filter(r => r.status === 'pending').length
  const approved = allRows.filter(r => r.status === 'approved').length
  const rejected = allRows.filter(r => r.status === 'rejected').length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
            <Calendar className="text-blue-600" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Permisos y Ausencias</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Gestión de permisos, vacaciones y ausencias del personal</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportCSV(rows)}
            disabled={rows.length === 0}
            className="flex items-center gap-2 border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 disabled:opacity-40 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]"
          >
            <Download size={15} /> Exportar CSV
          </button>
          <button
            onClick={() => setModal(true)}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors"
          >
            <Plus size={15} /> Nuevo permiso
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white border border-slate-100 rounded-2xl px-5 py-4 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1 dark:text-white/40">Total</p>
          <p className="text-3xl font-bold text-slate-700 dark:text-white/80">{allRows.length}</p>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-2xl px-5 py-4 cursor-pointer hover:shadow-sm transition-shadow"
          onClick={() => setFilter(filter === 'pending' ? 'all' : 'pending')}>
          <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-1">Pendientes</p>
          <p className="text-3xl font-bold text-amber-700">{pending}</p>
          {pending > 0 && <p className="text-xs text-amber-500 mt-1">Requieren acción</p>}
        </div>
        <div className="bg-green-50 border border-green-100 rounded-2xl px-5 py-4 cursor-pointer hover:shadow-sm transition-shadow"
          onClick={() => setFilter(filter === 'approved' ? 'all' : 'approved')}>
          <p className="text-xs font-medium text-green-600 uppercase tracking-wide mb-1">Aprobados</p>
          <p className="text-3xl font-bold text-green-700">{approved}</p>
        </div>
        <div className="bg-red-50 border border-red-100 rounded-2xl px-5 py-4 cursor-pointer hover:shadow-sm transition-shadow"
          onClick={() => setFilter(filter === 'rejected' ? 'all' : 'rejected')}>
          <p className="text-xs font-medium text-red-600 uppercase tracking-wide mb-1">Rechazados</p>
          <p className="text-3xl font-bold text-red-700">{rejected}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex gap-2">
          {(['all', 'pending', 'approved', 'rejected'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                filter === f
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}>
              {f === 'all' ? 'Todos' : STATUS_CFG[f]?.label}
              {f !== 'all' && (
                <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold ${
                  filter === f ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                }`}>
                  {f === 'pending' ? pending : f === 'approved' ? approved : rejected}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Filter size={15} className="text-slate-400 dark:text-white/30" />
          <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
            <option value="">Todos los departamentos</option>
            {(deptsData || []).map((d: any) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {isLoading ? (
          <div className="text-center py-16 text-slate-400 dark:text-white/30">
            <Clock size={32} className="mx-auto mb-3 opacity-40" />
            Cargando permisos...
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Empleado</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Departamento</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Tipo</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Período</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium max-w-[180px] dark:text-white/40">Motivo</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium dark:text-white/40">Estado</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {rows.map(row => {
                const cfg = STATUS_CFG[row.status]
                const days = Math.max(1,
                  Math.round((new Date(row.date_to).getTime() - new Date(row.date_from).getTime()) / 86400000) + 1
                )
                return (
                  <tr key={row.id} className="hover:bg-slate-50 transition-colors dark:hover:bg-white/[0.04]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-semibold text-xs shrink-0">
                          {(row.employee_name || '?').split(' ').slice(0,2).map((n: string) => n[0] || '').join('') || '?'}
                        </div>
                        <span className="font-medium text-slate-900 dark:text-white">{row.employee_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs dark:text-white/40">{row.department || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${TYPE_COLORS[row.type] || 'bg-slate-100 text-slate-600'}`}>
                        {TYPE_LABELS[row.type] || row.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600 text-xs dark:text-white/60">
                      <div className="font-medium text-slate-800 dark:text-white/90">
                        {format(new Date(row.date_from + 'T12:00'), 'dd/MM/yyyy')}
                        {row.date_from !== row.date_to && (
                          <> – {format(new Date(row.date_to + 'T12:00'), 'dd/MM/yyyy')}</>
                        )}
                      </div>
                      <div className="text-slate-400 mt-0.5 dark:text-white/30">{days} día{days > 1 ? 's' : ''}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs max-w-[180px] dark:text-white/40">
                      <p className="truncate">{row.reason || '—'}</p>
                      {row.rejection_reason && (
                        <p className="text-red-500 truncate mt-0.5">↩ {row.rejection_reason}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.cls}`}>
                        {cfg.icon} {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.status === 'pending' && (
                        <div className="flex gap-1.5 justify-end">
                          <button onClick={() => approve(row.id)}
                            className="flex items-center gap-1 bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 text-xs font-medium px-3 py-1.5 rounded-xl transition-colors">
                            <CheckCircle size={12} /> Aprobar
                          </button>
                          <button onClick={() => reject(row.id)}
                            className="flex items-center gap-1 bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 text-xs font-medium px-3 py-1.5 rounded-xl transition-colors">
                            <XCircle size={12} /> Rechazar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-16 text-slate-400 dark:text-white/30">
                    <Calendar size={36} className="mx-auto mb-3 opacity-30" />
                    <p className="font-medium">Sin permisos registrados</p>
                    <p className="text-xs mt-1">Use el botón "Nuevo permiso" para agregar uno</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {rows.length > 0 && (
        <p className="text-xs text-slate-400 dark:text-white/30">{rows.length} permiso{rows.length !== 1 ? 's' : ''} mostrado{rows.length !== 1 ? 's' : ''}</p>
      )}

      {showModal && <NuevoPermisoModal onClose={() => setModal(false)} />}
    </div>
  )
}
