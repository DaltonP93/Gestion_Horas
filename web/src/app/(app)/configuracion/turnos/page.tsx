'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Clock, Plus, Pencil, Trash2, Users, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Schedule {
  id: number
  name: string
  check_in: string
  check_out: string
  tolerance_in: number
  tolerance_out: number
  work_days: string
  active: number
  employees_count: number
}

// Convención DAYOFWEEK: 1=Dom, 2=Lun … 7=Sáb (semana domingo→sábado).
const DAY_LABELS = ['', 'Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

function daysToLabel(csv: string): string {
  if (!csv) return '—'
  const set = new Set(csv.split(',').map(s => s.trim()))
  return [1, 2, 3, 4, 5, 6, 7]
    .filter(d => set.has(String(d)))
    .map(d => DAY_LABELS[d])
    .join(' ')
}

export default function TurnosPage() {
  const [items, setItems] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/api/schedules')
      setItems(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar turnos')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('¿Eliminar este turno? Se archivará (soft delete).')) return
    try {
      await api.delete(`/api/schedules/${id}`)
      load()
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error al eliminar')
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link
          href="/configuracion"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-white/40"
        >
          <ArrowLeft size={16} aria-hidden="true" /> Volver
        </Link>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <Clock size={20} className="text-blue-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Turnos y horarios</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">
              Gestión de turnos de trabajo. Cada empleado puede tener asignado un turno.
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-semibold"
        >
          <Plus size={16} aria-hidden="true" /> Nuevo turno
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
              <th className="text-left px-4 py-3 font-semibold">Nombre</th>
              <th className="text-left px-4 py-3 font-semibold">Entrada</th>
              <th className="text-left px-4 py-3 font-semibold">Salida</th>
              <th className="text-left px-4 py-3 font-semibold">Tolerancia</th>
              <th className="text-left px-4 py-3 font-semibold">Días</th>
              <th className="text-left px-4 py-3 font-semibold">Empleados</th>
              <th className="text-right px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-slate-400 dark:text-white/30">
                No hay turnos creados. Creá el primero.
              </td></tr>
            )}
            {items.map(s => (
              <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{s.name}</td>
                <td className="px-4 py-3 font-mono text-slate-700 dark:text-white/80">{s.check_in?.slice(0, 5)}</td>
                <td className="px-4 py-3 font-mono text-slate-700 dark:text-white/80">{s.check_out?.slice(0, 5)}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-white/60">
                  +{s.tolerance_in}m / −{s.tolerance_out}m
                </td>
                <td className="px-4 py-3 text-xs text-slate-600 dark:text-white/60">{daysToLabel(s.work_days)}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded-full dark:bg-white/[0.06] dark:text-white/80">
                    <Users size={12} aria-hidden="true" /> {s.employees_count}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setEditing(s)}
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 mr-2"
                    aria-label={`Editar ${s.name}`}
                  >
                    <Pencil size={14} aria-hidden="true" /> Editar
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
                    aria-label={`Eliminar ${s.name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <ScheduleModal
          schedule={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function ScheduleModal({
  schedule, onClose, onSaved,
}: {
  schedule: Schedule | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!schedule
  const [form, setForm] = useState({
    name:          schedule?.name          ?? '',
    check_in:      schedule?.check_in?.slice(0, 5) ?? '08:00',
    check_out:     schedule?.check_out?.slice(0, 5) ?? '17:00',
    tolerance_in:  schedule?.tolerance_in  ?? 10,
    tolerance_out: schedule?.tolerance_out ?? 10,
    work_days:     schedule?.work_days     ?? '2,3,4,5,6',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function toggleDay(d: number) {
    const set = new Set(form.work_days.split(',').filter(Boolean))
    const key = String(d)
    if (set.has(key)) set.delete(key); else set.add(key)
    const days = [1, 2, 3, 4, 5, 6, 7].filter(x => set.has(String(x))).join(',')
    setForm(f => ({ ...f, work_days: days }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      if (isEdit) {
        await api.put(`/api/schedules/${schedule!.id}`, form)
      } else {
        await api.post('/api/schedules', form)
      }
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const activeDays = new Set(form.work_days.split(',').filter(Boolean))

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 dark:bg-white/[0.04]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="schedule-modal-title" className="text-lg font-bold text-slate-900 dark:text-white">
            {isEdit ? 'Editar turno' : 'Nuevo turno'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="text-slate-400 hover:text-slate-600 dark:text-white/30"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="sch-name" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Nombre</label>
            <input
              id="sch-name"
              type="text"
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              placeholder="Administrativo, Operaciones, etc."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sch-in" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Entrada</label>
              <input
                id="sch-in"
                type="time"
                required
                value={form.check_in}
                onChange={e => setForm(f => ({ ...f, check_in: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              />
            </div>
            <div>
              <label htmlFor="sch-out" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Salida</label>
              <input
                id="sch-out"
                type="time"
                required
                value={form.check_out}
                onChange={e => setForm(f => ({ ...f, check_out: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sch-tin" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Tolerancia entrada (min)</label>
              <input
                id="sch-tin"
                type="number"
                min={0}
                max={120}
                value={form.tolerance_in}
                onChange={e => setForm(f => ({ ...f, tolerance_in: Number(e.target.value) }))}
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              />
            </div>
            <div>
              <label htmlFor="sch-tout" className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Tolerancia salida (min)</label>
              <input
                id="sch-tout"
                type="number"
                min={0}
                max={120}
                value={form.tolerance_out}
                onChange={e => setForm(f => ({ ...f, tolerance_out: Number(e.target.value) }))}
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              />
            </div>
          </div>

          <div>
            <span className="block text-sm font-medium text-slate-700 mb-2 dark:text-white/80">Días laborables</span>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 7].map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  aria-pressed={activeDays.has(String(d))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                    activeDays.has(String(d))
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {DAY_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-white/80"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? 'Guardando...' : (isEdit ? 'Guardar cambios' : 'Crear turno')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
