'use client'
/**
 * EmployeeEditModal — edición completa de la ficha del empleado (PR 1).
 *
 * Consolida en un único modal toda la superficie editable que antes se
 * repartía entre `EditField` inline. Ventajas: un solo flujo de guardado
 * (atómico contra `PUT /api/employees/:id`), un solo botón "Guardar", y
 * ninguna posibilidad de dejar cambios parciales cuando algún campo falla.
 *
 * Secciones:
 *   1) Datos personales    (nombre, apellido, email, teléfono, nacimiento)
 *   2) Datos laborales     (cargo, departamento, sede, horario, ingreso)
 *   3) Datos legales       (C.I., N° IPS)                       [legal_view]
 *   4) Datos salariales    (salario base PYG, tipo de pago)     [legal_view]
 *   5) Datos complementarios (género, N° de hijos)              [legal_view]
 *
 * Antigüedad NO aparece: se deriva de `hire_date` y se muestra readonly en
 * la ficha principal. Estado (baja/reactivación) tampoco se toca aquí: su
 * flujo dedicado exige motivo + confirmación + auditoría + pending en reloj.
 *
 * Contrato de guardado:
 *   - Validación cliente por campo con feedback inline (aria-invalid).
 *   - Si algún campo falla, no se dispara el request.
 *   - El request es un solo PUT con todos los campos: el backend valida
 *     completo y aborta si algo falla, dejando la BD intacta.
 *   - `onSaved(updatedEmployee)` recibe la ficha completa recién guardada.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X, Save, Plus, User, Briefcase, ShieldCheck, Coins, Users } from 'lucide-react'
import { api, employeesApi } from '@/lib/api'
import { formatThousandsPY, stripThousands } from '@/lib/currency'
import PaymentTypeModal, { canManagePaymentTypes } from './PaymentTypeModal'
import {
  snapshotOf,
  buildPayload,
  filterByCaps,
  type FieldName,
  type FormState,
  type Caps,
} from '@/lib/employeeEditPayload'

type Option = { value: string; label: string }

export default function EmployeeEditModal({
  open, onClose, employee, caps, currentUserRole, onSaved,
}: {
  open: boolean
  onClose: () => void
  employee: any
  caps: Caps
  currentUserRole: string | undefined | null
  onSaved: (updated: any) => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<FormState>(() => snapshotOf(employee))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [payTypeModal, setPayTypeModal] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  // Resetea el formulario cada vez que se abre el modal con la ficha vigente.
  useEffect(() => {
    if (!open) return
    setForm(snapshotOf(employee))
    setErrors({})
    setSaveError(null)
    // Enfoca el primer campo editable al abrir.
    queueMicrotask(() => firstFieldRef.current?.focus())
  }, [open, employee])

  // Escape cierra (siempre y cuando no haya guardado en curso).
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, onClose])

  // ── Catálogos ──────────────────────────────────────────────────
  const { data: departments } = useQuery({
    queryKey: ['catalog', 'departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    enabled: open,
    staleTime: 60_000,
  })
  const { data: branches } = useQuery({
    queryKey: ['catalog', 'branches'],
    queryFn: () => api.get('/api/branches?active=1').then(r => r.data),
    enabled: open,
    staleTime: 60_000,
  })
  const { data: schedules } = useQuery({
    queryKey: ['catalog', 'schedules'],
    queryFn: () => api.get('/api/schedules').then(r => r.data),
    enabled: open,
    staleTime: 60_000,
  })
  const { data: payTypesData } = useQuery({
    queryKey: ['catalog', 'pay-types'],
    queryFn: () => api.get('/api/catalogs/pay-types').then(r => r.data),
    enabled: open,
    staleTime: 60_000,
  })

  const deptOpts = useMemo<Option[]>(
    () => [{ value: '', label: '—' }, ...(departments || []).map((d: any) => ({ value: String(d.id), label: d.name }))],
    [departments]
  )
  const branchOpts = useMemo<Option[]>(
    () => [{ value: '', label: '—' }, ...(branches || []).map((b: any) => ({ value: String(b.id), label: b.name }))],
    [branches]
  )
  const scheduleOpts = useMemo<Option[]>(
    () => [{ value: '', label: 'Sin horario' }, ...(schedules || []).map((s: any) => ({ value: String(s.id), label: s.name }))],
    [schedules]
  )
  const payTypeOpts = useMemo<Option[]>(() => {
    const raw = (payTypesData?.data as { value: string; label: string; active?: boolean }[] | undefined) || []
    return raw.filter(p => p.active !== false).map(p => ({ value: p.value, label: p.label }))
  }, [payTypesData])

  const canManagePT = canManagePaymentTypes(currentUserRole || undefined)
  const canEditPersonal = !!caps.personal_update
  const canViewLegal    = !!caps.legal_view
  const canEditLegal    = !!caps.legal_update

  if (!open) return null

  // ── Handlers ───────────────────────────────────────────────────
  function setField(field: FieldName, value: string) {
    setForm(f => ({ ...f, [field]: value }))
    // Limpia el error del campo al empezar a tipear otra vez.
    if (errors[field]) setErrors(e => { const { [field]: _drop, ...rest } = e; return rest })
    setSaveError(null)
  }

  async function onSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    setSaveError(null)
    const build = buildPayload(form)
    if (!build.ok) {
      setErrors(build.fieldErrors)
      // Enfoca el primer campo con error para accesibilidad.
      const first = Object.keys(build.fieldErrors)[0]
      const el = document.getElementById(`emp-field-${first}`)
      el?.focus()
      return
    }
    setSaving(true)
    try {
      const filtered = filterByCaps(build.payload, caps)
      if (!Object.keys(filtered).length) {
        setSaveError('Sin cambios para guardar.')
        setSaving(false)
        return
      }
      const resp = await employeesApi.update(employee.id, filtered) as { employee?: any; changed?: string[]; message?: string }
      // El backend responde con la ficha completa recién persistida. Si no
      // vino (compat), forzamos una relectura antes de cerrar.
      let updated = resp?.employee
      if (!updated) {
        updated = await employeesApi.get(employee.id)
      }
      qc.setQueryData(['employee', String(employee.id)], updated)
      qc.invalidateQueries({ queryKey: ['employees'] })
      onSaved(updated)
      onClose()
    } catch (err: any) {
      const status = err?.response?.status
      const data   = err?.response?.data
      const msg    = data?.error || err?.message || 'No se pudieron guardar los cambios.'
      // Errores por campo del backend: { error, field } → resalta el campo.
      if (data?.field && typeof data.field === 'string') {
        setErrors(e => ({ ...e, [data.field]: msg }))
        const el = document.getElementById(`emp-field-${data.field}`)
        el?.focus()
      }
      setSaveError(status === 403
        ? `Sin permiso para modificar: ${msg}`
        : `Error del servidor: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Render helpers ─────────────────────────────────────────────
  function TextInput({
    field, label, type = 'text', placeholder, autoFocus, disabled, readOnly, inputMode, helper,
  }: {
    field: FieldName
    label: string
    type?: string
    placeholder?: string
    autoFocus?: boolean
    disabled?: boolean
    readOnly?: boolean
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
    helper?: string
  }) {
    const err = errors[field]
    const id  = `emp-field-${field}`
    const errId = `${id}-err`
    return (
      <label htmlFor={id} className="block">
        <span className="text-xs font-medium text-slate-600 dark:text-white/60">{label}</span>
        <input
          id={id}
          ref={autoFocus ? firstFieldRef : undefined}
          type={type}
          inputMode={inputMode}
          value={form[field] ?? ''}
          onChange={e => setField(field, e.target.value)}
          disabled={disabled || saving}
          readOnly={readOnly}
          placeholder={placeholder}
          aria-invalid={!!err}
          aria-describedby={err ? errId : undefined}
          className={
            'mt-1 block w-full rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
            (err
              ? 'border-red-400 focus:ring-red-500 dark:border-red-500/50 dark:bg-white/[0.03]'
              : 'border-slate-200 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]')
          }
        />
        {helper && !err && (
          <p className="mt-1 text-[11px] text-slate-400 dark:text-white/30">{helper}</p>
        )}
        {err && (
          <p id={errId} role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>
        )}
      </label>
    )
  }

  function SelectInput({
    field, label, options, disabled, readOnly, actionSlot,
  }: {
    field: FieldName
    label: string
    options: Option[]
    disabled?: boolean
    readOnly?: boolean
    actionSlot?: React.ReactNode
  }) {
    const err = errors[field]
    const id  = `emp-field-${field}`
    const errId = `${id}-err`
    return (
      <div>
        <label htmlFor={id} className="block">
          <span className="text-xs font-medium text-slate-600 dark:text-white/60">{label}</span>
        </label>
        <div className="mt-1 flex items-center gap-2">
          <select
            id={id}
            value={form[field] ?? ''}
            onChange={e => setField(field, e.target.value)}
            disabled={disabled || saving || readOnly}
            aria-invalid={!!err}
            aria-describedby={err ? errId : undefined}
            className={
              'block w-full min-w-[10rem] rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
              (err
                ? 'border-red-400 focus:ring-red-500 dark:border-red-500/50 dark:bg-white/[0.03]'
                : 'border-slate-200 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]')
            }
          >
            {options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {actionSlot}
        </div>
        {err && (
          <p id={errId} role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>
        )}
      </div>
    )
  }

  function CurrencyInput({ field, label, readOnly }: { field: FieldName; label: string; readOnly?: boolean }) {
    const err = errors[field]
    const id  = `emp-field-${field}`
    const errId = `${id}-err`
    const raw = form[field] ?? ''
    const pretty = raw === '' ? '' : formatThousandsPY(stripThousands(raw))
    return (
      <label htmlFor={id} className="block">
        <span className="text-xs font-medium text-slate-600 dark:text-white/60">{label}</span>
        <div className={
          'mt-1 flex items-center rounded-xl border px-3 focus-within:ring-2 ' +
          (err
            ? 'border-red-400 focus-within:ring-red-500 dark:border-red-500/50'
            : 'border-slate-200 focus-within:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]')
        }>
          <span className="pr-2 text-slate-400 select-none dark:text-white/40" aria-hidden>Gs.</span>
          <input
            id={id}
            type="text"
            inputMode="numeric"
            value={pretty}
            onChange={e => setField(field, stripThousands(e.target.value))}
            disabled={saving}
            readOnly={readOnly}
            placeholder="0"
            aria-invalid={!!err}
            aria-describedby={err ? errId : undefined}
            className="block w-full min-w-[8rem] bg-transparent py-2 text-sm focus:outline-none"
          />
        </div>
        {err && (
          <p id={errId} role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>
        )}
      </label>
    )
  }

  const disabledPersonal = !canEditPersonal
  const disabledLegal    = !canEditLegal

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="emp-edit-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl dark:bg-[#0d0d0f]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4 dark:border-white/[0.06]">
          <h2 id="emp-edit-title" className="text-lg font-bold text-slate-900 dark:text-white">
            Editar empleado — {employee?.first_name} {employee?.last_name}
          </h2>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            aria-label="Cerrar sin guardar"
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5 space-y-8">
          {/* Datos personales */}
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
              <User size={16} className="text-blue-500" /> Datos personales
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextInput field="first_name" label="Nombre" autoFocus disabled={disabledPersonal} />
              <TextInput field="last_name"  label="Apellido" disabled={disabledPersonal} />
              <TextInput field="email"      label="Email" type="email" disabled={disabledPersonal} />
              <TextInput field="phone"      label="Teléfono" type="tel" disabled={disabledPersonal} />
              <TextInput field="birth_date" label="Fecha de nacimiento" type="date" disabled={disabledPersonal} />
            </div>
          </section>

          {/* Datos laborales */}
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
              <Briefcase size={16} className="text-emerald-500" /> Datos laborales
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextInput   field="position"      label="Cargo" disabled={disabledPersonal} />
              <SelectInput field="department_id" label="Departamento" options={deptOpts} disabled={disabledPersonal} />
              <SelectInput field="branch_id"     label="Sede" options={branchOpts} disabled={disabledPersonal} />
              <SelectInput field="schedule_id"   label="Turno / horario" options={scheduleOpts} disabled={disabledPersonal} />
              <TextInput   field="hire_date"     label="Fecha de ingreso" type="date" disabled={disabledPersonal}
                          helper="La antigüedad se calcula automáticamente desde esta fecha" />
            </div>
          </section>

          {/* Datos legales — sólo si el rol puede verlos */}
          {canViewLegal && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
                <ShieldCheck size={16} className="text-cyan-500" /> Datos legales (MTESS / IPS)
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextInput field="document_number" label="C.I." disabled={disabledLegal} />
                <TextInput field="ips_number"      label="N° IPS" disabled={disabledLegal} />
              </div>
            </section>
          )}

          {/* Datos salariales — sólo si el rol puede verlos */}
          {canViewLegal && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
                <Coins size={16} className="text-amber-500" /> Datos salariales
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CurrencyInput field="salary_base" label="Salario base (Gs.)" readOnly={disabledLegal} />
                <SelectInput
                  field="pay_type"
                  label="Tipo de pago"
                  options={payTypeOpts.length ? payTypeOpts : [{ value: 'mensualizado', label: 'Mensualizado' }]}
                  disabled={disabledLegal}
                  actionSlot={
                    canManagePT ? (
                      <button
                        type="button"
                        onClick={() => setPayTypeModal(true)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white/70"
                      >
                        <Plus size={13} /> Nuevo tipo de pago
                      </button>
                    ) : null
                  }
                />
              </div>
            </section>
          )}

          {/* Datos complementarios — sólo si el rol puede verlos */}
          {canViewLegal && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
                <Users size={16} className="text-fuchsia-500" /> Datos complementarios
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SelectInput
                  field="gender"
                  label="Género"
                  options={[
                    { value: '',  label: '—' },
                    { value: 'M', label: 'Masculino' },
                    { value: 'F', label: 'Femenino' },
                    { value: 'O', label: 'Otro' },
                  ]}
                  disabled={disabledLegal}
                />
                <TextInput field="children_count" label="N° de hijos" type="number" inputMode="numeric" disabled={disabledLegal} />
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-slate-100 px-6 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.06]">
          <div className="min-w-0 flex-1">
            {saveError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
            )}
          </div>
          <div className="flex gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => !saving && onClose()}
              disabled={saving}
              className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-60 dark:text-white/60 dark:hover:bg-white/[0.06]"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              <Save size={14} /> {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      </form>

      <PaymentTypeModal
        open={payTypeModal}
        onClose={() => setPayTypeModal(false)}
        onCreated={async (code) => {
          await qc.invalidateQueries({ queryKey: ['catalog', 'pay-types'] })
          setField('pay_type', code)
        }}
      />
    </div>
  )
}
