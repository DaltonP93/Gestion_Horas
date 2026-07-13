'use client'
import { useEffect, useState } from 'react'
import { Building2, Users, UserCog, Save, Plus, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Dept {
  id: number
  name: string
  code: string | null
  coordinator_id: number | null
  manager_id: number | null
  coordinator_name?: string | null
  manager_name?: string | null
  employees_count: number
  active: number
}
interface UserRef { id: number; username: string; full_name: string; role: string }

export default function DepartamentosPage() {
  const [depts, setDepts]   = useState<Dept[]>([])
  const [users, setUsers]   = useState<UserRef[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Dept | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [d, u] = await Promise.all([
        api.get('/api/departments').then(r => r.data as Dept[]),
        api.get('/api/users/lookup').then(r => r.data as UserRef[]).catch(() => [] as UserRef[]),
      ])
      setDepts(d); setUsers(u)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const coordinatorCandidates = users.filter(u => ['coordinator','admin','gth','super_admin'].includes(u.role))
  const managerCandidates     = users.filter(u => ['manager','admin','gth','super_admin'].includes(u.role))

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-indigo-500 flex items-center justify-center">
            <Building2 className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Departamentos</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Asignar coordinador (nivel 1) y gerente (nivel 2) para el flujo de aprobación de permisos.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium">
          <Plus size={16} /> Nuevo
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
            <tr>
              <th className="px-4 py-3">Departamento</th>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Empleados</th>
              <th className="px-4 py-3">Coordinador (Nivel 1)</th>
              <th className="px-4 py-3">Gerente (Nivel 2)</th>
              <th className="px-4 py-3 w-32"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {loading && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>
            )}
            {!loading && depts.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400 dark:text-white/30">Sin departamentos</td></tr>
            )}
            {depts.map(d => (
              <tr key={d.id} className={d.active ? '' : 'opacity-50'}>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{d.name}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-white/40">{d.code || '—'}</td>
                <td className="px-4 py-3"><span className="inline-flex items-center gap-1 text-slate-600 dark:text-white/60"><Users size={14} />{d.employees_count}</span></td>
                <td className="px-4 py-3">
                  {d.coordinator_name
                    ? <span className="inline-flex items-center gap-1 text-slate-700 dark:text-white/80"><UserCog size={14} className="text-emerald-500" />{d.coordinator_name}</span>
                    : <span className="text-amber-600 text-xs">Sin asignar</span>}
                </td>
                <td className="px-4 py-3">
                  {d.manager_name
                    ? <span className="inline-flex items-center gap-1 text-slate-700 dark:text-white/80"><UserCog size={14} className="text-blue-500" />{d.manager_name}</span>
                    : <span className="text-amber-600 text-xs">Sin asignar</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing(d)}
                    className="text-blue-600 hover:underline text-sm font-medium">Editar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <DeptFormModal
          dept={editing}
          creating={creating}
          coordinatorCandidates={coordinatorCandidates}
          managerCandidates={managerCandidates}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
        />
      )}
    </div>
  )
}

function DeptFormModal({ dept, creating, coordinatorCandidates, managerCandidates, onClose, onSaved }: {
  dept: Dept | null
  creating: boolean
  coordinatorCandidates: UserRef[]
  managerCandidates: UserRef[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(dept?.name || '')
  const [code, setCode] = useState(dept?.code || '')
  const [coordinatorId, setCoordinatorId] = useState<string>(dept?.coordinator_id?.toString() || '')
  const [managerId, setManagerId]         = useState<string>(dept?.manager_id?.toString() || '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  async function handleSave() {
    setSaving(true); setError('')
    try {
      const payload = {
        name, code: code || null,
        coordinator_id: coordinatorId ? parseInt(coordinatorId) : null,
        manager_id:     managerId     ? parseInt(managerId)     : null,
      }
      if (creating) await api.post('/api/departments', payload)
      else          await api.patch(`/api/departments/${dept!.id}`, payload)
      onSaved()
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {creating ? 'Nuevo departamento' : `Editar: ${dept?.name}`}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Nombre *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Código</label>
            <input value={code} onChange={e => setCode(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Coordinador (Nivel 1)</label>
            <select value={coordinatorId} onChange={e => setCoordinatorId(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08]">
              <option value="">— Sin asignar —</option>
              {coordinatorCandidates.map(u => (
                <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.role})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Gerente (Nivel 2)</label>
            <select value={managerId} onChange={e => setManagerId(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08]">
              <option value="">— Sin asignar —</option>
              {managerCandidates.map(u => (
                <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.role})</option>
              ))}
            </select>
          </div>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={handleSave} disabled={saving || !name}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}
