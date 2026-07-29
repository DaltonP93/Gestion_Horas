'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Building2, Plus, Edit, X, MapPin, Save } from 'lucide-react'
import { api } from '@/lib/api'

interface Branch {
  id: number
  code: string
  name: string
  address: string | null
  city: string | null
  phone: string | null
  timezone: string
  active: number
  employee_count: number
  device_count: number
  geo_lat: number | null
  geo_lng: number | null
  geo_radius_m: number | null
}

export default function SedesPage() {
  const [items, setItems] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Branch | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/api/branches')
      setItems(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar sedes')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleToggle(b: Branch) {
    try {
      await api.put(`/api/branches/${b.id}`, { active: b.active ? 0 : 1 })
      load()
    } catch (e: any) { alert(e?.response?.data?.error || 'Error') }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link href="/configuracion" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-white/40">
          <ArrowLeft size={16} aria-hidden="true" /> Volver
        </Link>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <Building2 size={20} className="text-indigo-600" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Sedes / Sucursales</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Gestión multi-sede: cada empleado y reloj pertenece a una sede.</p>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-semibold"
        >
          <Plus size={16} aria-hidden="true" /> Nueva sede
        </button>
      </div>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <GeofenceConfig />

      <div className="bg-white rounded-2xl shadow border border-slate-200 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.08]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-white/[0.03] dark:text-white/60">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Código</th>
              <th className="text-left px-4 py-3 font-semibold">Nombre</th>
              <th className="text-left px-4 py-3 font-semibold">Ciudad</th>
              <th className="text-center px-4 py-3 font-semibold">Empleados</th>
              <th className="text-center px-4 py-3 font-semibold">Relojes</th>
              <th className="text-center px-4 py-3 font-semibold">Estado</th>
              <th className="text-right px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-slate-400 dark:text-white/30">Sin sedes registradas</td></tr>
            )}
            {items.map(b => (
              <tr key={b.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                <td className="px-4 py-3 font-mono text-slate-700 dark:text-white/80">{b.code}</td>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                  {b.name}
                  {b.geo_lat != null && b.geo_lng != null && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 dark:bg-teal-400/10 dark:text-teal-300" title={`Geocerca: radio ${b.geo_radius_m || 200}m`}>
                      <MapPin size={10} /> {b.geo_radius_m || 200}m
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600 dark:text-white/60">{b.city || '—'}</td>
                <td className="px-4 py-3 text-center">{b.employee_count}</td>
                <td className="px-4 py-3 text-center">{b.device_count}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block text-xs px-2 py-1 rounded-full ${b.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {b.active ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => setEditing(b)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800">
                    <Edit size={14} aria-hidden="true" /> Editar
                  </button>
                  <button onClick={() => handleToggle(b)} className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-800 dark:text-white/60">
                    {b.active ? 'Desactivar' : 'Activar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <BranchModal
          branch={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function BranchModal({ branch, onClose, onSaved }: { branch: Branch | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!branch
  const [form, setForm] = useState({
    code: branch?.code || '',
    name: branch?.name || '',
    address: branch?.address || '',
    city: branch?.city || '',
    phone: branch?.phone || '',
    timezone: branch?.timezone || 'America/Asuncion',
    geo_lat: branch?.geo_lat != null ? String(branch.geo_lat) : '',
    geo_lng: branch?.geo_lng != null ? String(branch.geo_lng) : '',
    geo_radius_m: branch?.geo_radius_m != null ? String(branch.geo_radius_m) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [locating, setLocating] = useState(false)

  function useMyLocation() {
    if (!navigator.geolocation) { setError('El navegador no soporta geolocalización'); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      pos => { setForm(f => ({ ...f, geo_lat: pos.coords.latitude.toFixed(6), geo_lng: pos.coords.longitude.toFixed(6) })); setLocating(false) },
      () => { setError('No se pudo obtener la ubicación'); setLocating(false) },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      if (isEdit) await api.put(`/api/branches/${branch!.id}`, form)
      else await api.post('/api/branches', form)
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="sede-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 id="sede-title" className="text-lg font-bold text-slate-900 dark:text-white">{isEdit ? 'Editar sede' : 'Nueva sede'}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={20} aria-hidden="true" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Código *" value={form.code} onChange={v => setForm(f => ({ ...f, code: v }))} required disabled={isEdit} />
          <Field label="Nombre *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Dirección" value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} />
          <Field label="Ciudad" value={form.city} onChange={v => setForm(f => ({ ...f, city: v }))} />
          <Field label="Teléfono" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          <Field label="Zona horaria" value={form.timezone} onChange={v => setForm(f => ({ ...f, timezone: v }))} />

          {/* Geocerca */}
          <div className="pt-2 border-t border-slate-100 dark:border-white/[0.06]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-700 dark:text-white/80 flex items-center gap-1.5"><MapPin size={14} /> Geocerca</span>
              <button type="button" onClick={useMyLocation} disabled={locating}
                className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 hover:border-teal-300 text-slate-600 dark:border-white/[0.08] dark:text-white/70 disabled:opacity-50">
                {locating ? 'Ubicando...' : 'Usar mi ubicación'}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Latitud" value={form.geo_lat} onChange={v => setForm(f => ({ ...f, geo_lat: v }))} />
              <Field label="Longitud" value={form.geo_lng} onChange={v => setForm(f => ({ ...f, geo_lng: v }))} />
              <Field label="Radio (m)" value={form.geo_radius_m} onChange={v => setForm(f => ({ ...f, geo_radius_m: v }))} />
            </div>
            <p className="text-[11px] text-slate-400 dark:text-white/30 mt-1">Dejá lat/lng vacíos para no validar perímetro en esta sede.</p>
          </div>

          {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-white/80">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60">
              {saving ? 'Guardando...' : (isEdit ? 'Guardar' : 'Crear')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function GeofenceConfig() {
  const [mode, setMode] = useState('enforce')
  const [radius, setRadius] = useState('200')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.get('/api/settings/admin').then(r => {
      const s = r.data || {}
      if (s.geofence_mode) setMode(s.geofence_mode)
      if (s.geofence_default_radius_m) setRadius(String(s.geofence_default_radius_m))
    }).catch(() => {})
  }, [])

  async function save() {
    setSaving(true); setMsg('')
    try {
      await api.put('/api/settings', { geofence_mode: mode, geofence_default_radius_m: String(parseInt(radius, 10) || 200) })
      setMsg('Configuración de geocerca guardada.')
    } catch { setMsg('No se pudo guardar.') } finally { setSaving(false) }
  }

  return (
    <div className="bg-white rounded-2xl shadow border border-slate-200 p-5 dark:bg-white/[0.04] dark:border-white/[0.08]">
      <div className="flex items-center gap-2 mb-3">
        <MapPin size={17} className="text-teal-500" />
        <h2 className="font-bold text-slate-900 dark:text-white">Geocerca de marcación móvil</h2>
      </div>
      {msg && <div className="mb-3 text-sm rounded-xl px-4 py-2.5 bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Modo</label>
          <select value={mode} onChange={e => setMode(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
            <option value="off">Desactivado (no valida)</option>
            <option value="warn">Advertir (registra pero permite)</option>
            <option value="enforce">Exigir (rechaza fuera del radio)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Radio por defecto (m)</label>
          <input type="number" min={0} value={radius} onChange={e => setRadius(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-32 dark:border-white/[0.08] bg-transparent" />
        </div>
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm flex items-center gap-2 disabled:opacity-50">
          <Save size={15} /> {saving ? 'Guardando...' : 'Guardar'}
        </button>
      </div>
      <p className="text-[11px] text-slate-400 dark:text-white/30 mt-2">Se usa cuando el empleado marca desde la app con GPS. El radio por defecto aplica a sedes sin radio propio.</p>
    </div>
  )
}

function Field({ label, value, onChange, required, disabled }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; disabled?: boolean }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">{label}</label>
      <input
        type="text"
        required={required}
        disabled={disabled}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-500 dark:border-white/[0.08]"
      />
    </div>
  )
}
