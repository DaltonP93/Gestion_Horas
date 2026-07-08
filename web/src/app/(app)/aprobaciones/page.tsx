'use client'
import { useEffect, useState } from 'react'
import { CheckSquare, Check, X, Clock, UserCircle2, Calendar, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'
import ApprovalsSlaWidget from '@/components/ApprovalsSlaWidget'

interface Perm {
  id: number
  employee_id: number
  employee_name: string
  employee_code: string
  department: string | null
  department_id: number | null
  type: string
  date_from: string
  date_to: string
  reason: string | null
  approval_state: 'pending' | 'level1_ok' | 'level2_ok' | 'approved' | 'rejected' | 'cancelled'
  needs_level1: number
  needs_level2: number
  needs_final: number
  created_at: string
}

const STATE_LABEL: Record<Perm['approval_state'], string> = {
  pending:    'Pendiente (Nivel 1)',
  level1_ok:  'Nivel 1 OK — Nivel 2 pendiente',
  level2_ok:  'Nivel 2 OK — GTH pendiente',
  approved:   'Aprobado',
  rejected:   'Rechazado',
  cancelled:  'Cancelado',
}

const TYPE_LABEL: Record<string, string> = {
  vacation: 'Vacaciones', sick: 'Enfermedad', personal: 'Personal',
  maternity: 'Maternidad', paternity: 'Paternidad', study: 'Estudio',
  legal: 'Legal', other: 'Otro',
}

export default function AprobacionesPage() {
  const user = useCurrentUser()
  const [list, setList] = useState<Perm[]>([])
  const [loading, setLoading] = useState(true)
  const [actioning, setActioning] = useState<number | null>(null)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const { data } = await api.get('/api/permissions/inbox')
      setList(data)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function approve(id: number) {
    const note = prompt('Nota de aprobación (opcional):') || undefined
    setActioning(id)
    try {
      await api.patch(`/api/permissions/${id}/approve`, { note })
      await load()
    } catch (e: any) {
      alert(e.response?.data?.error || e.message)
    } finally { setActioning(null) }
  }

  async function reject(id: number) {
    const reason = prompt('Motivo de rechazo (requerido):')
    if (!reason) return
    setActioning(id)
    try {
      await api.patch(`/api/permissions/${id}/reject`, { rejection_reason: reason })
      await load()
    } catch (e: any) {
      alert(e.response?.data?.error || e.message)
    } finally { setActioning(null) }
  }

  const roleLabel = user?.role === 'coordinator' ? 'Coordinador (Nivel 1)'
    : user?.role === 'manager' ? 'Gerente (Nivel 2)'
    : user?.role === 'super_admin' ? 'Super Admin (todos los niveles)'
    : 'GTH (aprobación final)'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-emerald-500 flex items-center justify-center">
          <CheckSquare className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Aprobaciones</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">{roleLabel}. Solo ves solicitudes que te corresponde aprobar.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900">{error}</div>
        </div>
      )}

      <ApprovalsSlaWidget />

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {loading ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</div>
        ) : list.length === 0 ? (
          <div className="p-10 text-center text-slate-400 space-y-2 dark:text-white/30">
            <CheckSquare className="mx-auto text-slate-300" size={40} />
            <p>No hay solicitudes pendientes para ti. ¡Al día!</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Empleado</th>
                <th className="px-4 py-3">Depto.</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Fechas</th>
                <th className="px-4 py-3">Motivo</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 w-40"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {list.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <UserCircle2 size={18} className="text-slate-400 dark:text-white/30" />
                      <div>
                        <p className="font-medium text-slate-900 dark:text-white">{p.employee_name}</p>
                        <p className="text-xs text-slate-400 dark:text-white/30">{p.employee_code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-white/60">{p.department || '—'}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 text-xs rounded-md bg-slate-100 text-slate-700 dark:bg-white/[0.06] dark:text-white/80">
                      {TYPE_LABEL[p.type] || p.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600 dark:text-white/60">
                    <div className="flex items-center gap-1"><Calendar size={12} /> {p.date_from}</div>
                    <div className="flex items-center gap-1 text-slate-400 dark:text-white/30"><span className="w-3" /> al {p.date_to}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600 max-w-xs dark:text-white/60">
                    <p className="line-clamp-2">{p.reason || <em className="text-slate-300">sin motivo</em>}</p>
                  </td>
                  <td className="px-4 py-3">
                    <StateBadge s={p.approval_state} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button disabled={actioning === p.id}
                        onClick={() => approve(p.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-medium disabled:opacity-50">
                        <Check size={14} /> Aprobar
                      </button>
                      <button disabled={actioning === p.id}
                        onClick={() => reject(p.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 text-xs font-medium disabled:opacity-50">
                        <X size={14} /> Rechazar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function StateBadge({ s }: { s: Perm['approval_state'] }) {
  const cfg: Record<Perm['approval_state'], { bg: string; text: string; icon: any }> = {
    pending:   { bg: 'bg-amber-100',   text: 'text-amber-800',   icon: Clock },
    level1_ok: { bg: 'bg-blue-100',    text: 'text-blue-800',    icon: Clock },
    level2_ok: { bg: 'bg-indigo-100',  text: 'text-indigo-800',  icon: Clock },
    approved:  { bg: 'bg-emerald-100', text: 'text-emerald-800', icon: Check },
    rejected:  { bg: 'bg-red-100',     text: 'text-red-800',     icon: X },
    cancelled: { bg: 'bg-slate-100',   text: 'text-slate-600',   icon: X },
  }
  const { bg, text, icon: Icon } = cfg[s]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${bg} ${text}`}>
      <Icon size={12} /> {STATE_LABEL[s]}
    </span>
  )
}
