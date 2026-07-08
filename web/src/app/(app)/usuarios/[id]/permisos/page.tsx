'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Save, RotateCcw, Shield, AlertCircle, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'

interface ModuleDef { key: string; label: string; section: 'portal' | 'gestion' | 'admin' }
interface Flags { can_view: number | boolean; can_create: number | boolean; can_update: number | boolean; can_delete: number | boolean }

const SECTION_LABEL: Record<string, string> = { portal: 'Portal del empleado', gestion: 'Gestión', admin: 'Administración' }

export default function UserPermissionsPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [modules, setModules] = useState<ModuleDef[]>([])
  const [effective, setEffective] = useState<Record<string, Flags>>({})
  const [hasOverrides, setHasOverrides] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  async function load() {
    setLoading(true); setMsg(null)
    try {
      const r = await api.get(`/api/users/${id}/permissions`)
      setUser(r.data.user); setModules(r.data.modules); setEffective(r.data.effective)
      setHasOverrides(r.data.has_overrides)
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.response?.data?.error || 'Error al cargar permisos' })
    } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [id])

  function toggle(mod: string, field: keyof Flags) {
    setEffective(prev => ({ ...prev, [mod]: { ...prev[mod], [field]: prev[mod][field] ? 0 : 1 } }))
  }

  function setRow(mod: string, value: boolean) {
    setEffective(prev => ({ ...prev, [mod]: { can_view: value ? 1 : 0, can_create: value ? 1 : 0, can_update: value ? 1 : 0, can_delete: value ? 1 : 0 } }))
  }

  async function save() {
    setSaving(true); setMsg(null)
    try {
      await api.put(`/api/users/${id}/permissions`, { permissions: effective })
      setMsg({ type: 'ok', text: 'Permisos guardados correctamente' })
      setHasOverrides(true)
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.response?.data?.error || 'Error al guardar' })
    } finally { setSaving(false) }
  }

  async function reset() {
    if (!confirm('¿Restaurar los permisos al comportamiento por defecto del rol?')) return
    setSaving(true); setMsg(null)
    try {
      await api.delete(`/api/users/${id}/permissions`)
      setMsg({ type: 'ok', text: 'Permisos restaurados al rol' })
      await load()
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.response?.data?.error || 'Error al restaurar' })
    } finally { setSaving(false) }
  }

  const bySection = modules.reduce<Record<string, ModuleDef[]>>((a, m) => {
    (a[m.section] ||= []).push(m); return a
  }, {})

  return (
    <div className="p-6 max-w-5xl space-y-5">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-white/40">
        <ArrowLeft size={16} /> Volver
      </button>

      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center">
          <Shield className="text-white" size={22} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Permisos granulares</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">
            {user ? <>Usuario <strong>{user.username || `#${user.id}`}</strong> · rol <strong>{user.role}</strong></> : 'Cargando usuario...'}
            {hasOverrides && <span className="ml-2 inline-block px-2 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800">con overrides</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={reset} disabled={saving || !hasOverrides}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-700 disabled:opacity-50 dark:bg-white/[0.06] dark:text-white/80">
            <RotateCcw size={14} /> Restaurar del rol
          </button>
          <button onClick={save} disabled={saving || loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50">
            <Save size={14} /> {saving ? 'Guardando...' : 'Guardar permisos'}
          </button>
        </div>
      </div>

      {msg && (
        <div role="alert" className={`rounded-xl px-4 py-3 text-sm flex items-center gap-2
          ${msg.type === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                              : 'bg-red-50 border border-red-200 text-red-700'}`}>
          {msg.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {msg.text}
        </div>
      )}

      {loading && <div className="text-center py-12 text-slate-400 dark:text-white/30">Cargando...</div>}

      {!loading && Object.entries(bySection).map(([section, mods]) => (
        <div key={section} className="bg-white rounded-2xl shadow border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.06]">
            <h2 className="font-semibold text-slate-900 text-sm dark:text-white">{SECTION_LABEL[section]}</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-2 text-left">Módulo</th>
                <th className="px-4 py-2 text-center w-20">Ver</th>
                <th className="px-4 py-2 text-center w-20">Crear</th>
                <th className="px-4 py-2 text-center w-20">Actualizar</th>
                <th className="px-4 py-2 text-center w-20">Eliminar</th>
                <th className="px-4 py-2 text-right w-32"></th>
              </tr>
            </thead>
            <tbody>
              {mods.map(m => {
                const f = effective[m.key] || { can_view: 0, can_create: 0, can_update: 0, can_delete: 0 }
                return (
                  <tr key={m.key} className="border-t border-slate-100 dark:border-white/[0.06]">
                    <td className="px-4 py-2 font-medium text-slate-900 dark:text-white">{m.label}</td>
                    {(['can_view','can_create','can_update','can_delete'] as (keyof Flags)[]).map(k => (
                      <td key={k} className="px-4 py-2 text-center">
                        <input type="checkbox" checked={!!f[k]} onChange={() => toggle(m.key, k)}
                          className="w-4 h-4 accent-indigo-600 cursor-pointer" />
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => setRow(m.key, true)} className="text-xs text-emerald-600 hover:underline mr-2">todo</button>
                      <button onClick={() => setRow(m.key, false)} className="text-xs text-slate-500 hover:underline dark:text-white/40">nada</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
        <strong>Nota:</strong> los usuarios con rol <em>admin</em> o <em>super_admin</em> siempre tienen todos los permisos habilitados y no son afectados por esta matriz. El resto de roles usan esta tabla cuando hay overrides; en caso contrario, se aplica el comportamiento por defecto del rol.
      </div>
    </div>
  )
}
