'use client'
/**
 * EditField — control de edición inline en formato "fila legal".
 *
 * Estructura de grilla estable (PR-B):
 *   [ etiqueta (col fija) ] [ control (min-width utilizable) ] [ acciones ]
 *
 * - En viewport ≥ sm la etiqueta ocupa ancho fijo y el control absorbe
 *   el resto sin nunca reducirse a 50-60 px.
 * - En viewport < sm apila los tres bloques.
 * - Enter guarda, Escape cancela. Foco visible; navegable por teclado.
 * - El mensaje de validación se renderiza debajo del control (no
 *   flotando sobre otros paneles del layout).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Edit2, Save, X, Plus } from 'lucide-react'
import { validateEmployeeField } from '@/lib/employeeFieldValidation'

export type FeedbackState = { kind: 'ok' | 'err'; msg: string } | null

export interface EditFieldProps {
  label: string
  value: string
  name: string
  type?: string
  options?: { value: string; label: string }[]
  onSave: (name: string, value: string) => Promise<void>
  readOnly?: boolean
  onFeedback?: (f: FeedbackState) => void
  min?: number
  step?: number
  /** Convierte el valor guardado en la cadena que se muestra en modo lectura. */
  formatDisplay?: (v: string) => string
  /** Prefijo textual dentro del campo (ej. "Gs.") en modo edición. */
  inputPrefix?: string
  /** Formatea el valor mientras se edita (ej. separadores de miles). */
  formatEditing?: (v: string) => string
  /** Normaliza el valor tipeado antes de enviarlo al backend. */
  parseEditing?: (v: string) => string
  /** Extra input mode hint para el teclado móvil. */
  inputMode?: 'numeric' | 'decimal' | 'text' | 'email' | 'tel' | 'url' | 'search'
  /** Acción opcional a la derecha (ej. botón "+" del catálogo). */
  actionSlot?: ReactNode
  /** Placeholder al editar. */
  placeholder?: string
}

export default function EditField(props: EditFieldProps) {
  const {
    label, value, name, type = 'text', options, onSave, readOnly = false, onFeedback,
    min, step, formatDisplay, inputPrefix, formatEditing, parseEditing, inputMode,
    actionSlot, placeholder,
  } = props

  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState(value || '')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const errId = `err-${name}`
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { setVal(value || '') }, [value])

  function onChange(next: string) {
    // Preserva la posición del cursor cuando se reformatea con separadores.
    // Nota: el reformateo es idempotente, así que no rompe UX.
    setVal(formatEditing ? formatEditing(next) : next)
  }

  async function handleSave() {
    const toSend = parseEditing ? parseEditing(val) : val
    const check = validateEmployeeField(name, toSend)
    if (!check.ok) {
      setError(check.error)
      onFeedback?.({ kind: 'err', msg: `${label}: ${check.error}` })
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSave(name, toSend)
      setEditing(false)
      onFeedback?.({ kind: 'ok', msg: `${label} actualizado.` })
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Error al guardar'
      setError(msg)
      onFeedback?.({ kind: 'err', msg: `${label}: ${msg}` })
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setEditing(false)
    setVal(value || '')
    setError(null)
  }

  const shownValue = value ? (formatDisplay ? formatDisplay(value) : value) : ''
  const displayValue = shownValue
    ? shownValue
    : <span className="text-slate-400 dark:text-white/30">—</span>

  return (
    <div
      data-testid={`edit-field-${name}`}
      className={
        'group py-3 border-b border-slate-50 last:border-0 dark:border-white/[0.05] ' +
        // Grilla estable en ≥sm: 8rem etiqueta / 1fr control / auto acciones.
        // Bajo sm apila. `min-w-0` obliga al control a caber sin desbordar.
        'sm:grid sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3'
      }
    >
      <label
        htmlFor={`fld-${name}`}
        className="text-xs uppercase tracking-wide text-slate-500 sm:text-sm sm:normal-case sm:tracking-normal dark:text-white/40"
      >
        {label}
      </label>

      {editing ? (
        <>
          <div className="flex items-center gap-2 min-w-0 mt-1 sm:mt-0">
            {options ? (
              <select
                id={`fld-${name}`}
                aria-label={label}
                aria-invalid={!!error}
                aria-describedby={error ? errId : undefined}
                value={val}
                onChange={e => setVal(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleSave() }
                  if (e.key === 'Escape') { e.preventDefault(); cancel() }
                }}
                className="min-w-[10rem] flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white"
              >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <div className="relative flex-1 min-w-[10rem]">
                {inputPrefix && (
                  <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-slate-400 dark:text-white/30">
                    {inputPrefix}
                  </span>
                )}
                <input
                  ref={inputRef}
                  id={`fld-${name}`}
                  aria-label={label}
                  aria-invalid={!!error}
                  aria-describedby={error ? errId : undefined}
                  type={type}
                  value={val}
                  min={min}
                  step={step}
                  inputMode={inputMode}
                  placeholder={placeholder}
                  onChange={e => onChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleSave() }
                    if (e.key === 'Escape') { e.preventDefault(); cancel() }
                  }}
                  className={
                    'w-full min-w-0 border border-slate-200 rounded-lg py-1.5 text-sm ' +
                    'focus:outline-none focus:ring-2 focus:ring-blue-500 ' +
                    'dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white ' +
                    (inputPrefix ? 'pl-9 pr-2' : 'px-2')
                  }
                  autoFocus
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 mt-1 sm:mt-0 justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              aria-label={`Guardar ${label}`}
              className="rounded-lg p-1.5 text-green-600 hover:bg-green-50 hover:text-green-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-green-500 dark:hover:bg-emerald-500/10"
            >
              <Save size={16} />
            </button>
            <button
              type="button"
              onClick={cancel}
              aria-label={`Cancelar edición de ${label}`}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:text-white/30 dark:hover:bg-white/[0.06]"
            >
              <X size={16} />
            </button>
            {actionSlot}
          </div>
          {error && (
            <p id={errId} className="col-start-1 sm:col-start-2 col-span-1 sm:col-span-2 text-xs text-red-600 mt-1 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          <span
            className="text-sm font-medium text-slate-900 truncate dark:text-white mt-1 sm:mt-0"
            title={typeof shownValue === 'string' ? shownValue : undefined}
          >
            {displayValue}
          </span>
          <div className="flex items-center gap-1 mt-1 sm:mt-0 justify-end">
            {actionSlot}
            {!readOnly && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Editar ${label}`}
                className={
                  'shrink-0 text-slate-400 hover:text-blue-600 focus-visible:text-blue-600 ' +
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded p-1.5 ' +
                  'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ' +
                  'transition-opacity'
                }
              >
                <Edit2 size={14} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Muestra un valor derivado, sin controles. Útil para "Antigüedad" que
// se calcula desde la fecha de ingreso y no debe editarse.
export function DerivedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3 border-b border-slate-50 last:border-0 dark:border-white/[0.05] sm:grid sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
      <span className="text-xs uppercase tracking-wide text-slate-500 sm:text-sm sm:normal-case sm:tracking-normal dark:text-white/40">
        {label}
      </span>
      <span className="text-sm font-medium text-slate-700 mt-1 sm:mt-0 dark:text-white/80">
        {value}
      </span>
      <span aria-hidden="true" className="hidden sm:block" />
    </div>
  )
}

// Botón "+" para adjuntar a un EditField con select (ej: crear nuevo tipo).
export function AddCatalogButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 rounded-lg p-1.5 text-blue-600 hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:bg-blue-500/10"
    >
      <Plus size={16} />
    </button>
  )
}
