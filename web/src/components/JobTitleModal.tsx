'use client'
/**
 * JobTitleModal — creación rápida de un cargo desde la ficha del empleado.
 * Se abre con el botón "+" del selector de cargo.
 *
 * Sólo aparece si el usuario tiene permiso de administración (los roles
 * autorizados en /api/job-titles); el backend valida igual.
 * Al crear correctamente ejecuta `onCreated(name)` para que el consumidor
 * seleccione el cargo nuevo automáticamente.
 *
 * A diferencia de los tipos de pago, un cargo no tiene código: el nombre
 * es la clave, porque `employees.position` guarda ese mismo texto.
 */
import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { api } from '@/lib/api'

const JOB_TITLE_MANAGERS = new Set(['super_admin', 'admin', 'gth', 'hr'])

export function canManageJobTitles(role: string | undefined | null): boolean {
  if (!role) return false
  return JOB_TITLE_MANAGERS.has(role)
}

export default function JobTitleModal({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!open) return null

  function reset() {
    setName(''); setDesc(''); setErr(null)
  }

  async function submit() {
    setErr(null)
    const nameTrim = name.trim()
    if (nameTrim.length < 1 || nameTrim.length > 100) {
      setErr('Nombre requerido (máx. 100 caracteres).')
      return
    }
    setSaving(true)
    try {
      await api.post('/api/job-titles', {
        name: nameTrim,
        description: desc.trim() || null,
        active: true,
      })
      onCreated(nameTrim)
      reset()
      onClose()
    } catch (e: any) {
      const msg = e?.response?.data?.error
        || (e?.response?.data?.details?.[0]?.message ?? e?.message)
        || 'Error al crear el cargo'
      setErr(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="jt-modal-title"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
    >
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
        <div className="flex items-center justify-between">
          <h3 id="jt-modal-title" className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Plus size={18} className="text-blue-600" /> Nuevo cargo
          </h3>
          <button type="button" onClick={onClose} aria-label="Cerrar"
            className="rounded p-1 hover:bg-slate-100 dark:hover:bg-white/[0.06]">
            <X size={18} />
          </button>
        </div>

        <div>
          <label htmlFor="jt-name" className="text-xs font-medium text-slate-600 dark:text-white/60">
            Nombre del cargo
          </label>
          <input
            id="jt-name"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Operario de producción"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
          />
        </div>

        <div>
          <label htmlFor="jt-desc" className="text-xs font-medium text-slate-600 dark:text-white/60">
            Descripción (opcional)
          </label>
          <input
            id="jt-desc"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
          />
        </div>

        {err && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {err}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.08] dark:text-white/70">
            Cancelar
          </button>
          <button type="button" onClick={submit} disabled={saving}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Creando…' : 'Crear cargo'}
          </button>
        </div>
      </div>
    </div>
  )
}
