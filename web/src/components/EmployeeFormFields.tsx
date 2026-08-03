'use client'
/**
 * EmployeeFormFields — controles del modal de edición del empleado.
 *
 * Viven en el ámbito del módulo (y no dentro de `EmployeeEditModal`) porque
 * definir un componente dentro del render crea un *tipo* nuevo en cada
 * pasada: React desmonta el árbol anterior y monta uno nuevo, con lo que el
 * input pierde el foco tras cada tecla. Al estar acá la identidad del tipo
 * es estable y el DOM se conserva entre renders.
 */

import { forwardRef } from 'react'
import { formatThousandsPY, stripThousands } from '@/lib/currency'
import type { FieldName } from '@/lib/employeeEditPayload'

export type Option = { value: string; label: string }

type CommonProps = {
  field: FieldName
  label: string
  value: string
  error?: string
  disabled?: boolean
  onChange: (field: FieldName, value: string) => void
}

export function fieldId(field: FieldName): string { return `emp-field-${field}` }

const BASE_CONTROL =
  'mt-1 block w-full min-w-0 rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 '
const OK_CONTROL =
  'border-slate-200 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]'
const ERR_CONTROL =
  'border-red-400 focus:ring-red-500 dark:border-red-500/50 dark:bg-white/[0.03]'

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block min-w-0">
      <span className="text-xs font-medium text-slate-600 dark:text-white/60">{children}</span>
    </label>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">
      {message}
    </p>
  )
}

export const TextField = forwardRef<HTMLInputElement, CommonProps & {
  type?: string
  placeholder?: string
  readOnly?: boolean
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  helper?: string
}>(function TextField(
  { field, label, value, error, disabled, readOnly, onChange, type = 'text', placeholder, inputMode, helper },
  ref
) {
  const id = fieldId(field)
  const errId = `${id}-err`
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        ref={ref}
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={e => onChange(field, e.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={error ? errId : undefined}
        className={BASE_CONTROL + (error ? ERR_CONTROL : OK_CONTROL)}
      />
      {helper && !error && (
        <p className="mt-1 text-[11px] text-slate-400 dark:text-white/30">{helper}</p>
      )}
      <FieldError id={errId} message={error} />
    </div>
  )
})

export function SelectField({
  field, label, value, error, disabled, onChange, options, actionSlot,
}: CommonProps & { options: Option[]; actionSlot?: React.ReactNode }) {
  const id = fieldId(field)
  const errId = `${id}-err`
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select
          id={id}
          value={value}
          onChange={e => onChange(field, e.target.value)}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? errId : undefined}
          className={
            'block w-full min-w-0 flex-1 basis-40 rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
            (error ? ERR_CONTROL : OK_CONTROL)
          }
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {actionSlot}
      </div>
      <FieldError id={errId} message={error} />
    </div>
  )
}

/**
 * Entrada de moneda PYG. `value` es SIEMPRE el entero canónico en string
 * ("3500000"); los separadores son sólo presentación. Por eso el valor que
 * se propaga hacia arriba pasa por `stripThousands` y nunca se re-formatea
 * sobre sí mismo.
 */
export function CurrencyField({
  field, label, value, error, disabled, readOnly, onChange,
}: CommonProps & { readOnly?: boolean }) {
  const id = fieldId(field)
  const errId = `${id}-err`
  const pretty = value === '' ? '' : formatThousandsPY(value)
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div
        className={
          'mt-1 flex min-w-0 items-center rounded-xl border px-3 focus-within:ring-2 ' +
          (error
            ? 'border-red-400 focus-within:ring-red-500 dark:border-red-500/50'
            : 'border-slate-200 focus-within:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]')
        }
      >
        <span className="pr-2 text-slate-400 select-none dark:text-white/40" aria-hidden>Gs.</span>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={pretty}
          onChange={e => onChange(field, stripThousands(e.target.value))}
          disabled={disabled}
          readOnly={readOnly}
          placeholder="0"
          aria-invalid={!!error}
          aria-describedby={error ? errId : undefined}
          className="block w-full min-w-0 bg-transparent py-2 text-sm focus:outline-none"
        />
      </div>
      <FieldError id={errId} message={error} />
    </div>
  )
}
