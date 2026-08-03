'use client'
/**
 * EmployeeEditModal — edición completa de la ficha del empleado.
 *
 * Consolida en un único modal toda la superficie editable. Un solo flujo de
 * guardado (atómico contra `PUT /api/employees/:id`), un solo botón
 * "Guardar", y ninguna posibilidad de dejar cambios parciales.
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
 * Notas de estabilidad (hotfix):
 *   - Los controles viven en `EmployeeFormFields` (ámbito de módulo). Cuando
 *     se definían dentro de este componente, cada `setForm` creaba un tipo
 *     nuevo y React remontaba el input, perdiendo el foco por tecla.
 *   - El snapshot del formulario se toma SÓLO al abrir o al cambiar de
 *     empleado. Un refetch de React Query mientras el modal está abierto ya
 *     no pisa lo que el usuario escribió.
 *   - Se renderiza con `createPortal` sobre `document.body` para no heredar
 *     `overflow`/`transform`/`z-index` del layout de la aplicación.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X, Save, Plus, User, Briefcase, ShieldCheck, Coins, Users } from 'lucide-react'
import { api, employeesApi } from '@/lib/api'
import PaymentTypeModal, { canManagePaymentTypes } from './PaymentTypeModal'
import {
  TextField, SelectField, CurrencyField, fieldId, type Option,
} from './EmployeeFormFields'
import {
  snapshotOf,
  buildPayload,
  filterByCaps,
  type FieldName,
  type FormState,
  type Caps,
} from '@/lib/employeeEditPayload'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
  const panelRef = useRef<HTMLFormElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  // Clave del snapshot ya aplicado: `null` mientras está cerrado.
  const snapshotKeyRef = useRef<string | null>(null)

  const employeeId = employee?.id

  // Snapshot del formulario SÓLO al pasar de cerrado→abierto o al cambiar de
  // empleado. `employee` figura en las dependencias porque necesitamos su
  // valor fresco, pero la comparación de clave evita reiniciar el formulario
  // cuando React Query devuelve un objeto nuevo con el mismo empleado.
  useEffect(() => {
    if (!open) { snapshotKeyRef.current = null; return }
    const key = String(employeeId ?? '')
    if (snapshotKeyRef.current === key) return
    snapshotKeyRef.current = key
    setForm(snapshotOf(employee))
    setErrors({})
    setSaveError(null)
  }, [open, employeeId, employee])

  // Foco inicial + restauración al cerrar. `useLayoutEffect` para capturar el
  // opener antes de que el portal altere el foco.
  useLayoutEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    firstFieldRef.current?.focus()
    return () => {
      const opener = openerRef.current as HTMLElement | null
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [open])

  // Bloquea el scroll del documento mientras el modal está abierto: el único
  // contenedor scrolleable debe ser el cuerpo del modal.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

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

  const setField = useCallback((field: FieldName, value: string) => {
    setForm(f => ({ ...f, [field]: value }))
    setErrors(e => {
      if (!e[field]) return e
      const { [field]: _drop, ...rest } = e
      return rest
    })
    setSaveError(null)
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const root = panelRef.current
    // El submodal de tipos de pago se renderiza dentro de este overlay, así
    // que sus teclas burbujean hasta acá. Nada de lo que sigue debe actuar
    // sobre un evento nacido fuera del formulario: el trap creería que el
    // foco se escapó y lo arrastraría al panel de atrás, sacando al usuario
    // del diálogo que está viendo.
    if (!root || !root.contains(e.target as Node)) return

    if (e.key === 'Escape') {
      // El submodal gestiona su propio Escape.
      if (!saving && !payTypeModal) onClose()
      return
    }
    if (e.key !== 'Tab') return
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (!nodes.length) return
    const first = nodes[0]
    const last  = nodes[nodes.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus()
    }
  }, [saving, payTypeModal, onClose])

  async function onSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    setSaveError(null)
    const build = buildPayload(form)
    if (!build.ok) {
      setErrors(build.fieldErrors)
      const first = Object.keys(build.fieldErrors)[0] as FieldName
      document.getElementById(fieldId(first))?.focus()
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
      if (!updated) updated = await employeesApi.get(employee.id)
      qc.setQueryData(['employee', String(employee.id)], updated)
      qc.invalidateQueries({ queryKey: ['employees'] })
      onSaved(updated)
      onClose()
    } catch (err: any) {
      const status = err?.response?.status
      const data   = err?.response?.data
      const msg    = data?.error || err?.message || 'No se pudieron guardar los cambios.'
      if (data?.field && typeof data.field === 'string') {
        setErrors(e2 => ({ ...e2, [data.field]: msg }))
        document.getElementById(fieldId(data.field))?.focus()
      }
      setSaveError(status === 403
        ? `Sin permiso para modificar: ${msg}`
        : `Error del servidor: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  if (!open || typeof document === 'undefined') return null

  const canManagePT     = canManagePaymentTypes(currentUserRole || undefined)
  const canViewLegal    = !!caps.legal_view
  const disabledPersonal = !caps.personal_update || saving
  const disabledLegal    = !caps.legal_update || saving

  const overlay = (
    <div
      className="fixed inset-0 z-[100] h-[100dvh] overflow-hidden bg-black/60 sm:p-4"
      onKeyDown={onKeyDown}
    >
      <form
        ref={panelRef}
        onSubmit={onSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="emp-edit-title"
        aria-describedby="emp-edit-desc"
        className="mx-auto flex h-full max-h-full w-full min-w-0 max-w-4xl flex-col overflow-hidden bg-white shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl dark:bg-[#0d0d0f]"
      >
        {/* Header — fuera del contenedor scrolleable, siempre visible */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-6 sm:py-4 dark:border-white/[0.06]">
          <div className="min-w-0">
            <h2 id="emp-edit-title" className="truncate text-base font-bold text-slate-900 sm:text-lg dark:text-white">
              Editar empleado
            </h2>
            <p id="emp-edit-desc" className="truncate text-xs text-slate-500 dark:text-white/50">
              {employee?.first_name} {employee?.last_name} · los cambios se guardan todos juntos
            </p>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            aria-label="Cerrar sin guardar"
            className="shrink-0 rounded p-1 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body — único contenedor con scroll */}
        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
              <User size={16} className="text-blue-500" /> Datos personales
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField ref={firstFieldRef} field="first_name" label="Nombre" value={form.first_name} error={errors.first_name} onChange={setField} disabled={disabledPersonal} />
              <TextField field="last_name"  label="Apellido"  value={form.last_name}  error={errors.last_name}  onChange={setField} disabled={disabledPersonal} />
              <TextField field="email"      label="Email"     value={form.email}      error={errors.email}      onChange={setField} disabled={disabledPersonal} type="email" />
              <TextField field="phone"      label="Teléfono"  value={form.phone}      error={errors.phone}      onChange={setField} disabled={disabledPersonal} type="tel" />
              <TextField field="birth_date" label="Fecha de nacimiento" value={form.birth_date} error={errors.birth_date} onChange={setField} disabled={disabledPersonal} type="date" />
            </div>
          </section>

          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
              <Briefcase size={16} className="text-emerald-500" /> Datos laborales
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField   field="position"      label="Cargo"        value={form.position}      error={errors.position}      onChange={setField} disabled={disabledPersonal} />
              <SelectField field="department_id" label="Departamento" value={form.department_id} error={errors.department_id} onChange={setField} disabled={disabledPersonal} options={deptOpts} />
              <SelectField field="branch_id"     label="Sede"         value={form.branch_id}     error={errors.branch_id}     onChange={setField} disabled={disabledPersonal} options={branchOpts} />
              <SelectField field="schedule_id"   label="Turno / horario" value={form.schedule_id} error={errors.schedule_id} onChange={setField} disabled={disabledPersonal} options={scheduleOpts} />
              <TextField   field="hire_date"     label="Fecha de ingreso" value={form.hire_date}  error={errors.hire_date}     onChange={setField} disabled={disabledPersonal} type="date"
                           helper="La antigüedad se calcula automáticamente desde esta fecha" />
            </div>
          </section>

          {canViewLegal && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
                <ShieldCheck size={16} className="text-cyan-500" /> Datos legales (MTESS / IPS)
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField field="document_number" label="C.I."   value={form.document_number} error={errors.document_number} onChange={setField} disabled={disabledLegal} />
                <TextField field="ips_number"      label="N° IPS" value={form.ips_number}      error={errors.ips_number}      onChange={setField} disabled={disabledLegal} />
              </div>
            </section>
          )}

          {canViewLegal && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
                <Coins size={16} className="text-amber-500" /> Datos salariales
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CurrencyField field="salary_base" label="Salario base (Gs.)" value={form.salary_base} error={errors.salary_base} onChange={setField} disabled={saving} readOnly={!caps.legal_update} />
                <SelectField
                  field="pay_type"
                  label="Tipo de pago"
                  value={form.pay_type}
                  error={errors.pay_type}
                  onChange={setField}
                  disabled={disabledLegal}
                  options={payTypeOpts.length ? payTypeOpts : [{ value: 'mensualizado', label: 'Mensualizado' }]}
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

          {canViewLegal && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-white/80">
                <Users size={16} className="text-fuchsia-500" /> Datos complementarios
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SelectField
                  field="gender"
                  label="Género"
                  value={form.gender}
                  error={errors.gender}
                  onChange={setField}
                  disabled={disabledLegal}
                  options={[
                    { value: '',  label: '—' },
                    { value: 'M', label: 'Masculino' },
                    { value: 'F', label: 'Femenino' },
                    { value: 'O', label: 'Otro' },
                  ]}
                />
                <TextField field="children_count" label="N° de hijos" value={form.children_count} error={errors.children_count} onChange={setField} disabled={disabledLegal} type="number" inputMode="numeric" />
              </div>
            </section>
          )}
        </div>

        {/* Footer — fuera del contenedor scrolleable */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4 dark:border-white/[0.06]">
          <div className="min-w-0 flex-1">
            {saveError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
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

  return createPortal(overlay, document.body)
}
