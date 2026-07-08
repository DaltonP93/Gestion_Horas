'use client'
import { useEffect, useState } from 'react'
import { Calendar, Plus, X, AlertCircle, Clock, Check } from 'lucide-react'
import { api } from '@/lib/api'

interface MyPerm {
  id: number
  type: string
  date_from: string
  date_to: string
  reason: string | null
  status: string
  approval_state: 'pending'|'level1_ok'|'level2_ok'|'approved'|'rejected'|'cancelled'
  needs_level1: number
  needs_level2: number
  needs_final: number
  created_at: string
  rejection_reason: string | null
}

const TYPES: { id: string; label: string }[] = [
  { id: 'vacation',   label: 'Vacaciones' },
  { id: 'sick',       label: 'Enfermedad' },
  { id: 'personal',   label: 'Personal' },
  { id: 'maternity',  label: 'Maternidad' },
  { id: 'paternity',  label: 'Paternidad' },
  { id: 'study',      label: 'Estudio' },
  { id: 'legal',      label: 'Legal' },
  { id: 'other',      label: 'Otro' },
]
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.id, t.label]))

const STATE_LABEL: Record<MyPerm['approval_state'], string> = {
  pending:    'Pendiente (Nivel 1)',
  level1_ok:  'Nivel 1 OK — Nivel 2 pendiente',
  level2_ok:  'Nivel 2 OK — GTH pendiente',
  approved:   'Aprobado',
  rejected:   'Rechazado',
  cancelled:  'Cancelado',
}
const STATE_COLOR: Record<MyPerm['approval_state'], string> = {
  pending:   'bg-amber-100 text-amber-800',
  level1_ok: 'bg-blue-100 text-blue-800',
  level2_ok: 'bg-indigo-100 text-indigo-800',
  approved:  'bg-emerald-100 text-emerald-800',
  rejected:  'bg-red-100 text-red-800',
  cancelled: 'bg-slate-100 text-slate-600',
}

export default function MisPermisosPage() {
  const [list, setList] = useState<MyPerm[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const { data } = await api.get('/api/me/permissions')
      setList(data)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function cancel(id: number) {
    if (!confirm('¿Cancelar esta solicitud?')) return
    try {
      await api.post(`/api/me/permissions/${id}/cancel`)
      load()
    } catch (e: any) { alert(e.response?.data?.error || e.message) }
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-purple-500 flex items-center justify-center">
            <Calendar className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Mis permisos</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Tus solicitudes de ausencia y su estado de aprobación.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-500 hover:bg-purple-600 text-white text-sm font-medium">
          <Plus size={16} /> Nueva solicitud
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900">{error}</div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {loading ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</div>
        ) : list.length === 0 ? (
          <div className="p-10 text-center text-slate-400 space-y-2 dark:text-white/30">
            <Calendar className="mx-auto text-slate-300" size={40} />
            <p>No tenés solicitudes todavía.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Desde</th>
                <th className="px-4 py-3">Hasta</th>
                <th className="px-4 py-3">Motivo</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Solicitado</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {list.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-700 dark:bg-white/[0.06] dark:text-white/80">
                      {TYPE_LABEL[p.type] || p.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-white/80">{p.date_from}</td>
                  <td className="px-4 py-3 text-slate-700 dark:text-white/80">{p.date_to}</td>
                  <td className="px-4 py-3 text-xs text-slate-500 max-w-xs dark:text-white/40">
                    <p className="line-clamp-2">{p.reason || <em className="text-slate-300">—</em>}</p>
                    {p.rejection_reason && (
                      <p className="mt-1 text-red-600"><b>Rechazo:</b> {p.rejection_reason}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATE_COLOR[p.approval_state]}`}>
                      {STATE_LABEL[p.approval_state]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-white/40">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {['pending','level1_ok','level2_ok'].includes(p.approval_state) && (
                      <button onClick={() => cancel(p.id)}
                        className="text-red-600 hover:underline text-xs">Cancelar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load() }} />
      )}
    </div>
  )
}

function CreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ type: 'personal', date_from: '', date_to: '', reason: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    if (!form.date_from || !form.date_to) { setErr('Fechas requeridas'); return }
    setSaving(true); setErr('')
    try {
      await api.post('/api/me/permissions', form)
      onSaved()
    } catch (e: any) {
      setErr(e.response?.data?.error || e.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Nueva solicitud de permiso</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Tipo de permiso *</label>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Desde *</label>
            <input type="date" value={form.date_from}
              onChange={e => setForm({ ...form, date_from: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Hasta *</label>
            <input type="date" value={form.date_to}
              onChange={e => setForm({ ...form, date_to: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Motivo</label>
          <textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
            rows={3} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]"
            placeholder="Explicá brevemente el motivo..." />
        </div>

        {err && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-purple-500 hover:bg-purple-600 text-white disabled:opacity-60">
            <Check size={16} /> {saving ? 'Guardando...' : 'Enviar solicitud'}
          </button>
        </div>
      </div>
    </div>
  )
}
