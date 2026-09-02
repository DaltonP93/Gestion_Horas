'use client'
/**
 * Candidatos — ABM mínimo + conversión trazable a empleado (FASE F2).
 *
 * La escritura está protegida en la API por permiso granular y por el flag
 * fail-closed PEOPLE_WRITE_ENABLED. La conversión NO crea empleados: enlaza a
 * un empleado existente (por id). La lectura funciona siempre; el 503 de sólo
 * lectura se muestra sin romper la pantalla.
 */
import { useEffect, useState } from 'react'
import { UserPlus, Plus, Save, X, ArrowRightLeft } from 'lucide-react'
import { api } from '@/lib/api'

type Status = 'new' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected'
interface Candidate {
  id: number
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  position_applied: string | null
  status: Status
  converted_employee_id: number | null
}

const STATUS_LABEL: Record<Status, string> = {
  new: 'Nuevo', screening: 'Preselección', interview: 'Entrevista',
  offer: 'Oferta', hired: 'Contratado', rejected: 'Rechazado',
}

export default function CandidatosPage() {
  const [rows, setRows] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Candidate | null>(null)
  const [creating, setCreating] = useState(false)
  const [converting, setConverting] = useState<Candidate | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const data = await api.get('/api/candidates').then(r => (r.data?.data ?? []) as Candidate[])
      setRows(data)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-cyan-600 flex items-center justify-center">
            <UserPlus className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Candidatos</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Postulantes y su conversión trazable a empleado.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium">
          <Plus size={16} /> Nuevo
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
            <tr>
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Puesto</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3 w-40"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {loading && <tr><td colSpan={4} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && rows.length === 0 && !error && (
              <tr><td colSpan={4} className="p-8 text-center text-slate-400 dark:text-white/30">Sin candidatos cargados</td></tr>
            )}
            {rows.map(c => (
              <tr key={c.id}>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{c.first_name} {c.last_name}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-white/60">{c.position_applied || '—'}</td>
                <td className="px-4 py-3">
                  <span className="text-xs font-medium text-slate-700 dark:text-white/70">{STATUS_LABEL[c.status]}</span>
                  {c.converted_employee_id && <span className="ml-2 text-xs text-emerald-600">→ emp. #{c.converted_employee_id}</span>}
                </td>
                <td className="px-4 py-3 text-right space-x-3">
                  <button onClick={() => setEditing(c)} className="text-blue-600 hover:underline text-sm font-medium">Editar</button>
                  {!c.converted_employee_id && (
                    <button onClick={() => setConverting(c)} className="text-emerald-600 hover:underline text-sm font-medium inline-flex items-center gap-1">
                      <ArrowRightLeft size={13} /> Convertir
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <CandidateFormModal candidate={editing} creating={creating}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }} />
      )}
      {converting && (
        <ConvertModal candidate={converting}
          onClose={() => setConverting(null)}
          onDone={() => { setConverting(null); load() }} />
      )}
    </div>
  )
}

function CandidateFormModal({ candidate, creating, onClose, onSaved }: {
  candidate: Candidate | null; creating: boolean; onClose: () => void; onSaved: () => void
}) {
  const [firstName, setFirstName] = useState(candidate?.first_name || '')
  const [lastName, setLastName] = useState(candidate?.last_name || '')
  const [email, setEmail] = useState(candidate?.email || '')
  const [phone, setPhone] = useState(candidate?.phone || '')
  const [position, setPosition] = useState(candidate?.position_applied || '')
  const [status, setStatus] = useState<Status>(candidate?.status || 'new')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setSaving(true); setError('')
    try {
      const payload = {
        first_name: firstName, last_name: lastName,
        email: email || null, phone: phone || null,
        position_applied: position || null, status,
      }
      if (creating) await api.post('/api/candidates', payload)
      else          await api.patch(`/api/candidates/${candidate!.id}`, payload)
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{creating ? 'Nuevo candidato' : `Editar: ${candidate?.first_name}`}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre *"><input value={firstName} onChange={e => setFirstName(e.target.value)} className={inputCls} /></Field>
          <Field label="Apellido *"><input value={lastName} onChange={e => setLastName(e.target.value)} className={inputCls} /></Field>
          <Field label="Email"><input value={email} onChange={e => setEmail(e.target.value)} className={inputCls} /></Field>
          <Field label="Teléfono"><input value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} /></Field>
          <Field label="Puesto"><input value={position} onChange={e => setPosition(e.target.value)} className={inputCls} /></Field>
          <Field label="Estado">
            <select value={status} onChange={e => setStatus(e.target.value as Status)} className={inputCls}>
              {(Object.keys(STATUS_LABEL) as Status[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
        </div>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={handleSave} disabled={saving || !firstName || !lastName}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-cyan-600 hover:bg-cyan-700 text-white disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConvertModal({ candidate, onClose, onDone }: { candidate: Candidate; onClose: () => void; onDone: () => void }) {
  const [employeeId, setEmployeeId] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleConvert() {
    setSaving(true); setError('')
    try {
      await api.post(`/api/candidates/${candidate.id}/convert`, {
        employee_id: parseInt(employeeId, 10),
        reason: reason || null,
      })
      onDone()
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al convertir')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Convertir a empleado</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        <p className="text-sm text-slate-500 dark:text-white/50">
          Enlaza <b>{candidate.first_name} {candidate.last_name}</b> a un empleado existente (por id). No crea empleados.
        </p>
        <Field label="ID de empleado existente *">
          <input value={employeeId} onChange={e => setEmployeeId(e.target.value)} inputMode="numeric" className={inputCls} />
        </Field>
        <Field label="Motivo">
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Opcional — queda en la auditoría" className={inputCls} />
        </Field>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={handleConvert} disabled={saving || !employeeId}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60">
            <ArrowRightLeft size={16} /> {saving ? 'Convirtiendo...' : 'Convertir'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:border-white/[0.08]'
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">{label}</label>
      {children}
    </div>
  )
}
