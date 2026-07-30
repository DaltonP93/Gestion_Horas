'use client'
import { useEffect, useRef, useState } from 'react'
import { UserCircle2, Camera, Save, CheckCircle, AlertCircle, ShieldAlert, Download } from 'lucide-react'
import { api, apiUrl } from '@/lib/api'

interface MeResponse {
  user: { id: number; username: string; email: string | null; full_name: string | null; role: string; photo_url?: string | null; employee_id: number | null }
  employee: { id: number; first_name: string; last_name: string; email?: string | null; phone?: string | null; address?: string | null; position?: string | null; department?: string | null; photo_url?: string | null } | null
}

export default function MiPerfilPage() {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', address: '' })
  const [photo, setPhoto] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function load() {
    try {
      const { data } = await api.get<MeResponse>('/api/me')
      setMe(data)
      const emp = data.employee
      setForm({
        first_name: emp?.first_name || (data.user.full_name?.split(' ')[0] || ''),
        last_name:  emp?.last_name  || (data.user.full_name?.split(' ').slice(1).join(' ') || ''),
        email:      data.user.email || emp?.email || '',
        phone:      emp?.phone || '',
        address:    emp?.address || '',
      })
      const p = emp?.photo_url || data.user.photo_url
      if (p) setPhoto(p.startsWith('http') ? p : apiUrl(p))
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
  }
  useEffect(() => {
    load()
    // Enfocar edición si se llegó con #editar desde el menú de cuenta.
    if (typeof window !== 'undefined' && window.location.hash === '#editar') {
      setTimeout(() => document.getElementById('first_name')?.focus(), 300)
    }
  }, [])

  async function save() {
    setError(''); setMsg('')
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setError('Correo inválido')
    setSaving(true)
    try {
      await api.patch('/api/me/profile', {
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        phone: form.phone,
        address: form.address,
      })
      setMsg('Perfil actualizado correctamente.')
      await load()
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
    finally { setSaving(false) }
  }

  async function uploadPhoto(file: File) {
    setError(''); setMsg('')
    const fd = new FormData()
    fd.append('photo', file)
    try {
      const { data } = await api.post('/api/me/photo', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (data.url) setPhoto(data.url.startsWith('http') ? data.url : apiUrl(data.url))
      setMsg('Foto actualizada.')
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
  }

  const initials = (form.first_name[0] || me?.user.username[0] || '?').toUpperCase() + (form.last_name[0] || '').toUpperCase()

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <header className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center">
          <UserCircle2 className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Mi perfil</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Editá tu información personal.</p>
        </div>
      </header>

      {error && <Banner tone="error"><AlertCircle size={18} /> {error}</Banner>}
      {msg && <Banner tone="ok"><CheckCircle size={16} /> {msg}</Banner>}

      {/* Foto */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-4">
          {photo
            ? <img src={photo} alt="" className="w-20 h-20 rounded-full object-cover" />
            : <div className="w-20 h-20 rounded-full bg-blue-600 text-white flex items-center justify-center text-2xl font-semibold">{initials}</div>}
          <div>
            <button onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-200 rounded-xl hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <Camera size={14} /> Cambiar foto
            </button>
            <p className="text-xs text-slate-400 mt-1 dark:text-white/30">JPG, PNG o WebP · máx. 5 MB</p>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadPhoto(f) }} />
          </div>
        </div>
      </section>

      {/* Datos */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="first_name" label="Nombre" value={form.first_name} onChange={v => setForm(f => ({ ...f, first_name: v }))} />
          <Field id="last_name" label="Apellido" value={form.last_name} onChange={v => setForm(f => ({ ...f, last_name: v }))} />
          <Field id="email" label="Correo" type="email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} />
          <Field id="phone" label="Teléfono" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          <div className="md:col-span-2">
            <Field id="address" label="Domicilio" value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} />
          </div>
        </div>

        {/* Datos administrados por RR.HH. (solo lectura) */}
        {me?.employee && (
          <div className="flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-100 p-3 text-xs text-slate-500 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-white/40">
            <ShieldAlert size={16} className="shrink-0 mt-0.5" />
            <div>
              <p><strong>Puesto:</strong> {me.employee.position || '—'} · <strong>Departamento:</strong> {me.employee.department || '—'}</p>
              <p className="mt-0.5">Tu rol, permisos, estado, sucursal y grupos de seguridad los gestiona RR.HH. — no se editan desde aquí.</p>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </section>

      <PrivacySection />
    </div>
  )
}
function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 p-3 dark:border-white/[0.06]">
      <p className="text-slate-500 dark:text-white/40">{label}</p>
      <p className="text-slate-900 dark:text-white font-medium">{value}</p>
    </div>
  )
}

function PrivacySection() {
  const [downloading, setDownloading] = useState(false)
  const [pErr, setPErr] = useState('')

  async function download() {
    setPErr(''); setDownloading(true)
    try {
      const res = await api.get('/api/me/data-export', { responseType: 'blob' })
      const blob = new Blob([res.data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mis-datos-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) { setPErr(e.response?.data?.error || e.message) }
    finally { setDownloading(false) }
  }

  return (
    <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-1">Privacidad y datos personales</h2>
      <p className="text-xs text-slate-500 dark:text-white/40 mb-3">
        Podés descargar una copia estructurada de tus datos personales (perfil, marcaciones, permisos)
        conforme a la Ley 6534/2020 de Paraguay.
      </p>
      {pErr && <div className="text-xs text-red-600 mb-2">{pErr}</div>}
      <button onClick={download} disabled={downloading}
        className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-200 rounded-xl hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04] disabled:opacity-60">
        <Download size={14} /> {downloading ? 'Preparando…' : 'Descargar mis datos (JSON)'}
      </button>
    </section>
  )
}

function PrivacySection() {
  const [downloading, setDownloading] = useState(false)
  const [pErr, setPErr] = useState('')

  async function download() {
    setPErr(''); setDownloading(true)
    try {
      const res = await api.get('/api/me/data-export', { responseType: 'blob' })
      const blob = new Blob([res.data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mis-datos-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) { setPErr(e.response?.data?.error || e.message) }
    finally { setDownloading(false) }
  }

  return (
    <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-1">Privacidad y datos personales</h2>
      <p className="text-xs text-slate-500 dark:text-white/40 mb-3">
        Podés descargar una copia estructurada de tus datos personales (perfil, marcaciones, permisos)
        conforme a la Ley 6534/2020 de Paraguay.
      </p>
      {pErr && <div className="text-xs text-red-600 mb-2">{pErr}</div>}
      <button onClick={download} disabled={downloading}
        className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-200 rounded-xl hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04] disabled:opacity-60">
        <Download size={14} /> {downloading ? 'Preparando…' : 'Descargar mis datos (JSON)'}
      </button>
    </section>
  )
}

function Field({ id, label, value, onChange, type = 'text' }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">{label}</label>
      <input id={id} type={type} value={value} onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]" />
    </div>
  )
}

function Banner({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  const cls = tone === 'ok'
    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
    : 'bg-red-50 border-red-200 text-red-900'
  return <div className={`border rounded-xl p-4 flex items-center gap-2 text-sm ${cls}`}>{children}</div>
}
