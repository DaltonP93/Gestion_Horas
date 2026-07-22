'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, UserPlus, Save } from 'lucide-react'
import Link from 'next/link'
import { employeesApi, api } from '@/lib/api'

interface FormData {
  code: string
  employee_number: string
  document_number: string
  first_name: string
  last_name: string
  email: string
  phone: string
  position: string
  hire_date: string
  department_id: string
  schedule_id: string
}

const EMPTY: FormData = {
  code: '', employee_number: '', document_number: '', first_name: '', last_name: '',
  email: '', phone: '', position: '', hire_date: '',
  department_id: '', schedule_id: '',
}

function Field({
  label, name, value, onChange, type = 'text', required = false,
}: {
  label: string
  name: keyof FormData
  value: string
  onChange: (name: keyof FormData, val: string) => void
  type?: string
  required?: boolean
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={e => onChange(name, e.target.value)}
        required={required}
        className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-300 dark:border-white/[0.08]"
      />
    </div>
  )
}

export default function NuevoEmpleadoPage() {
  const router  = useRouter()
  const [form, setForm] = useState<FormData>(EMPTY)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  // Flujo "Crear empleado y vincular" desde Marcaciones sin empleado: conserva
  // device_id/device_user_id y, tras crear, vincula y vuelve automáticamente.
  const [linkCtx, setLinkCtx] = useState<{ deviceId: string | null; deviceUserId: string } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const p = new URLSearchParams(window.location.search)
    const uid = (p.get('device_user_id') || '').trim()
    if (p.get('return_to') === 'vinculacion' && uid) {
      setLinkCtx({ deviceId: p.get('device_id'), deviceUserId: uid })
      // Prefill del código con el usuario del reloj (editable): si coincide,
      // las próximas marcas mapean solas incluso sin employee_device_map.
      setForm(prev => prev.code ? prev : { ...prev, code: uid })
    }
  }, [])

  const { data: schedules } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules').then(r => r.data),
    staleTime: 300_000,
  })

  const { data: deptsData } = useQuery({
    queryKey: ['departments-list'],
    queryFn: () => api.get('/api/employees/departments').then(r => ({ data: r.data })),
    staleTime: 300_000,
  })

  function set(name: keyof FormData, val: string) {
    setForm(prev => ({ ...prev, [name]: val }))
    setError('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const payload = {
        ...form,
        department_id: form.department_id ? +form.department_id : undefined,
        schedule_id:   form.schedule_id   ? +form.schedule_id   : undefined,
        hire_date:     form.hire_date || undefined,
        email:         form.email || undefined,
        phone:         form.phone || undefined,
      }
      const result = await employeesApi.create(payload)
      if (linkCtx) {
        // Vincular automáticamente y volver a Marcaciones sin empleado.
        try {
          await api.post('/api/devices/map', {
            employee_id: result.id,
            device_user_id: linkCtx.deviceUserId,
            device_id: linkCtx.deviceId ? +linkCtx.deviceId : null,
          })
        } catch { /* si el vínculo falla, la pantalla de pendientes lo muestra */ }
        router.push('/configuracion/sincronizacion?unmapped=1')
        return
      }
      router.push(`/empleados/${result.id}`)
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Error al crear empleado')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <Link href="/empleados" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 dark:text-white/40">
        <ArrowLeft size={16} /> Volver a empleados
      </Link>

      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
          <UserPlus size={20} className="text-blue-600" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Nuevo empleado</h1>
      </div>

      {linkCtx && (
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800 dark:bg-indigo-400/[0.06] dark:border-indigo-400/30 dark:text-indigo-300">
          🔗 Al guardar, este empleado se <b>vinculará automáticamente</b> al usuario del reloj <span className="font-mono font-semibold">{linkCtx.deviceUserId}</span>, se importarán sus marcas pendientes y volverás a “Marcaciones sin empleado”.
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {/* Identificación */}
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3 dark:text-white/30">Identificación</p>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Código ZKTeco (USERID)"
              name="code"
              value={form.code}
              onChange={set}
              required
            />
            <Field
              label="Número de empleado"
              name="employee_number"
              value={form.employee_number}
              onChange={set}
            />
            <Field
              label="Cédula de identidad"
              name="document_number"
              value={form.document_number}
              onChange={set}
            />
          </div>
          <p className="text-xs text-slate-400 mt-1.5 dark:text-white/30">
            El código debe coincidir con el USERID del reloj biométrico. La cédula se usa en exportación de nómina SAA.
          </p>
        </div>

        {/* Datos personales */}
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3 dark:text-white/30">Datos personales</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Nombre"   name="first_name" value={form.first_name} onChange={set} required />
            <Field label="Apellido" name="last_name"  value={form.last_name}  onChange={set} required />
            <Field label="Email"    name="email"      value={form.email}      onChange={set} type="email" />
            <Field label="Teléfono" name="phone"      value={form.phone}      onChange={set} type="tel" />
          </div>
        </div>

        {/* Datos laborales */}
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3 dark:text-white/30">Datos laborales</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Cargo / Puesto" name="position"  value={form.position}  onChange={set} />
            <Field label="Fecha de ingreso" name="hire_date" value={form.hire_date} onChange={set} type="date" />

            {/* Departamento */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Departamento</label>
              <select
                value={form.department_id}
                onChange={e => set('department_id', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              >
                <option value="">Sin asignar</option>
                {(deptsData?.data || []).map((d: any) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>

            {/* Horario */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Horario / Turno</label>
              <select
                value={form.schedule_id}
                onChange={e => set('schedule_id', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
              >
                <option value="">Sin asignar</option>
                {(schedules || []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.check_in?.slice(0,5)} – {s.check_out?.slice(0,5)})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        {/* Acciones */}
        <div className="flex gap-3 pt-2">
          <Link
            href="/empleados"
            className="flex-1 text-center border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]"
          >
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
          >
            <Save size={16} />
            {saving ? 'Guardando...' : 'Crear empleado'}
          </button>
        </div>
      </form>
    </div>
  )
}
