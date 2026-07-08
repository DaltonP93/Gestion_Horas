'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Building2, Plus, Edit, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Branch {
  id: number
  code: string
  name: string
  address: string | null
  city: string | null
  phone: string | null
  timezone: string
  active: number
  employee_count: number
  device_count: number
}

export default function SedesPage() {
  const [items, setItems] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Branch | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/api/branches')
      setItems(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar sedes')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleToggle(b: Branch) {
    try {
      await api.put(`/api/branches/${b.id}`, { active: b.active ? 0 : 1 })
      load()
    } catch (e: any) { alert(e?.response?.data?.error || 'Error') }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link href="/configuracion" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-white/40">
          <ArrowLeft size={16} aria-hidden="true" /> Volver
        </Link>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <Building2 size={20} className="text-indigo-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Sedes / Sucursales</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Gestión multi-sede: cada empleado y reloj pertenece a una sede.</p>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-semibold"
        >
          <Plus size={16} aria-hidden="true" /> Nueva sede
        </button>
      </div>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow border border-slate-200 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.08]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-white/[0.03] dark:text-white/60">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Código</th>
              <th className="text-left px-4 py-3 font-semibold">Nombre</th>
              <th className="text-left px-4 py-3 font-semibold">Ciudad</th>
              <th className="text-center px-4 py-3 font-semibold">Empleados</th>
              <th className="text-center px-4 py-3 font-semibold">Relojes</th>
              <th className="text-center px-4 py-3 font-semibold">Estado</th>
              <th className="text-right px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-slate-400 dark:text-white/30">Sin sedes registradas</td></tr>
            )}
            {items.map(b => (
              <tr key={b.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                <td className="px-4 py-3 font-mono text-slate-700 dark:text-white/80">{b.code}</td>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{b.name}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-white/60">{b.city || '—'}</td>
                <td className="px-4 py-3 text-center">{b.employee_count}</td>
                <td className="px-4 py-3 text-center">{b.device_count}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block text-xs px-2 py-1 rounded-full ${b.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {b.active ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => setEditing(b)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800">
                    <Edit size={14} aria-hidden="true" /> Editar
                  </button>
                  <button onClick={() => handleToggle(b)} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-800 dark:text-white/60">
                    {b.active ? 'Desactivar' : 'Activar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <BranchModal
          branch={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function BranchModal({ branch, onClose, onSaved }: { branch: Branch | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!branch
  const [form, setForm] = useState({
    code: branch?.code || '',
    name: branch?.name || '',
    address: branch?.address || '',
    city: branch?.city || '',
    phone: branch?.phone || '',
    timezone: branch?.timezone || 'America/Asuncion',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      if (isEdit) await api.put(`/api/branches/${branch!.id}`, form)
      else await api.post('/api/branches', form)
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="sede-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 id="sede-title" className="text-lg font-bold text-slate-900 dark:text-white">{isEdit ? 'Editar sede' : 'Nueva sede'}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={20} aria-hidden="true" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Código *" value={form.code} onChange={v => setForm(f => ({ ...f, code: v }))} required disabled={isEdit} />
          <Field label="Nombre *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Dirección" value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} />
          <Field label="Ciudad" value={form.city} onChange={v => setForm(f => ({ ...f, city: v }))} />
          <Field label="Teléfono" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          <Field label="Zona horaria" value={form.timezone} onChange={v => setForm(f => ({ ...f, timezone: v }))} />
          {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-white/80">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60">
              {saving ? 'Guardando...' : (isEdit ? 'Guardar' : 'Crear')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, required, disabled }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; disabled?: boolean }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">{label}</label>
      <input
        type="text"
        required={required}
        disabled={disabled}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-500 dark:border-white/[0.08]"
      />
    </div>
  )
}
