'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Shield, Plus, User, Edit2, Trash2, Key, Check, X } from 'lucide-react'
import { api } from '@/lib/api'

// ─── Tipos ────────────────────────────────────────────────────────
interface SysUser {
  id: number
  username: string
  email: string
  full_name: string
  role: 'admin' | 'hr' | 'supervisor' | 'employee'
  active: number
  last_login: string | null
  employee_id?: number
  employee_name?: string
}

const ROLES: Record<string, { label: string; cls: string }> = {
  admin:      { label: 'Administrador', cls: 'bg-red-50    text-red-700'    },
  hr:         { label: 'Recursos H.',   cls: 'bg-blue-50   text-blue-700'   },
  supervisor: { label: 'Supervisor',    cls: 'bg-purple-50 text-purple-700' },
  employee:   { label: 'Empleado',      cls: 'bg-slate-50  text-slate-600'  },
}

// ─── Modal crear/editar usuario ───────────────────────────────────
function UserModal({
  user, onClose,
}: { user?: SysUser; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!user

  const [form, setForm] = useState({
    username:  user?.username  || '',
    email:     user?.email     || '',
    full_name: user?.full_name || '',
    role:      user?.role      || 'hr',
    password:  '',
    active:    user?.active !== undefined ? String(user.active) : '1',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  function set(k: string, v: string) { setForm(p => ({ ...p, [k]: v })); setError('') }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      if (isEdit) {
        await api.put(`/api/users/${user!.id}`, {
          full_name: form.full_name,
          email: form.email,
          role: form.role,
          active: +form.active,
        })
      } else {
        await api.post('/api/users', form)
      }
      qc.invalidateQueries({ queryKey: ['sys-users'] })
      onClose()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 dark:bg-white/[0.04]">
        <h2 className="text-lg font-bold text-slate-900 mb-5 flex items-center gap-2 dark:text-white">
          <User size={20} className="text-blue-500" />
          {isEdit ? 'Editar usuario' : 'Nuevo usuario'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Nombre completo</label>
              <input required value={form.full_name} onChange={e => set('full_name', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Usuario {!isEdit && <span className="text-red-500">*</span>}</label>
              <input required={!isEdit} disabled={isEdit} value={form.username}
                onChange={e => set('username', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Rol</label>
              <select value={form.role} onChange={e => set('role', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
                {Object.entries(ROLES).map(([v, { label }]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Email <span className="text-red-500">*</span></label>
              <input required type="email" value={form.email} onChange={e => set('email', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
            {!isEdit && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Contraseña <span className="text-red-500">*</span></label>
                <input required type="password" placeholder="Mín. 8 caracteres" value={form.password}
                  onChange={e => set('password', e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
              </div>
            )}
            {isEdit && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Estado</label>
                <select value={form.active} onChange={e => set('active', e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
                  <option value="1">Activo</option>
                  <option value="0">Inactivo</option>
                </select>
              </div>
            )}
          </div>
          {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
              {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Modal cambiar contraseña ─────────────────────────────────────
function PasswordModal({ userId, onClose }: { userId: number; onClose: () => void }) {
  const [pw, setPw]     = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.put(`/api/users/${userId}/password`, { newPassword: pw })
      setDone(true)
      setTimeout(onClose, 1500)
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 dark:bg-white/[0.04]">
        <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2 dark:text-white">
          <Key size={18} className="text-amber-500" /> Cambiar contraseña
        </h2>
        {done ? (
          <div className="text-center py-4 text-green-600 font-medium">
            <Check size={32} className="mx-auto mb-2" /> Contraseña actualizada
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input required type="password" placeholder="Nueva contraseña (mín. 8 caracteres)"
              value={pw} onChange={e => setPw(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            <div className="flex gap-3">
              <button type="button" onClick={onClose}
                className="flex-1 border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium dark:text-white/80 dark:border-white/[0.08]">
                Cancelar
              </button>
              <button type="submit" disabled={saving || pw.length < 8}
                className="flex-1 bg-amber-500 text-white py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">
                {saving ? 'Cambiando...' : 'Cambiar'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────
export default function UsuariosPage() {
  const qc = useQueryClient()
  const [modal, setModal]     = useState<null | 'new' | SysUser>(null)
  const [pwModal, setPwModal] = useState<number | null>(null)
  const [roleFilter, setRole] = useState('all')

  const { data, isLoading } = useQuery<SysUser[]>({
    queryKey: ['sys-users', roleFilter],
    queryFn: () => api.get('/api/users', {
      params: roleFilter !== 'all' ? { role: roleFilter } : {}
    }).then(r => r.data),
    staleTime: 30_000,
  })

  async function deactivate(user: SysUser) {
    if (!confirm(`¿Desactivar a ${user.full_name}?`)) return
    await api.delete(`/api/users/${user.id}`)
    qc.invalidateQueries({ queryKey: ['sys-users'] })
  }

  const users = data || []

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="text-blue-600" size={26} />
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Usuarios del sistema</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Accesos, roles y permisos</p>
          </div>
        </div>
        <button onClick={() => setModal('new')}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700">
          <Plus size={15} /> Nuevo usuario
        </button>
      </div>

      {/* Stats por rol */}
      <div className="grid grid-cols-4 gap-3">
        {Object.entries(ROLES).map(([role, { label, cls }]) => {
          const count = users.filter(u => u.role === role && u.active).length
          return (
            <div key={role} className={`rounded-2xl p-4 border cursor-pointer transition-all ${
              roleFilter === role ? 'ring-2 ring-blue-500' : 'border-slate-100'
            } ${cls} bg-opacity-50`}
              onClick={() => setRole(roleFilter === role ? 'all' : role)}>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p>
              <p className="text-3xl font-bold mt-0.5">{count}</p>
            </div>
          )
        })}
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {isLoading ? (
          <div className="text-center py-16 text-slate-400 dark:text-white/30">Cargando usuarios...</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Usuario</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Email</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Rol</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Empleado vinculado</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium dark:text-white/40">Estado</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium dark:text-white/40">Último acceso</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {users.map(u => {
                const role = ROLES[u.role] || ROLES.employee
                return (
                  <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                          {u.full_name?.[0] || u.username?.[0]}
                        </div>
                        <div>
                          <p className="font-medium text-slate-900 dark:text-white">{u.full_name}</p>
                          <p className="text-xs text-slate-400 dark:text-white/30">@{u.username}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-white/60">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold ${role.cls}`}>
                        {role.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs dark:text-white/40">{u.employee_name || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        u.active ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {u.active ? <Check size={11} /> : <X size={11} />}
                        {u.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs dark:text-white/30">
                      {u.last_login ? new Date(u.last_login).toLocaleDateString('es', {
                        day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'
                      }) : 'Nunca'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => setModal(u)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors dark:text-white/30" title="Editar">
                          <Edit2 size={14} />
                        </button>
                        <a href={`/usuarios/${u.id}/permisos`}
                          className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors inline-block dark:text-white/30" title="Permisos granulares">
                          <Shield size={14} />
                        </a>
                        <button onClick={() => setPwModal(u.id)}
                          className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors dark:text-white/30" title="Contraseña">
                          <Key size={14} />
                        </button>
                        {u.active ? (
                          <button onClick={() => deactivate(u)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors dark:text-white/30" title="Desactivar">
                            <Trash2 size={14} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {users.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-slate-400 dark:text-white/30">Sin usuarios</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {modal && modal !== 'new' && (
        <UserModal user={modal as SysUser} onClose={() => setModal(null)} />
      )}
      {modal === 'new' && (
        <UserModal onClose={() => setModal(null)} />
      )}
      {pwModal !== null && (
        <PasswordModal userId={pwModal} onClose={() => setPwModal(null)} />
      )}
    </div>
  )
}
