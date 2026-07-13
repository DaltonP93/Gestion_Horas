'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  ArrowLeft, User, Mail, Phone, Building2, Clock,
  Calendar, Edit2, Save, X, CheckCircle, XCircle,
  AlertCircle, Briefcase
} from 'lucide-react'
import Link from 'next/link'
import { employeesApi, api } from '@/lib/api'
import { fmtTimePy } from '@/lib/datetime'
import EmployeeNotes from '@/components/EmployeeNotes'
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

// ─── Formulario de edición inline ─────────────────────────────────
function EditField({
  label, value, name, type = 'text', options, onSave,
}: {
  label: string
  value: string
  name: string
  type?: string
  options?: { value: string; label: string }[]
  onSave: (name: string, value: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState(value || '')
  const [saving, setSaving]   = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave(name, val)
    setSaving(false)
    setEditing(false)
  }

  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-50 last:border-0">
      <span className="text-sm text-slate-500 w-36 shrink-0 dark:text-white/40">{label}</span>
      {editing ? (
        <div className="flex items-center gap-2 flex-1">
          {options ? (
            <select
              value={val}
              onChange={e => setVal(e.target.value)}
              className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
            >
              {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              type={type}
              value={val}
              onChange={e => setVal(e.target.value)}
              className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              autoFocus
            />
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-green-600 hover:text-green-700 disabled:opacity-50"
          >
            <Save size={16} />
          </button>
          <button onClick={() => { setEditing(false); setVal(value || '') }} className="text-slate-400 hover:text-slate-600 dark:text-white/30">
            <X size={16} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-1 justify-between">
          <span className="text-sm font-medium text-slate-900 dark:text-white">{value || <span className="text-slate-400 dark:text-white/30">—</span>}</span>
          <button onClick={() => setEditing(true)} className="text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity">
            <Edit2 size={14} />
          </button>
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

  // Actualizar campo individual
  async function onSaveField(fieldName: string, value: string) {
    await employeesApi.update(+id, { [fieldName]: value })
    qc.invalidateQueries({ queryKey: ['employee', id] })
    qc.invalidateQueries({ queryKey: ['employees'] })
  }

  if (isLoading) return <div className="p-6 text-slate-400 dark:text-white/30">Cargando...</div>
  if (error || !emp) return <div className="p-6 text-red-500">Empleado no encontrado</div>

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
        <span className={`px-3 py-1.5 rounded-full text-sm font-semibold ${
          emp.status === 'active'
            ? 'bg-green-50 text-green-700'
            : 'bg-slate-100 text-slate-600'
        }`}>
          {emp.status === 'active' ? 'Activo' : 'Inactivo'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Info personal */}
        <div className="lg:col-span-1 bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 dark:text-white/80">
            <User size={16} className="text-blue-500" /> Información
          </h2>
          <div className="group">
            <EditField label="Nombre"      value={emp.first_name}    name="first_name"    onSave={onSaveField} />
            <EditField label="Apellido"    value={emp.last_name}     name="last_name"     onSave={onSaveField} />
            <EditField label="Email"       value={emp.email || ''}   name="email"         type="email" onSave={onSaveField} />
            <EditField label="Teléfono"    value={emp.phone || ''}   name="phone"         type="tel" onSave={onSaveField} />
            <EditField label="Cargo"       value={emp.position || ''} name="position"      onSave={onSaveField} />
            <EditField label="Ingreso"     value={emp.hire_date ? emp.hire_date.split('T')[0] : ''} name="hire_date" type="date" onSave={onSaveField} />
            <EditField label="Nacimiento"  value={emp.birth_date ? emp.birth_date.split('T')[0] : ''} name="birth_date" type="date" onSave={onSaveField} />
            <EditField
              label="Horario"
              value={emp.schedule_name || ''}
              name="schedule_id"
              options={schedOpts}
              onSave={async (name, val) => onSaveField(name, val)}
            />
            <EditField
              label="Estado"
              value={emp.status}
              name="status"
              options={[
                { value: 'active',    label: 'Activo' },
                { value: 'inactive',  label: 'Inactivo' },
                { value: 'suspended', label: 'Suspendido' },
              ]}
              onSave={onSaveField}
            />
          </div>

          {/* Datos legales MTESS / IPS */}
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/[0.06]">
            <h3 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 dark:text-white/80">
              <Briefcase size={15} className="text-cyan-500" /> Datos legales (MTESS / IPS)
            </h3>
            <EditField label="C.I."         value={emp.document_number || ''} name="document_number" onSave={onSaveField} />
            <EditField label="N° IPS"       value={emp.ips_number || ''}      name="ips_number"      onSave={onSaveField} />
            <EditField label="Salario base" value={emp.salary_base != null ? String(emp.salary_base) : ''} name="salary_base" type="number" onSave={onSaveField} />
            <EditField
              label="Tipo de pago"
              value={emp.pay_type || 'mensualizado'}
              name="pay_type"
              options={[
                { value: 'mensualizado', label: 'Mensualizado' },
                { value: 'jornalero',    label: 'Jornalero' },
              ]}
              onSave={onSaveField}
            />
            <EditField
              label="Género"
              value={emp.gender || ''}
              name="gender"
              options={[
                { value: '',  label: '—' },
                { value: 'M', label: 'Masculino' },
                { value: 'F', label: 'Femenino' },
                { value: 'O', label: 'Otro' },
              ]}
              onSave={onSaveField}
            />
            <EditField label="N° de hijos" value={emp.children_count != null ? String(emp.children_count) : '0'} name="children_count" type="number" onSave={onSaveField} />
            <EditField label="Antigüedad (%)" value={emp.antiguedad_rate != null ? String(emp.antiguedad_rate) : '0'} name="antiguedad_rate" type="number" onSave={onSaveField} />
          </div>
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

          {/* Reconocimiento facial */}
          {emp?.id && <FaceEnroll employeeId={emp.id} />}

          {/* Notas / observaciones */}
          {emp?.id && <EmployeeNotes employeeId={emp.id} />}
        </div>
      </div>
    </div>
  )
}
