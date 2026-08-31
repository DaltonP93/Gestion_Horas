'use client'
/**
 * /empleados/[id] — ficha del empleado (PR 1: readonly + modal).
 *
 * Superficie visible:
 *   - Header rico con toda la info clave del empleado (avatar, nombre,
 *     código, C.I., cargo, departamento, sede, turno, estado, ingreso,
 *     antigüedad, tipo de pago).
 *   - Un solo botón "Editar empleado" que abre el modal completo.
 *   - Baja / reactivación permanecen como acción separada del header
 *     porque exigen motivo + confirmación + auditoría (nunca se editan
 *     como si fueran un campo más).
 *   - Historial de asistencia, biometría, documentos y notas se
 *     mantienen como paneles independientes.
 *
 * Cambios respecto de PR previos: se eliminó toda la edición inline
 * (EditField) porque generaba fricción y un flujo poco claro. Ahora hay
 * un único guardado atómico contra `PUT /api/employees/:id`.
 */

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  ArrowLeft, User, Clock, Calendar, CheckCircle, XCircle, X,
  AlertCircle, Briefcase, UserX, UserCheck, ShieldAlert, Building2,
  MapPin, Coins, Fingerprint, Pencil, SlidersHorizontal,
} from 'lucide-react'
import Link from 'next/link'
import { employeesApi, api } from '@/lib/api'
import { fmtTimePy } from '@/lib/datetime'
import { formatPYG } from '@/lib/currency'
import EmployeeNotes from '@/components/EmployeeNotes'
import EmployeeDocuments from '@/components/EmployeeDocuments'
import BiometriaRelojes from '@/components/BiometriaRelojes'
import EmployeeEditModal from '@/components/EmployeeEditModal'
import { useCurrentUser } from '@/lib/useCurrentUser'
import dynamic from 'next/dynamic'
const FaceEnroll = dynamic(() => import('@/components/FaceEnroll'), { ssr: false })

type Feedback = { kind: 'ok' | 'err'; msg: string } | null

// ─── Helpers ──────────────────────────────────────────────────────
function minsToHM(mins: number | null) {
  if (!mins || mins <= 0) return '0:00'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

function fmtTime(dt: string | null) {
  return fmtTimePy(dt)
}

function fmtCivilDate(v: string | null | undefined): string {
  if (!v) return '—'
  const s = String(v).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return '—'
  return `${d}/${m}/${y}`
}

const STATUS_ROW: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  present:    { label: 'Presente',  cls: 'bg-green-50  text-green-700',  icon: <CheckCircle size={14} /> },
  late:       { label: 'Retardo',   cls: 'bg-amber-50  text-amber-700',  icon: <AlertCircle size={14} /> },
  absent:     { label: 'Ausente',   cls: 'bg-red-50    text-red-700',    icon: <XCircle size={14} />     },
  permission: { label: 'Permiso',   cls: 'bg-purple-50 text-purple-700', icon: <Calendar size={14} />    },
  holiday:    { label: 'Festivo',   cls: 'bg-blue-50   text-blue-700',   icon: <Calendar size={14} />    },
  weekend:    { label: 'Fin semana', cls: 'bg-slate-50 text-slate-500',  icon: <Calendar size={14} />    },
  // Estados de la migración 074: NO son ausencias y no deben pintarse de rojo.
  non_working:  { label: 'No laborable',   cls: 'bg-slate-50 text-slate-500', icon: <Calendar size={14} /> },
  unconfigured: { label: 'Sin configurar', cls: 'bg-slate-50 text-slate-400', icon: <Calendar size={14} /> },
}

// Fallback NEUTRO para un estado no reconocido: nunca 'Ausente'.
const STATUS_ROW_FALLBACK = { label: '—', cls: 'bg-slate-50 text-slate-400', icon: <Calendar size={14} /> }

// Bloque de datos del header. Reutilizable: label + value + icon opcional.
function InfoTile({
  label, value, icon,
}: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-400 dark:text-white/40">
        {icon} <span>{label}</span>
      </div>
      <div className="mt-0.5 truncate text-sm font-medium text-slate-800 dark:text-white/90">
        {value ?? '—'}
      </div>
    </div>
  )
}

export default function EmpleadoDetallePage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const currentUser = useCurrentUser()

  const [feedback, setFeedback] = useState<Feedback>(null)
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 3500)
    return () => clearTimeout(t)
  }, [feedback])

  const [editOpen, setEditOpen] = useState(false)
  const [bajaOpen, setBajaOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)

  const [histFrom, setHistFrom] = useState(() => {
    const d = new Date(); d.setDate(1); return format(d, 'yyyy-MM-dd')
  })
  const [histTo, setHistTo] = useState(format(new Date(), 'yyyy-MM-dd'))

  const { data: emp, isLoading, error } = useQuery({
    queryKey: ['employee', id],
    queryFn: () => employeesApi.get(+id),
    enabled: !!id,
  })

  const { data: history } = useQuery({
    queryKey: ['emp-history', id, histFrom, histTo],
    queryFn: () => employeesApi.history(+id, { from: histFrom, to: histTo }),
    enabled: !!id,
  })

  // Catálogo de pay-types sólo para renderizar el label legible en el header.
  const { data: payTypesData } = useQuery({
    queryKey: ['catalog', 'pay-types'],
    queryFn: () => api.get('/api/catalogs/pay-types').then(r => r.data),
    staleTime: 60_000,
    enabled: !!id,
  })
  const payTypeLabel = (code: string | null | undefined): string => {
    if (!code) return '—'
    const list = (payTypesData?.data as { value: string; label: string }[] | undefined) || []
    return list.find(p => p.value === code)?.label || code
  }

  const caps = (emp?._caps || {}) as Partial<Record<
    'personal_update' | 'legal_view' | 'legal_update' | 'biometrics_link' | 'status_change',
    boolean
  >>

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

  const canViewLegal       = !!caps.legal_view
  const canEditAny         = !!caps.personal_update || !!caps.legal_update
  const canChangeStatus    = !!caps.status_change
  const canConfigureWorkday = ['super_admin', 'admin', 'gth', 'hr'].includes(String(currentUser?.role || ''))

  const histRows = history || []
  const workedDays  = histRows.filter((r: any) => r.status === 'present' || r.status === 'late').length
  const lateDays    = histRows.filter((r: any) => r.status === 'late').length
  const absentDays  = histRows.filter((r: any) => r.status === 'absent').length
  const totalWorked = histRows.reduce((acc: number, r: any) => acc + (r.worked_minutes || 0), 0)

  const statusBadge = (() => {
    switch (emp.status) {
      case 'active':    return { label: 'Activo',     cls: 'bg-green-50 text-green-700' }
      case 'suspended': return { label: 'Suspendido', cls: 'bg-amber-50 text-amber-700' }
      default:          return { label: 'Inactivo',   cls: 'bg-slate-100 text-slate-600' }
    }
  })()

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Back */}
      <Link href="/empleados" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 dark:text-white/40">
        <ArrowLeft size={16} /> Volver a empleados
      </Link>

      {/* Feedback */}
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

      {/* Header enriquecido — todo el resumen del empleado en un solo bloque */}
      <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-6 space-y-5 dark:border-white/[0.06] dark:bg-white/[0.04]">
        <div className="flex flex-wrap items-start gap-5">
          {emp.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={emp.photo_url} alt="" className="h-20 w-20 shrink-0 rounded-2xl object-cover" />
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 text-3xl font-bold text-white">
              {emp.first_name?.[0]}{emp.last_name?.[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              {emp.first_name} {emp.last_name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-500 dark:text-white/50">
              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono dark:bg-white/[0.06]">#{emp.code}</span>
              {emp.employee_number && (
                <span className="rounded bg-slate-100 px-2 py-0.5 dark:bg-white/[0.06]">{emp.employee_number}</span>
              )}
              <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${statusBadge.cls}`}>{statusBadge.label}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canConfigureWorkday && (
              <Link
                href={`/empleados/${id}/configuracion-laboral`}
                className="inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300"
              >
                <SlidersHorizontal size={14} /> Configuración laboral
              </Link>
            )}
            {canEditAny && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              >
                <Pencil size={14} /> Editar empleado
              </button>
            )}
            {canChangeStatus && (emp.status === 'active'
              ? <button onClick={() => setBajaOpen(true)} disabled={statusBusy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 hover:bg-red-100 disabled:opacity-60">
                  <UserX size={14} /> Dar de baja
                </button>
              : <button onClick={doReactivate} disabled={statusBusy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-60">
                  <UserCheck size={14} /> Reactivar
                </button>)}
          </div>
        </div>

        {/* Grilla de resumen — sustituye al recuadro vacío que quedaba antes */}
        <div className="grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3 lg:grid-cols-4 dark:border-white/[0.06]">
          <InfoTile label="Cargo" value={emp.position || '—'} icon={<Briefcase size={11} />} />
          <InfoTile label="Departamento" value={emp.department_name || '—'} icon={<Building2 size={11} />} />
          <InfoTile label="Sede" value={emp.branch_name || '—'} icon={<MapPin size={11} />} />
          <InfoTile
            label="Turno"
            value={
              emp.schedule_name
                ? (
                  <span>
                    {emp.schedule_name}
                    {emp.check_in && (
                      <span className="ml-1 text-xs text-slate-400 dark:text-white/40">
                        {String(emp.check_in).slice(0, 5)}–{String(emp.check_out).slice(0, 5)}
                      </span>
                    )}
                  </span>
                )
                : 'Sin turno asignado'
            }
            icon={<Clock size={11} />}
          />
          <InfoTile label="Fecha de ingreso" value={fmtCivilDate(emp.hire_date)} icon={<Calendar size={11} />} />
          <InfoTile label="Antigüedad" value={emp.antiguedad_label || 'Sin fecha de ingreso'} icon={<Clock size={11} />} />
          {canViewLegal && (
            <>
              <InfoTile label="C.I." value={emp.document_number || '—'} icon={<Fingerprint size={11} />} />
              <InfoTile
                label="Tipo de pago"
                value={payTypeLabel(emp.pay_type)}
                icon={<Coins size={11} />}
              />
            </>
          )}
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

      {/* Modal de edición completa */}
      {editOpen && (
        <EmployeeEditModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          employee={emp}
          caps={caps}
          currentUserRole={currentUser?.role}
          onSaved={() => setFeedback({ kind: 'ok', msg: 'Cambios guardados.' })}
        />
      )}

      {/* KPIs del período — ancho completo, 2 columnas en móvil */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Asistencias', value: workedDays,  cls: 'text-green-700 bg-green-50' },
          { label: 'Retardos',    value: lateDays,    cls: 'text-amber-700 bg-amber-50' },
          { label: 'Ausencias',   value: absentDays,  cls: 'text-red-700   bg-red-50'   },
          { label: 'Horas',       value: minsToHM(totalWorked), cls: 'text-blue-700 bg-blue-50' },
        ].map(s => (
          <div key={s.label} className={`min-w-0 rounded-2xl p-4 ${s.cls}`}>
            <p className="text-xs font-medium opacity-70 uppercase tracking-wide">{s.label}</p>
            <p className="text-2xl font-bold mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Una sola grilla con dos áreas explícitas.
          Antes eran dos grillas hermanas: la primera emparejaba Historial
          con la columna de biometría, y como esa columna es bastante más
          alta que el historial (limitado a max-h-80), la fila dejaba un
          hueco grande debajo del historial; Contacto y Datos salariales
          vivían en la grilla siguiente, o sea debajo de todo ese hueco.
          Ahora la columna principal concentra el contenido —historial,
          tarjetas informativas, documentos y notas— y ocupa ella misma
          ese espacio. Sin grid-auto-flow:dense: el orden del DOM es el
          orden de lectura. */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div data-testid="ficha-principal" className="min-w-0 space-y-6 xl:col-span-2">
          <div className="min-w-0 bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="font-semibold text-slate-700 flex items-center gap-2 dark:text-white/80">
                <Clock size={16} className="text-blue-500" /> Historial de asistencia
              </h2>
              <div className="flex flex-wrap gap-2 items-center text-sm">
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
                const cfg = STATUS_ROW[row.status] || STATUS_ROW_FALLBACK
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

          {/* Tarjetas informativas: comparten fila desde 768px. Si el rol no
              puede ver datos salariales, Contacto toma el ancho completo en
              lugar de dejar media fila vacía. */}
          <div
            data-testid="ficha-tarjetas-info"
            className={canViewLegal ? 'grid grid-cols-1 gap-6 md:grid-cols-2' : 'grid grid-cols-1 gap-6'}
          >
            <div className="min-w-0 bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
              <h2 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 dark:text-white/80">
                <User size={16} className="text-blue-500" /> Contacto
              </h2>
              <dl className="space-y-2 text-sm">
                <div className="grid grid-cols-3 gap-2">
                  <dt className="text-slate-400 dark:text-white/40">Email</dt>
                  <dd className="col-span-2 min-w-0 break-all text-slate-800 dark:text-white/90">{emp.email || '—'}</dd>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <dt className="text-slate-400 dark:text-white/40">Teléfono</dt>
                  <dd className="col-span-2 min-w-0 text-slate-800 dark:text-white/90">{emp.phone || '—'}</dd>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <dt className="text-slate-400 dark:text-white/40">Nacimiento</dt>
                  <dd className="col-span-2 min-w-0 text-slate-800 dark:text-white/90">{fmtCivilDate(emp.birth_date)}</dd>
                </div>
              </dl>
            </div>

            {canViewLegal && (
              <div className="min-w-0 bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
                <h2 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 dark:text-white/80">
                  <Coins size={16} className="text-amber-500" /> Datos salariales
                </h2>
                <dl className="space-y-2 text-sm">
                  <div className="grid grid-cols-3 gap-2">
                    <dt className="text-slate-400 dark:text-white/40">Salario base</dt>
                    <dd className="col-span-2 min-w-0 font-mono text-slate-800 dark:text-white/90">
                      {emp.salary_base != null ? formatPYG(emp.salary_base) : '—'}
                    </dd>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <dt className="text-slate-400 dark:text-white/40">Tipo de pago</dt>
                    <dd className="col-span-2 min-w-0 text-slate-800 dark:text-white/90">{payTypeLabel(emp.pay_type)}</dd>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <dt className="text-slate-400 dark:text-white/40">N° IPS</dt>
                    <dd className="col-span-2 min-w-0 text-slate-800 dark:text-white/90">{emp.ips_number || '—'}</dd>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <dt className="text-slate-400 dark:text-white/40">Género</dt>
                    <dd className="col-span-2 min-w-0 text-slate-800 dark:text-white/90">
                      {emp.gender === 'M' ? 'Masculino' : emp.gender === 'F' ? 'Femenino' : emp.gender === 'O' ? 'Otro' : '—'}
                    </dd>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <dt className="text-slate-400 dark:text-white/40">N° de hijos</dt>
                    <dd className="col-span-2 min-w-0 text-slate-800 dark:text-white/90">{emp.children_count ?? 0}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>

          {/* Documentos y notas: ancho completo de la columna principal,
              son los paneles más densos y no se parten en dos. */}
          {emp?.id && <div className="min-w-0"><EmployeeDocuments employeeId={emp.id} /></div>}
          {emp?.id && <div className="min-w-0"><EmployeeNotes employeeId={emp.id} /></div>}
        </div>

        {/* Columna lateral: identificación biométrica (huella/tarjeta en los
            relojes + rostro). Agrupadas porque resuelven lo mismo desde el
            punto de vista del operador. Por debajo de xl la columna deja de
            existir y estas tarjetas quedan al final, después de notas. */}
        <aside data-testid="ficha-lateral" className="min-w-0 space-y-5 xl:col-span-1">
          <section aria-labelledby="bio-group-title" className="min-w-0 space-y-3">
            <h2 id="bio-group-title" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-white/40">
              <Fingerprint size={14} /> Identificación biométrica
            </h2>
            {emp?.id && <BiometriaRelojes employeeId={emp.id} />}
            {emp?.id && <FaceEnroll employeeId={emp.id} />}
          </section>
        </aside>
      </div>
    </div>
  )
}
