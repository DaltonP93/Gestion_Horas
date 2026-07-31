'use client'
/**
 * PaymentTypeModal — creación rápida de un nuevo tipo de pago desde
 * la ficha del empleado. Se abre con el botón "+" del selector.
 *
 * Sólo aparece si el usuario tiene permiso de administración (los
 * roles autorizados en /api/payment-types); el backend valida.
 * Al crear correctamente ejecuta `onCreated(code)` para que el
 * consumidor seleccione el nuevo valor automáticamente.
 */
import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { api } from '@/lib/api'

const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/

export default function PaymentTypeModal({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (code: string) => void
}) {
  const [code, setCode]   = useState('')
  const [name, setName]   = useState('')
  const [desc, setDesc]   = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!open) return null

  function reset() {
    setCode(''); setName(''); setDesc(''); setErr(null)
  }

  async function submit() {
    setErr(null)
    const codeTrim = code.trim()
    const nameTrim = name.trim()
    if (!CODE_RE.test(codeTrim)) {
      setErr('Código: sólo minúsculas, dígitos y guion bajo (empieza con letra).')
      return
    }
    if (nameTrim.length < 1 || nameTrim.length > 120) {
      setErr('Nombre requerido (máx. 120 caracteres).')
      return
    }
    setSaving(true)
    try {
      await api.post('/api/payment-types', {
        code: codeTrim,
        name: nameTrim,
        description: desc.trim() || null,
        active: true,
      })
      onCreated(codeTrim)
      reset()
      onClose()
    } catch (e: any) {
      const msg = e?.response?.data?.error
        || (e?.response?.data?.details?.[0]?.message ?? e?.message)
        || 'Error al crear el tipo de pago'
      setErr(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pt-modal-title"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
    >
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
        <div className="flex items-center justify-between">
          <h3 id="pt-modal-title" className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Plus size={18} className="text-blue-600" /> Nuevo tipo de pago
          </h3>
          <button aria-label="Cerrar" onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label htmlFor="pt-code" className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">
              Código (identificador, sin espacios)
            </label>
            <input
              id="pt-code"
              value={code}
              onChange={e => setCode(e.target.value.toLowerCase())}
              placeholder="p. ej. contrato_civil"
              autoFocus
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]"
            />
            <p className="text-[10px] text-slate-400 mt-1 dark:text-white/30">
              Sólo minúsculas, dígitos y guion bajo; empieza con letra.
            </p>
          </div>
          <div>
            <label htmlFor="pt-name" className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">
              Nombre visible
            </label>
            <input
              id="pt-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="p. ej. Contrato civil"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]"
            />
          </div>
          <div>
            <label htmlFor="pt-desc" className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">
              Descripción (opcional)
            </label>
            <textarea
              id="pt-desc"
              rows={2}
              value={desc}
              onChange={e => setDesc(e.target.value)}
              placeholder="Notas para RRHH / MTESS…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]"
            />
          </div>
        </div>

        {err && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60"
          >
            <Plus size={14} /> {saving ? 'Creando…' : 'Crear y seleccionar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Roles que pueden administrar el catálogo. Debe coincidir con el
// authorize() del backend en routes/paymentTypes.js.
export const PAYMENT_TYPE_MANAGERS = new Set(['super_admin', 'admin', 'gth', 'hr'])
export function canManagePaymentTypes(role: string | undefined | null): boolean {
  if (!role) return false
  return PAYMENT_TYPE_MANAGERS.has(role)
}
