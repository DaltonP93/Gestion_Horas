'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  ArrowLeft, User, Mail, Phone, Building2, Clock,
  Calendar, Edit2, Save, X, CheckCircle, XCircle,
  AlertCircle, Briefcase, UserX, UserCheck, ShieldAlert
} from 'lucide-react'
import Link from 'next/link'
import { employeesApi, api } from '@/lib/api'
import { fmtTimePy } from '@/lib/datetime'
import { validateEmployeeField, isLegalField } from '@/lib/employeeFieldValidation'
import EmployeeNotes from '@/components/EmployeeNotes'
import EmployeeDocuments from '@/components/EmployeeDocuments'
import BiometriaRelojes from '@/components/BiometriaRelojes'
import dynamic from 'next/dynamic'
const FaceEnroll = dynamic(() => import('@/components/FaceEnroll'), { ssr: false })

// ─── Helpers ──────────────────────────────────────────────────────
function minsToHM(mins: number | null) {
  if (!mins || mins <= 0) return '0:00'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

// Hora de marcación en zona de Paraguay (no la del navegador).
function fmtTime(dt: string | null) {
  return fmtTimePy(dt)
}

const STATUS_ROW: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  present:    { label: 'Presente',  cls: 'bg-green-50  text-green-700',  icon: <CheckCircle size={14} /> },
  late:       { label: 'Retardo',   cls: 'bg-amber-50  text-amber-700',  icon: <AlertCircle size={14} /> },
  absent:     { label: 'Ausente',   cls: 'bg-red-50    text-red-700',    icon: <XCircle size={14} />     },
  permission: { label: 'Permiso',   cls: 'bg-purple-50 text-purple-700', icon: <Calendar size={14} />    },
}

// ─── Feedback inline (banner ligero, sin dependencias) ────────────
type FeedbackState = { kind: 'ok' | 'err'; msg: string } | null

// ─── Formulario de edición inline ─────────────────────────────────
// Cada fila lleva su propia clase `group`, para que el lápiz aparezca
// consistentemente al hacer hover/focus en cualquier sección (personal
// o legal), sin depender del contenedor externo. En móvil el lápiz
// está siempre visible; en desktop aparece con hover o focus dentro.
function EditField({
  label, value, name, type = 'text', options, onSave, readOnly = false, onFeedback,
}: {
  label: string
  value: string
  name: string
  type?: string
  options?: { value: string; label: string }[]
  onSave: (name: string, value: string) => Promise<void>
  readOnly?: boolean
  onFeedback?: (f: FeedbackState) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState(value || '')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => { setVal(value || '') }, [value])

  async function handleSave() {
    // Validación cliente antes del round-trip.
    const check = validateEmployeeField(name, val)
    if (!check.ok) {
      setError(check.error)
      onFeedback?.({ kind: 'err', msg: `${label}: ${check.error}` })
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSave(name, val)
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

  const displayValue = value
    ? value
    : <span className="text-slate-400 dark:text-white/30">—</span>

  return (
    <div className="group flex items-center justify-between py-3 border-b border-slate-50 last:border-0 dark:border-white/[0.05]">
      <span className="text-sm text-slate-500 w-36 shrink-0 dark:text-white/40">{label}</span>
      {editing ? (
        <div className="flex flex-col items-stretch gap-1 flex-1">
          <div className="flex items-center gap-2 flex-1">
            {options ? (
              <select
                aria-label={label}
                value={val}
                onChange={e => setVal(e.target.value)}
                className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white"
              >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                aria-label={label}
                type={type}
                value={val}
                onChange={e => setVal(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleSave() }
                  if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setVal(value || ''); setError(null) }
                }}
                className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white"
                autoFocus
              />
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              aria-label={`Guardar ${label}`}
              className="text-green-600 hover:text-green-700 disabled:opacity-50"
            >
              <Save size={16} />
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setVal(value || ''); setError(null) }}
              aria-label={`Cancelar edición de ${label}`}
              className="text-slate-400 hover:text-slate-600 dark:text-white/30"
            >
              <X size={16} />
            </button>
          </div>
          {error && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-1 justify-between">
          <span className="text-sm font-medium text-slate-900 dark:text-white">
            {displayValue}
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Editar ${label}`}
              className={
                'text-slate-400 hover:text-blue-600 focus-visible:text-blue-600 ' +
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded ' +
                // Siempre visible en móvil; aparece con hover/focus en ≥sm.
                'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ' +
                'transition-opacity'
              }
            >
              <Edit2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────
export default function EmpleadoDetallePage() {
  const { id } = useParams<{ id: string }>()
  const router  = useRouter()
  const qc      = useQueryClient()

  const [histFrom, setHistFrom] = useState(() => {
    const d = new Date(); d.setDate(1); return format(d, 'yyyy-MM-dd')
  })
  const [histTo, setHistTo] = useState(format(new Date(), 'yyyy-MM-dd'))

  // Feedback inline (auto-clear a los 3.5s).
  const [feedback, setFeedback] = useState<FeedbackState>(null)
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 3500)
    return () => clearTimeout(t)
  }, [feedback])

  const { data: emp, isLoading, error } = useQuery({
    queryKey: ['employee', id],
    queryFn: () => employeesApi.get(+id),
    enabled: !!id,
  })

  const { data: schedules } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules').then(r => r.data),
    staleTime: 300_000,
  })

  const { data: history } = useQuery({
    queryKey: ['emp-history', id, histFrom, histTo],
    queryFn: () => employeesApi.history(+id, { from: histFrom, to: histTo }),
    enabled: !!id,
  })

  // Capacidades del rol actual sobre esta ficha. Vienen embebidas en getById
  // como `_caps`. Nunca son la única defensa: el backend siempre valida.
  const caps = (emp?._caps || {}) as Partial<Record<
    'personal_update' | 'legal_view' | 'legal_update' | 'biometrics_link' | 'status_change',
    boolean
  >>

  // Actualizar campo individual — usa /quick para permitir clear real y auditar.
  async function onSaveField(fieldName: string, value: string) {
    await employeesApi.quickUpdate(+id, fieldName, value)
    qc.invalidateQueries({ queryKey: ['employee', id] })
    qc.invalidateQueries({ queryKey: ['employees'] })
  }

  // Baja / reactivación robusta (con motivo y auditoría en el backend).
  const [bajaOpen, setBajaOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)

  async function doDeactivate() {
    setStatusBusy(true)
    try {
      await api.post(`/api/employees/${id}/deactivate`, { reason })
      setBajaOpen(false); setReason('')
      qc.invalidateQueries({ queryKey: ['employee', id] })
      qc.invalidateQueries({ queryKey: ['employees'] })
      setFeedback({ kind: 'ok', msg: 'Empleado dado de baja.' })
    } catch (e: any) {
      setFeedback({ kind: 'err', msg: 'Error: ' + (e.response?.data?.error || e.message) })
    } finally { setStatusBusy(false) }
  }
  async function doReactivate() {
    if (!confirm('¿Reactivar a este empleado? Volverá a las vistas operativas.')) return
    setStatusBusy(true)
    try {
      await api.post(`/api/employees/${id}/reactivate`, {})
      qc.invalidateQueries({ queryKey: ['employee', id] })
      qc.invalidateQueries({ queryKey: ['employees'] })
      setFeedback({ kind: 'ok', msg: 'Empleado reactivado.' })
    } catch (e: any) {
      setFeedback({ kind: 'err', msg: 'Error: ' + (e.response?.data?.error || e.message) })
    } finally { setStatusBusy(false) }
  }

  if (isLoading) return <div className="p-6 text-slate-400 dark:text-white/30">Cargando...</div>
  if (error || !emp) return <div className="p-6 text-red-500">Empleado no encontrado</div>

  const canEditPersonal = !!caps.personal_update
  const canViewLegal    = !!caps.legal_view
  const canEditLegal    = !!caps.legal_update
  const canChangeStatus = !!caps.status_change

  const schedOpts = [{ value: '', label: 'Sin horario' },
    ...(schedules || []).map((s: any) => ({ value: String(s.id), label: s.name }))]

  const histRows = history || []
  const workedDays  = histRows.filter((r: any) => r.status === 'present' || r.status === 'late').length
  const lateDays    = histRows.filter((r: any) => r.status === 'late').length
  const absentDays  = histRows.filter((r: any) => r.status === 'absent').length
  const totalWorked = histRows.reduce((acc: number, r: any) => acc + (r.worked_minutes || 0), 0)

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Back */}
      <Link href="/empleados" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 dark:text-white/40">
        <ArrowLeft size={16} /> Volver a empleados
      </Link>

      {/* Feedback flotante inline */}
      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={
            'sticky top-2 z-30 rounded-xl border px-4 py-2 text-sm shadow-sm flex items-center gap-2 ' +
            (feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-200'
              : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-200')
          }
        >
          {feedback.kind === 'ok' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span className="flex-1">{feedback.msg}</span>
          <button onClick={() => setFeedback(null)} aria-label="Cerrar aviso" className="opacity-70 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Header empleado */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 flex items-center gap-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-3xl font-bold shrink-0">
          {emp.first_name?.[0]}{emp.last_name?.[0]}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            {emp.first_name} {emp.last_name}
          </h1>
          <div className="flex flex-wrap gap-3 mt-2 text-sm text-slate-500 dark:text-white/40">
            <span className="font-mono bg-slate-100 px-2 py-0.5 rounded dark:bg-white/[0.06]">#{emp.code}</span>
            {emp.employee_number && (
              <span className="bg-slate-100 px-2 py-0.5 rounded dark:bg-white/[0.06]">{emp.employee_number}</span>
            )}
            {emp.position && (
              <span className="flex items-center gap-1"><Briefcase size={13} /> {emp.position}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <span className={`px-3 py-1.5 rounded-full text-sm font-semibold ${
            emp.status === 'active'
              ? 'bg-green-50 text-green-700'
              : emp.status === 'suspended'
                ? 'bg-amber-50 text-amber-700'
                : 'bg-slate-100 text-slate-600'
          }`}>
            {emp.status === 'active' ? 'Activo' : emp.status === 'suspended' ? 'Suspendido' : 'Inactivo'}
          </span>
          {canChangeStatus && (emp.status === 'active'
            ? <button onClick={() => setBajaOpen(true)} disabled={statusBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xl bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-60">
                <UserX size={14} /> Dar de baja
              </button>
            : <button onClick={doReactivate} disabled={statusBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60">
                <UserCheck size={14} /> Reactivar
              </button>)}
        </div>
      </div>

      {/* Banner de baja: motivo, fecha y estado de deshabilitación en reloj */}
      {emp.status !== 'active' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3 dark:border-amber-500/20 dark:bg-amber-500/[0.06]">
          <ShieldAlert size={20} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900 dark:text-amber-200/90 space-y-1">
            <p className="font-medium">
              Empleado {emp.status === 'suspended' ? 'suspendido' : 'dado de baja'}. El histórico se conserva y queda excluido de las vistas operativas.
            </p>
            {emp.deactivation_reason && <p><strong>Motivo:</strong> {emp.deactivation_reason}</p>}
            {emp.deactivated_at && <p><strong>Fecha de baja:</strong> {format(parseISO(emp.deactivated_at), "d 'de' MMMM yyyy, HH:mm", { locale: es })}</p>}
            {emp.device_disable_pending ? (
              <p className="text-amber-700 dark:text-amber-300/80">⏳ Deshabilitación en el reloj <strong>pendiente</strong> — se aplicará con la sincronización inversa empleados → reloj.</p>
            ) : null}
          </div>
        </div>
      )}

      {/* Modal: motivo de la baja */}
      {bajaOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="baja-title"
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onKeyDown={e => { if (e.key === 'Escape') setBajaOpen(false) }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
            <div className="flex items-center justify-between">
              <h3 id="baja-title" className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <UserX size={18} className="text-red-600" /> Dar de baja
              </h3>
              <button aria-label="Cerrar" onClick={() => setBajaOpen(false)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-500 dark:text-white/40">
              Se conserva todo el histórico. El empleado se excluye de las vistas operativas y la deshabilitación en el reloj queda pendiente hasta la sincronización inversa.
            </p>
            <div>
              <label htmlFor="baja-reason" className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Motivo (opcional)</label>
              <textarea id="baja-reason" value={reason} onChange={e => setReason(e.target.value)} rows={3} autoFocus
                placeholder="ej: renuncia, fin de contrato, traslado…"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setBajaOpen(false)} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
              <button onClick={doDeactivate} disabled={statusBusy}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60">
                <UserX size={14} /> {statusBusy ? 'Procesando…' : 'Confirmar baja'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Info personal */}
        <div className="lg:col-span-1 bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 dark:text-white/80">
            <User size={16} className="text-blue-500" /> Información
          </h2>
          <EditField label="Nombre"      value={emp.first_name}    name="first_name"    readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField label="Apellido"    value={emp.last_name}     name="last_name"     readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField label="Email"       value={emp.email || ''}   name="email"         type="email" readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField label="Teléfono"    value={emp.phone || ''}   name="phone"         type="tel"   readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField label="Cargo"       value={emp.position || ''} name="position"     readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField label="Ingreso"     value={emp.hire_date ? emp.hire_date.split('T')[0] : ''} name="hire_date" type="date" readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField label="Nacimiento"  value={emp.birth_date ? emp.birth_date.split('T')[0] : ''} name="birth_date" type="date" readOnly={!canEditPersonal} onSave={onSaveField} onFeedback={setFeedback} />
          <EditField
            label="Horario"
            value={emp.schedule_name || ''}
            name="schedule_id"
            options={schedOpts}
            readOnly={!canEditPersonal}
            onSave={async (name, val) => onSaveField(name, val)}
            onFeedback={setFeedback}
          />
          {/* El estado NO se cambia inline: para dar de baja se usa el botón
              del header (motivo + auditoría + deshabilitación pendiente en el
              reloj). Cambiarlo con un select saltearía ese flujo. */}

          {/* Datos legales MTESS / IPS */}
          {canViewLegal ? (
            <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/[0.06]">
              <h3 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 dark:text-white/80">
                <Briefcase size={15} className="text-cyan-500" /> Datos legales (MTESS / IPS)
              </h3>
              <EditField label="C.I."         value={emp.document_number || ''} name="document_number" readOnly={!canEditLegal} onSave={onSaveField} onFeedback={setFeedback} />
              <EditField label="N° IPS"       value={emp.ips_number || ''}      name="ips_number"      readOnly={!canEditLegal} onSave={onSaveField} onFeedback={setFeedback} />
              <EditField label="Salario base" value={emp.salary_base != null ? String(emp.salary_base) : ''} name="salary_base" type="number" readOnly={!canEditLegal} onSave={onSaveField} onFeedback={setFeedback} />
              <EditField
                label="Tipo de pago"
                value={emp.pay_type || 'mensualizado'}
                name="pay_type"
                readOnly={!canEditLegal}
                options={[
                  { value: 'mensualizado', label: 'Mensualizado' },
                  { value: 'jornalero',    label: 'Jornalero' },
                ]}
                onSave={onSaveField}
                onFeedback={setFeedback}
              />
              <EditField
                label="Género"
                value={emp.gender || ''}
                name="gender"
                readOnly={!canEditLegal}
                options={[
                  { value: '',  label: '—' },
                  { value: 'M', label: 'Masculino' },
                  { value: 'F', label: 'Femenino' },
                  { value: 'O', label: 'Otro' },
                ]}
                onSave={onSaveField}
                onFeedback={setFeedback}
              />
              <EditField label="N° de hijos" value={emp.children_count != null ? String(emp.children_count) : '0'} name="children_count" type="number" readOnly={!canEditLegal} onSave={onSaveField} onFeedback={setFeedback} />
              <EditField label="Antigüedad (%)" value={emp.antiguedad_rate != null ? String(emp.antiguedad_rate) : '0'} name="antiguedad_rate" type="number" readOnly={!canEditLegal} onSave={onSaveField} onFeedback={setFeedback} />
            </div>
          ) : null}
        </div>

        {/* Historial */}
        <div className="lg:col-span-2 space-y-5">
          {/* Stats del período */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Asistencias', value: workedDays,  cls: 'text-green-700 bg-green-50' },
              { label: 'Retardos',    value: lateDays,    cls: 'text-amber-700 bg-amber-50' },
              { label: 'Ausencias',   value: absentDays,  cls: 'text-red-700   bg-red-50'   },
              { label: 'Horas',       value: minsToHM(totalWorked), cls: 'text-blue-700 bg-blue-50' },
            ].map(s => (
              <div key={s.label} className={`rounded-2xl p-4 ${s.cls}`}>
                <p className="text-xs font-medium opacity-70 uppercase tracking-wide">{s.label}</p>
                <p className="text-2xl font-bold mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Filtro de período */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-700 flex items-center gap-2 dark:text-white/80">
                <Clock size={16} className="text-blue-500" /> Historial de asistencia
              </h2>
              <div className="flex gap-2 items-center text-sm">
                <input type="date" value={histFrom} onChange={e => setHistFrom(e.target.value)}
                  className="border border-slate-200 rounded-xl px-2 py-1 text-sm dark:border-white/[0.08]" />
                <span className="text-slate-400 dark:text-white/30">–</span>
                <input type="date" value={histTo} onChange={e => setHistTo(e.target.value)}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  className="border border-slate-200 rounded-xl px-2 py-1 text-sm dark:border-white/[0.08]" />
              </div>
            </div>

            <div className="overflow-y-auto max-h-80 space-y-0 divide-y divide-slate-50 dark:divide-white/[0.05]">
              {histRows.length === 0 && (
                <p className="text-center py-8 text-slate-400 text-sm dark:text-white/30">Sin registros en este período</p>
              )}
              {histRows.map((row: any, i: number) => {
                const cfg = STATUS_ROW[row.status] || STATUS_ROW.absent
                return (
                  <div key={i} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="text-slate-400 font-mono text-xs w-24 shrink-0 dark:text-white/30">
                      {row.date ? format(new Date(row.date + 'T12:00'), 'EEE dd/MM', { locale: es }) : ''}
                    </span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.cls}`}>
                      {cfg.icon} {cfg.label}
                    </span>
                    <span className="font-mono text-slate-600 text-xs dark:text-white/60">{fmtTime(row.first_in)}</span>
                    <span className="text-slate-300 text-xs">–</span>
                    <span className="font-mono text-slate-600 text-xs dark:text-white/60">{fmtTime(row.last_out)}</span>
                    <span className="ml-auto font-mono text-slate-500 text-xs dark:text-white/40">{minsToHM(row.worked_minutes)}</span>
                    {row.late_minutes > 0 && (
                      <span className="text-amber-500 text-xs">+{row.late_minutes}min</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Biometría / Relojes */}
          {emp?.id && <BiometriaRelojes employeeId={emp.id} />}

          {/* Reconocimiento facial */}
          {emp?.id && <FaceEnroll employeeId={emp.id} />}

          {/* Documentos publicados por RR.HH. */}
          {emp?.id && <EmployeeDocuments employeeId={emp.id} />}

          {/* Notas / observaciones */}
          {emp?.id && <EmployeeNotes employeeId={emp.id} />}
        </div>
      </div>
    </div>
  )
}
