'use client'
import { useEffect, useRef, useState } from 'react'
import {
  UserCircle2, Mail, Phone, Briefcase, Building2, Calendar, Hash,
  AlertCircle, Pencil, Save, X, Camera, MapPin, CheckCircle2, Loader2,
} from 'lucide-react'
import { api } from '@/lib/api'

interface Me {
  user: {
    id: number; username: string; email: string | null
    full_name: string; role: string; last_login: string | null
    employee_id: number | null; photo_url?: string | null
  }
  employee: {
    id: number; code: string; first_name: string; last_name: string
    email: string | null; phone: string | null; address: string | null
    position: string | null; hire_date: string | null
    status: string; department: string | null; photo_url?: string | null
  } | null
}

interface EditState {
  email:   string
  phone:   string
  address: string
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin:       'Administrador',
  hr:          'RRHH',
  gth:         'Gestión de Talento',
  gestor:      'Gestor',
  supervisor:  'Supervisor',
  employee:    'Empleado',
}

export default function MiPerfilPage() {
  const [data,    setData]    = useState<Me | null>(null)
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [form,    setForm]    = useState<EditState>({ email: '', phone: '', address: '' })
  const [photoLoading, setPhotoLoading] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await api.get('/api/me')
      setData(r.data)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function startEdit() {
    if (!data) return
    setForm({
      email:   data.user.email   || '',
      phone:   data.employee?.phone   || '',
      address: data.employee?.address || '',
    })
    setMsg(null)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setMsg(null)
  }

  async function save() {
    setSaving(true); setMsg(null)
    try {
      await api.patch('/api/me/profile', {
        email:   form.email   || null,
        phone:   form.phone   || null,
        address: form.address || null,
      })
      setMsg({ type: 'ok', text: 'Cambios guardados correctamente.' })
      setEditing(false)
      await load()
    } catch (e: any) {
      setMsg({ type: 'err', text: e.response?.data?.error || 'Error al guardar' })
    } finally { setSaving(false) }
  }

  async function uploadPhoto(file: File | null) {
    if (!file) return
    setPhotoLoading(true); setMsg(null)
    try {
      const fd = new FormData(); fd.append('photo', file)
      await api.post('/api/me/photo', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setMsg({ type: 'ok', text: 'Foto actualizada.' })
      // Refrescar datos para mostrar nueva foto
      await load()
    } catch (e: any) {
      setMsg({ type: 'err', text: e.response?.data?.error || 'Error al subir foto' })
    } finally { setPhotoLoading(false) }
  }

  if (loading) return (
    <div className="p-10 flex items-center justify-center gap-2 text-slate-400 dark:text-white/30">
      <Loader2 size={18} className="animate-spin" /> Cargando...
    </div>
  )
  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 max-w-xl">
        <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
        <div className="text-sm text-red-900">{error}</div>
      </div>
    </div>
  )

  const { user, employee } = data!
  const photoUrl = employee?.photo_url || user?.photo_url || null
  const displayName = employee
    ? `${employee.first_name} ${employee.last_name}`
    : user.full_name

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          {/* Avatar con botón de subir foto */}
          <div className="relative group">
            <div className="w-20 h-20 rounded-2xl bg-blue-100 flex items-center justify-center overflow-hidden border-2 border-blue-200">
              {photoUrl ? (
                <img src={photoUrl} alt="Foto de perfil"
                  className="w-full h-full object-cover" />
              ) : (
                <UserCircle2 className="text-blue-400" size={44} />
              )}
            </div>
            <button
              onClick={() => photoRef.current?.click()}
              disabled={photoLoading}
              title="Cambiar foto"
              className="absolute -bottom-1.5 -right-1.5 w-8 h-8 rounded-full bg-white border border-slate-200 shadow flex items-center justify-center hover:bg-slate-50 transition-colors disabled:opacity-50 dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              {photoLoading
                ? <Loader2 size={14} className="animate-spin text-slate-500 dark:text-white/40" />
                : <Camera size={14} className="text-slate-600 dark:text-white/60" />}
            </button>
            <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={e => uploadPhoto(e.target.files?.[0] || null)} />
          </div>

          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{displayName}</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">
              {ROLE_LABEL[user.role] || user.role}
              {employee?.department ? ` · ${employee.department}` : ''}
            </p>
          </div>
        </div>

        {/* Botón Editar / Cancelar */}
        <div className="flex gap-2">
          {editing ? (
            <>
              <button onClick={cancelEdit}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 text-sm hover:bg-slate-50 transition-colors dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                <X size={15} /> Cancelar
              </button>
              <button onClick={save} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-50 transition-colors">
                {saving
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Save size={15} />}
                {saving ? 'Guardando…' : 'Guardar cambios'}
              </button>
            </>
          ) : (
            <button onClick={startEdit}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 text-sm hover:bg-slate-50 transition-colors dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <Pencil size={15} /> Editar perfil
            </button>
          )}
        </div>
      </div>

      {/* ── Mensajes de estado ───────────────────────────────────── */}
      {msg && (
        <div role={msg.type === 'err' ? 'alert' : 'status'}
          className={`rounded-xl px-4 py-3 text-sm flex items-center gap-2
            ${msg.type === 'ok'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-red-50 border border-red-200 text-red-800'}`}>
          {msg.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ── Datos de cuenta ────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-900 border-b border-slate-100 pb-2 dark:text-white dark:border-white/[0.06]">Cuenta</h2>

          <Field icon={UserCircle2} label="Nombre completo"
            value={user.full_name} readonly />
          <Field icon={Hash} label="Usuario"
            value={user.username} readonly />

          {editing ? (
            <div>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-500 mb-1 dark:text-white/40">
                <Mail size={13} /> Email
              </label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
                placeholder="tu@email.com"
              />
            </div>
          ) : (
            <Field icon={Mail} label="Email" value={user.email || '—'} />
          )}

          <Field icon={Briefcase} label="Rol"
            value={ROLE_LABEL[user.role] || user.role} readonly />
          <Field icon={Calendar} label="Último acceso"
            value={user.last_login ? new Date(user.last_login).toLocaleString('es-PY') : '—'} readonly />
        </div>

        {/* ── Datos de empleado ──────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-900 border-b border-slate-100 pb-2 dark:text-white dark:border-white/[0.06]">Empleado</h2>

          {!employee ? (
            <p className="text-slate-400 text-sm italic dark:text-white/30">
              Tu usuario no está vinculado a un empleado. Pedile a RRHH que te vincule para ver tu asistencia y pedir permisos.
            </p>
          ) : (
            <>
              <Field icon={UserCircle2} label="Nombre"
                value={`${employee.first_name} ${employee.last_name}`} readonly />
              <Field icon={Hash}       label="Código"
                value={employee.code} readonly />
              <Field icon={Briefcase} label="Puesto"
                value={employee.position || '—'} readonly />
              <Field icon={Building2} label="Departamento"
                value={employee.department || '—'} readonly />

              {editing ? (
                <>
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-500 mb-1 dark:text-white/40">
                      <Phone size={13} /> Teléfono
                    </label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
                      placeholder="+595 9xx xxx xxx"
                    />
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-500 mb-1 dark:text-white/40">
                      <MapPin size={13} /> Dirección
                    </label>
                    <input
                      type="text"
                      value={form.address}
                      onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]"
                      placeholder="Calle, ciudad"
                    />
                  </div>
                </>
              ) : (
                <>
                  <Field icon={Phone}  label="Teléfono"  value={employee.phone   || '—'} />
                  <Field icon={MapPin} label="Dirección" value={employee.address || '—'} />
                </>
              )}

              <Field icon={Calendar}  label="Ingreso"
                value={employee.hire_date
                  ? new Date(employee.hire_date).toLocaleDateString('es-PY')
                  : '—'} readonly />
              <StatusBadge status={employee.status} />
            </>
          )}
        </div>
      </div>

      {/* ── Nota sobre campos de solo lectura ───────────────────── */}
      {editing && (
        <p className="text-xs text-slate-400 dark:text-white/30">
          Los campos en gris (nombre, código, puesto, departamento) solo pueden modificarse desde el módulo de Empleados por un administrador o RRHH.
        </p>
      )}
    </div>
  )
}

// ── Subcomponentes ───────────────────────────────────────────────

function Field({
  icon: Icon, label, value, readonly,
}: {
  icon: any; label: string; value: string; readonly?: boolean
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon size={15} className="text-slate-400 shrink-0 mt-0.5 dark:text-white/30" />
      <span className="text-slate-500 w-32 shrink-0 leading-relaxed dark:text-white/40">{label}</span>
      <span className={`font-medium break-words min-w-0 ${readonly ? 'text-slate-700' : 'text-slate-900'}`}>
        {value}
      </span>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active:    { label: 'Activo',     cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    inactive:  { label: 'Inactivo',   cls: 'bg-slate-50   text-slate-500   border-slate-200'  },
    suspended: { label: 'Suspendido', cls: 'bg-amber-50   text-amber-700   border-amber-200'  },
  }
  const { label, cls } = map[status] || { label: status, cls: 'bg-slate-50 text-slate-500 border-slate-200' }
  return (
    <div className="flex items-center gap-3 text-sm">
      <Briefcase size={15} className="text-slate-400 shrink-0 dark:text-white/30" />
      <span className="text-slate-500 w-32 shrink-0 dark:text-white/40">Estado</span>
      <span className={`px-2 py-0.5 rounded-full border text-xs font-medium ${cls}`}>{label}</span>
    </div>
  )
}

