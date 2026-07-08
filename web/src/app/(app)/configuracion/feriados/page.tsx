'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Calendar, Plus, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Holiday {
  id: number
  name: string
  date: string
  type: 'national' | 'company' | 'regional'
  active: number
}

const TYPE_LABELS = { national: 'Nacional', company: 'Empresa', regional: 'Regional' }
const TYPE_COLORS = {
  national: 'bg-red-100 text-red-700',
  company:  'bg-blue-100 text-blue-700',
  regional: 'bg-amber-100 text-amber-700',
}

export default function FeriadosPage() {
  const [items, setItems] = useState<Holiday[]>([])
  const [year, setYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/api/holidays', { params: { year } })
      setItems(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar feriados')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [year])

  async function handleDelete(id: number) {
    if (!confirm('¿Eliminar este feriado?')) return
    try { await api.delete(`/api/holidays/${id}`); load() }
    catch (e: any) { alert(e?.response?.data?.error || 'Error') }
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
          <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center">
            <Calendar size={20} className="text-red-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Feriados y días no laborables</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">
              Los feriados se excluyen del cálculo de ausentismo y retardos.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="year-sel" className="text-sm text-slate-600 dark:text-white/60">Año:</label>
          <select
            id="year-sel"
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]"
          >
            {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-semibold"
          >
            <Plus size={16} aria-hidden="true" /> Nuevo feriado
          </button>
        </div>
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
              <th className="text-left px-4 py-3 font-semibold">Fecha</th>
              <th className="text-left px-4 py-3 font-semibold">Nombre</th>
              <th className="text-left px-4 py-3 font-semibold">Tipo</th>
              <th className="text-right px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan={4} className="text-center py-8 text-slate-400 dark:text-white/30">Sin feriados registrados para {year}</td></tr>
            )}
            {items.map(h => (
              <tr key={h.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                <td className="px-4 py-3 font-mono text-slate-700 dark:text-white/80">{h.date?.slice(0, 10)}</td>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{h.name}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block text-xs px-2 py-1 rounded-full ${TYPE_COLORS[h.type]}`}>
                    {TYPE_LABELS[h.type]}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleDelete(h.id)}
                    className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
                    aria-label={`Eliminar ${h.name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <HolidayModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load() }} />
      )}
    </div>
  )
}

function HolidayModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: '',
    date: new Date().toISOString().slice(0, 10),
    type: 'national' as const,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.post('/api/holidays', form)
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hol-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 id="hol-title" className="text-lg font-bold text-slate-900 dark:text-white">Nuevo feriado</h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-slate-400 hover:text-slate-600 dark:text-white/30">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="h-name" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Nombre</label>
            <input
              id="h-name" type="text" required value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              placeholder="Día de la Independencia"
            />
          </div>
          <div>
            <label htmlFor="h-date" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Fecha</label>
            <input
              id="h-date" type="date" required value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
            />
          </div>
          <div>
            <label htmlFor="h-type" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Tipo</label>
            <select
              id="h-type" value={form.type}
              onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}
              className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
            >
              <option value="national">Nacional</option>
              <option value="company">Empresa</option>
              <option value="regional">Regional</option>
            </select>
          </div>
          {error && (
            <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>
          )}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-white/80">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60">
              {saving ? 'Guardando...' : 'Crear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
