'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCurrentUser, isSuperAdmin, hasRole } from '@/lib/useCurrentUser'
import {
  Wifi, WifiOff, RefreshCw, Plus, Trash2, Globe,
  Zap, CheckCircle, XCircle, AlertCircle, Database,
  Server, Eye, EyeOff, Save, Activity, Edit2, X,
  Monitor, Users, Download, Eraser, Clock,
  MapPin, Hash, ChevronDown, ChevronUp, Image,
  Info, Settings2, Power, PowerOff, HardDrive,
  Cpu, MemoryStick, Fingerprint
} from 'lucide-react'
import { api } from '@/lib/api'
import VincularEmpleadoModal from '@/components/VincularEmpleadoModal'
import SyncWizard from '@/components/config/SyncWizard'

// ─── Tipos ──────────────────────────────────────────────────────
interface Device {
  id: number; name: string; ip_address: string; port: number
  location?: string; serial_no?: string; status?: string; last_sync?: string
  connection_mode?: 'auto' | 'tcp' | 'udp'
  comm_password?: string | null
  timeout_ms?: number
}
interface Webhook  { id: number; name: string; url: string; events: string[]; active: number; last_called: string; last_status: number }
interface SystemSettings {
  system_name: string; system_logo_url: string; system_favicon_url: string
  system_login_bg: string; system_primary_color: string
  system_login_title: string; system_login_subtitle: string; system_company: string
  employee_display_mode: 'full_name' | 'code_name' | 'code_only'
}

// La integración att2000 (antes pestaña "Sincronización BD") se movió a su
// ubicación canónica: /sistema/legado-att2000 (integración legada, super_admin).

const inputCls = "w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
const labelCls = "text-xs font-medium text-slate-600 block mb-1"

// ─── Componente principal ─────────────────────────────────────
function ConfiguracionPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const user = useCurrentUser()
  // El módulo Relojes ZKTeco es visible para admin y super_admin. `admin`
  // OPERA y DIAGNOSTICA (ver relojes, conectar, diagnosticar, descargar/leer,
  // vincular usuarios) — todo eso ya está autorizado en la API para 'admin'.
  // La GESTIÓN sensible (alta/edición/borrado de relojes, habilitar/deshabilitar/
  // limpiar y el asistente de sincronización/autopolling) queda SÓLO para
  // super_admin: son comandos a relojes reales e infraestructura, y la API los
  // sigue exigiendo con requireSuperAdmin (esta guarda de UI sólo evita mostrar
  // botones que devolverían 403).
  const canTech = hasRole(user, 'admin')       // admin + super_admin ven el tab
  const canManageDevices = isSuperAdmin(user)  // sólo super_admin gestiona/limpia/autopolling

  // Compatibilidad: /configuracion?tab=sync (integración att2000) se movió a su
  // ubicación canónica. Redirige a /sistema/legado-att2000 (esa página gatea
  // super_admin y muestra una página segura si no está autorizado).
  useEffect(() => {
    if (searchParams.get('tab') === 'sync') router.replace('/sistema/legado-att2000')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // El tab Relojes ZKTeco lo ven admin y super_admin (canTech). El resto de
  // roles ven únicamente Sistema / Webhooks / API.
  const allTabs = [
    { id: 'sistema',   label: '🖥️ Sistema',              show: true },
    { id: 'relojes',   label: '⌚ Relojes ZKTeco',         show: canTech },
    { id: 'webhooks',  label: '🔗 Webhooks',               show: true },
    { id: 'api',       label: '📖 API & Integración',      show: true },
  ] as const
  const tabs = allTabs.filter(t => t.show)

  const initialTab = (() => {
    const q = searchParams.get('tab') as any
    if (q && tabs.some(t => t.id === q)) return q
    return canTech ? 'relojes' : 'sistema'
  })()

  const [tab, setTab] = useState<'sistema'|'relojes'|'webhooks'|'api'>(initialTab)

  // Si el rol cambia y el tab actual ya no está permitido, resetear
  useEffect(() => {
    if (!tabs.some(t => t.id === tab)) setTab(tabs[0]?.id as any)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canTech])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Configuración</h1>
        <div className="flex gap-2 flex-wrap">
          <a href="/configuracion/laboral"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium shadow-sm hover:bg-indigo-700 transition-colors">
            👥 Configuración laboral
          </a>
          <a href="/configuracion/turnos"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium shadow-sm hover:bg-blue-700 transition-colors">
            🕐 Turnos y horarios
          </a>
          <a href="/configuracion/feriados"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-medium shadow-sm hover:bg-red-700 transition-colors">
            📅 Feriados
          </a>
          <a href="/configuracion/sedes"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium shadow-sm hover:bg-indigo-700 transition-colors">
            🏢 Sedes
          </a>
          <a href="/configuracion/qr-asistencia"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-medium shadow-sm hover:bg-slate-900 transition-colors">
            📱 QR asistencia
          </a>
          <a href="/configuracion/apariencia"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-medium shadow-sm hover:shadow-md transition-shadow">
            🎨 Personalizar apariencia
          </a>
          <a href="/configuracion/firma"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium shadow-sm transition-colors">
            ✒️ Firma digital
          </a>
          <a href="/configuracion/metas"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium shadow-sm transition-colors">
            🎯 Metas KPI
          </a>
          <a href="/configuracion/plantillas-email"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-sm transition-colors">
            ✉️ Plantillas de email
          </a>
        </div>
      </div>
      <div className="flex gap-1 border-b border-slate-200 flex-wrap dark:border-white/[0.08]">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
              tab === t.id
                ? 'bg-white border border-b-white border-slate-200 text-blue-600 -mb-px'
                : 'text-slate-500 hover:text-slate-700'
            }`}>{t.label}</button>
        ))}
      </div>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {tab === 'sistema'  && <SistemaTab />}
        {tab === 'relojes'  && <RelojesTab canManageDevices={canManageDevices} />}
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'api'      && <ApiTab />}
      </div>
    </div>
  )
}

// ─── Tab: Sistema (Branding) ──────────────────────────────────
function SistemaTab() {
  const [settings, setSettings] = useState<SystemSettings>({
    system_name: 'Sistema de Asistencia', system_logo_url: '', system_favicon_url: '',
    system_login_bg: 'from-slate-900 to-blue-900', system_primary_color: '#2563eb',
    system_login_title: 'Sistema de Asistencia', system_login_subtitle: 'Recursos Humanos', system_company: '',
    employee_display_mode: 'full_name',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/api/settings/admin').then(r => { setSettings(s => ({ ...s, ...r.data })); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const setField = (k: keyof SystemSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings(s => ({ ...s, [k]: e.target.value }))

  async function save() {
    setSaving(true)
    try {
      await api.put('/api/settings', settings)
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { alert('Error al guardar: ' + (e.response?.data?.error || e.message)) }
    setSaving(false)
  }

  if (loading) return <div className="py-8 text-center text-slate-400 dark:text-white/30">Cargando configuración...</div>

  const gradients = [
    { value: 'from-slate-900 to-blue-900',    label: 'Slate → Azul (default)' },
    { value: 'from-blue-900 to-indigo-900',   label: 'Azul → Índigo' },
    { value: 'from-slate-900 to-slate-700',   label: 'Gris oscuro' },
    { value: 'from-emerald-900 to-teal-800',  label: 'Verde esmeralda' },
    { value: 'from-purple-900 to-indigo-800', label: 'Púrpura' },
    { value: 'from-rose-900 to-pink-800',     label: 'Rosa' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white/90">Personalización del Sistema</h2>
        <p className="text-sm text-slate-500 mt-0.5 dark:text-white/40">Logo, nombre, colores y pantalla de login</p>
      </div>

      {/* Identidad */}
      <div className="border border-slate-200 rounded-2xl p-5 space-y-4 dark:border-white/[0.08]">
        <div className="flex items-center gap-2 mb-1">
          <Monitor size={16} className="text-blue-600" />
          <h3 className="font-medium text-slate-800 dark:text-white/90">Identidad del Sistema</h3>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Nombre del sistema</label>
            <input value={settings.system_name} onChange={setField('system_name')} placeholder="Sistema de Asistencia" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Empresa / Organización</label>
            <input value={settings.system_company} onChange={setField('system_company')} placeholder="Mi Empresa S.A." className={inputCls} />
          </div>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-600 dark:bg-white/[0.03] dark:text-white/60 dark:border-white/[0.08]">
          Logo, favicon, colores y pantalla de login se configuran ahora en{' '}
          <a href="/configuracion/apariencia" className="text-blue-600 hover:underline font-medium">
            Personalizar apariencia →
          </a>
        </div>
      </div>

      {/* Visualización de empleados */}
      <div className="border border-slate-200 rounded-2xl p-5 space-y-4 dark:border-white/[0.08]">
        <div className="flex items-center gap-2 mb-1">
          <Users size={16} className="text-blue-600" />
          <h3 className="font-medium text-slate-800 dark:text-white/90">Visualización de empleados</h3>
        </div>
        <p className="text-xs text-slate-500 -mt-2 dark:text-white/40">
          Cómo mostrar los empleados en toda la aplicación. Útil si los ZKTeco no tienen nombres cargados.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { value: 'full_name', label: 'Nombre completo', sample: 'Juan García', desc: 'Muestra nombre + apellido' },
            { value: 'code_name', label: 'Código + Nombre', sample: '[3081] Juan García', desc: 'Ambos visibles' },
            { value: 'code_only', label: 'Solo código',     sample: '3081',              desc: 'Cuando no hay nombres reales' },
          ].map(opt => (
            <label key={opt.value}
              className={`block cursor-pointer rounded-xl border-2 p-3 transition-all ${
                settings.employee_display_mode === opt.value
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}>
              <input type="radio" name="display_mode" value={opt.value}
                checked={settings.employee_display_mode === opt.value}
                onChange={e => setSettings(s => ({ ...s, employee_display_mode: e.target.value as any }))}
                className="sr-only" />
              <div className="font-semibold text-sm text-slate-800 dark:text-white/90">{opt.label}</div>
              <div className="text-xs text-slate-500 mt-0.5 dark:text-white/40">{opt.desc}</div>
              <div className="font-mono text-xs bg-white border border-slate-200 rounded-lg px-2 py-1 mt-2 text-slate-700 dark:bg-white/[0.04] dark:text-white/80 dark:border-white/[0.08]">{opt.sample}</div>
            </label>
          ))}
        </div>
      </div>

      {/* Integraciones HR externas — shortcut */}
      <div className="border border-purple-200 bg-purple-50/50 rounded-2xl p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
            <Zap size={18} className="text-purple-600" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-white/90">Integraciones HR externas</h3>
            <p className="text-xs text-slate-500 dark:text-white/40">Sincronizar empleados desde SAP, Bejerman, Meta4, Odoo, CSV remoto, etc.</p>
          </div>
        </div>
        <a href="/configuracion/integraciones-hr"
          className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-purple-700">
          Configurar →
        </a>
      </div>

      {/* Login */}
      <div className="border border-slate-200 rounded-2xl p-5 space-y-4 dark:border-white/[0.08]">
        <div className="flex items-center gap-2 mb-1">
          <Image size={16} className="text-blue-600" />
          <h3 className="font-medium text-slate-800 dark:text-white/90">Pantalla de Login</h3>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Título del login</label>
            <input value={settings.system_login_title} onChange={setField('system_login_title')} placeholder="Sistema de Asistencia" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Subtítulo</label>
            <input value={settings.system_login_subtitle} onChange={setField('system_login_subtitle')} placeholder="Recursos Humanos" className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Fondo del login (gradiente)</label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {gradients.map(g => (
              <button key={g.value} onClick={() => setSettings(s => ({ ...s, system_login_bg: g.value }))}
                className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all ${
                  settings.system_login_bg === g.value ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200 hover:border-slate-300'
                }`}>
                <div className={`w-8 h-6 rounded-lg bg-gradient-to-br ${g.value} flex-shrink-0`} />
                <span className="text-slate-600 text-xs dark:text-white/60">{g.label}</span>
              </button>
            ))}
          </div>
        </div>
        {/* Preview */}
        <div className={`rounded-xl bg-gradient-to-br ${settings.system_login_bg} p-4 flex items-center justify-center`} style={{ minHeight: 110 }}>
          <div className="bg-white rounded-2xl p-4 text-center shadow-xl w-44 dark:bg-white/[0.04]">
            {settings.system_logo_url
              ? <img src={settings.system_logo_url} alt="logo" className="h-8 mx-auto mb-2 object-contain"
                  onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
              : <div className="w-8 h-8 rounded-lg mx-auto mb-2 flex items-center justify-center text-white text-sm"
                  style={{ backgroundColor: settings.system_primary_color }}>🕐</div>
            }
            <p className="text-xs font-bold text-slate-900 leading-tight dark:text-white">{settings.system_login_title || 'Sistema'}</p>
            <p className="text-xs text-slate-400 dark:text-white/30">{settings.system_login_subtitle}</p>
          </div>
        </div>
      </div>

      <button onClick={save} disabled={saving}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
          saved ? 'bg-green-100 text-green-700 border border-green-200'
                : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
        }`}>
        <Save size={16} />
        {saving ? 'Guardando...' : saved ? '✓ Guardado correctamente' : 'Guardar cambios'}
      </button>
    </div>
  )
}

// ─── Tab: Relojes ZKTeco ─────────────────────────────────────
// `canManageDevices` (sólo super_admin) habilita las acciones sensibles:
// alta/edición/borrado de relojes, habilitar/deshabilitar/limpiar y el
// asistente de sincronización (autopolling). Un admin ve el módulo y puede
// operar/diagnosticar/descargar/vincular, pero no ve esos controles (la API
// además los sigue exigiendo con requireSuperAdmin).
function RelojesTab({ canManageDevices }: { canManageDevices: boolean }) {
  const [devices, setDevices]       = useState<Device[]>([])
  const [loading, setLoading]       = useState(true)
  const [pinging, setPinging]       = useState(false)
  const [lastCheck, setLastCheck]   = useState('')
  const [showForm, setShowForm]     = useState(false)
  const [editDevice, setEditDevice] = useState<Device | null>(null)
  const [form, setForm]             = useState({
    name: '', ip_address: '', port: '4370', location: '', serial_no: '',
    connection_mode: 'auto' as 'auto'|'tcp'|'udp',
    comm_password: '', timeout_ms: '10000',
  })
  const [diagnose, setDiagnose]     = useState<Record<number, any>>({})
  const [saving, setSaving]         = useState(false)
  const [expanded, setExpanded]     = useState<number | null>(null)
  const [deviceTab, setDeviceTab]   = useState<Record<number, 'info'|'usuarios'|'funciones'>>({})
  const [deviceData, setDeviceData] = useState<Record<number, any>>({})
  const [deviceLoading, setDeviceLoading] = useState<Record<number, string>>({})
  const [opLog, setOpLog]           = useState<Record<number, string[]>>({})

  const [syncStatus, setSyncStatus] = useState<Record<number, any>>({})
  // Buscador de usuarios del reloj + modal de vinculación.
  const [userSearch, setUserSearch] = useState<Record<number, string>>({})
  const [linkUser, setLinkUser] = useState<{ deviceId: number; deviceName: string; userId: string; name: string | null; pending: number } | null>(null)

  async function loadDevices() {
    setLoading(true)
    try { const r = await api.get('/api/devices'); setDevices(r.data) } catch { setDevices([]) }
    setLoading(false)
  }

  async function loadSyncStatus() {
    try {
      const r = await api.get('/api/devices/sync-status')
      const map: Record<number, any> = {}
      for (const it of (r.data.items || [])) map[it.id] = it
      setSyncStatus(map)
    } catch { /* opcional */ }
  }

  useEffect(() => { loadDevices(); loadSyncStatus() }, [])

  async function pingAll() {
    setPinging(true)
    try { const r = await api.get('/api/devices/ping-all'); setDevices(r.data); setLastCheck(new Date().toLocaleTimeString()) } catch {}
    setPinging(false)
  }

  function openAdd() {
    setEditDevice(null)
    setForm({ name: '', ip_address: '', port: '4370', location: '', serial_no: '',
              connection_mode: 'auto', comm_password: '', timeout_ms: '10000' })
    setShowForm(true)
  }
  function openEdit(d: Device) {
    setEditDevice(d)
    setForm({
      name: d.name, ip_address: d.ip_address, port: String(d.port),
      location: d.location || '', serial_no: d.serial_no || '',
      connection_mode: (d.connection_mode || 'auto'),
      comm_password: d.comm_password || '',
      timeout_ms: String(d.timeout_ms || 10000),
    })
    setShowForm(true)
  }
  async function saveDevice() {
    setSaving(true)
    try {
      const payload = {
        ...form,
        port: Number(form.port),
        timeout_ms: Number(form.timeout_ms) || 10000,
        comm_password: form.comm_password || null,
      }
      if (editDevice) await api.put(`/api/devices/${editDevice.id}`, payload)
      else await api.post('/api/devices', payload)
      setShowForm(false); await loadDevices()
    } catch (e: any) { alert('Error: ' + (e.response?.data?.error || e.message)) }
    setSaving(false)
  }
  async function doDiagnose(d: Device) {
    setBusy(d.id, 'diagnose')
    addLog(d.id, `🔍 Diagnosticando conectividad con ${d.name}...`)
    try {
      const r = await api.post(`/api/devices/${d.id}/diagnose`, {})
      setDiagnose(p => ({ ...p, [d.id]: r.data }))
      addLog(d.id, `✓ ${r.data.summary}`)
      if (r.data.recommendation) addLog(d.id, `💡 ${r.data.recommendation}`)
    } catch (e: any) { addLog(d.id, `❌ Error: ${errMsg(e)}`) }
    setBusy(d.id, '')
  }
  async function deleteDevice(id: number, name: string) {
    if (!confirm(`¿Eliminar el reloj "${name}"?`)) return
    try { await api.delete(`/api/devices/${id}`); await loadDevices() } catch (e: any) { alert('Error: ' + (e.response?.data?.error || e.message)) }
  }

  function addLog(id: number, msg: string) {
    setOpLog(p => ({ ...p, [id]: [new Date().toLocaleTimeString() + ' — ' + msg, ...(p[id] || [])] }))
  }
  function setBusy(id: number, op: string) { setDeviceLoading(p => ({ ...p, [id]: op })) }

  function getTab(id: number) { return deviceTab[id] || 'info' }
  function setTab(id: number, t: 'info'|'usuarios'|'funciones') { setDeviceTab(p => ({ ...p, [id]: t })) }

  async function loadInfo(d: Device) {
    setBusy(d.id, 'info')
    try {
      const r = await api.get(`/api/devices/${d.id}/info`)
      setDeviceData(p => ({ ...p, [d.id]: { ...p[d.id], info: r.data } }))
    } catch {
      // Detalle técnico no se muestra: mensaje neutro + reintento manual.
      setDeviceData(p => ({ ...p, [d.id]: { ...p[d.id], info: { unavailable: true, message: 'Información temporalmente no disponible.' } } }))
    }
    setBusy(d.id, '')
  }
  async function loadPushStatus(d: Device) {
    setBusy(d.id, 'push')
    try {
      const r = await api.get(`/api/devices/${d.id}/push-status`)
      setDeviceData(p => ({ ...p, [d.id]: { ...p[d.id], push: r.data } }))
    } catch (e: any) {
      // El servidor ya responde con la forma normalizada incluso al fallar;
      // esto sólo cubre el caso de no llegar a hablar con él.
      const body = e.response?.data
      setDeviceData(p => ({ ...p, [d.id]: { ...p[d.id], push: body?.status
        ? body
        : { available: false, status: 'unavailable', message: 'No se pudo verificar el estado PUSH.' } } }))
    }
    setBusy(d.id, '')
  }
  async function loadUsers(d: Device) {
    setBusy(d.id, 'users')
    try {
      const r = await api.get(`/api/devices/${d.id}/users`)
      setDeviceData(p => ({ ...p, [d.id]: { ...p[d.id], users: r.data } }))
    } catch (e: any) {
      const msg = e.response?.data?.error || e.response?.data?.message || e.message
      setDeviceData(p => ({ ...p, [d.id]: { ...p[d.id], users: { error: msg } } }))
    }
    setBusy(d.id, '')
  }

  const errMsg = (e: any) => e.response?.data?.error || e.response?.data?.message || e.message

  async function doBackup(d: Device, pushAtt2000 = false) {
    setBusy(d.id, 'backup')
    addLog(d.id, pushAtt2000
      ? `⬇️ Backup de "${d.name}" + envío a att2000...`
      : `⬇️ Iniciando backup de "${d.name}"...`)
    try {
      const r = await api.post(`/api/devices/${d.id}/backup`, { push_att2000: pushAtt2000 })
      if (r.data.ok === false) addLog(d.id, `❌ ${r.data.error}`)
      else {
        addLog(d.id, `✅ Lectura: leídos ${r.data.total_read ?? 0} · en rango ${r.data.in_range ?? 0} · +${r.data.imported ?? 0} importados · dup ${r.data.skipped ?? 0} · sin empleado ${r.data.notFound ?? 0}${r.data.read_unstable ? ' · ⚠️ lectura inestable' : ''}`)
      }
      if (pushAtt2000 && r.data.att2000) {
        const a = r.data.att2000
        if (a.error) addLog(d.id, `⚠️ att2000: ${a.error}`)
        else addLog(d.id, `✅ att2000: ${a.inserted} enviados, ${a.skipped} ya existían`)
      }
    } catch (e: any) { addLog(d.id, `❌ Error: ${errMsg(e)}`) }
    setBusy(d.id, '')
    loadSyncStatus()
  }
  async function doClear(d: Device) {
    if (!confirm(`⚠️ ¿Eliminar TODOS los registros del reloj "${d.name}"? Solo borra del reloj, no de la BD.`)) return
    setBusy(d.id, 'clear'); addLog(d.id, `🗑️ Eliminando registros de "${d.name}"...`)
    try {
      const r = await api.post(`/api/devices/${d.id}/clear`)
      addLog(d.id, `✅ ${r.data.message}`)
    } catch (e: any) { addLog(d.id, `❌ Error: ${errMsg(e)}`) }
    setBusy(d.id, '')
  }
  async function doEnable(d: Device) {
    setBusy(d.id, 'enable'); addLog(d.id, `▶️ Habilitando "${d.name}"...`)
    try { const r = await api.post(`/api/devices/${d.id}/enable`); addLog(d.id, `✅ ${r.data.message}`) }
    catch (e: any) { addLog(d.id, `❌ Error: ${errMsg(e)}`) }
    setBusy(d.id, '')
  }
  async function doDisable(d: Device) {
    if (!confirm(`¿Deshabilitar el reloj "${d.name}"? Los empleados no podrán marcar.`)) return
    setBusy(d.id, 'disable'); addLog(d.id, `⏸️ Deshabilitando "${d.name}"...`)
    try { const r = await api.post(`/api/devices/${d.id}/disable`); addLog(d.id, `✅ ${r.data.message}`) }
    catch (e: any) { addLog(d.id, `❌ Error: ${errMsg(e)}`) }
    setBusy(d.id, '')
  }

  function toggleExpand(id: number) {
    const opening = expanded !== id
    setExpanded(opening ? id : null)
    // NO auto-carga info al expandir — el usuario hace clic en "Conectar"
  }

  return (
    <div className="space-y-4">
      {/* Modal de vinculación de usuario del reloj → empleado */}
      {linkUser && (
        <VincularEmpleadoModal
          deviceUserId={linkUser.userId}
          deviceId={linkUser.deviceId}
          deviceName={linkUser.deviceName}
          deviceUserName={linkUser.name}
          marcas={linkUser.pending}
          onClose={() => setLinkUser(null)}
          onDone={(s) => {
            addLog(linkUser.deviceId, `🔗 ${linkUser.userId} vinculado: importadas ${s.mapped || 0}, duplicadas ${s.duplicate || 0}.`)
            const dev = devices.find(dd => dd.id === linkUser.deviceId)
            if (dev) loadUsers(dev)
            loadSyncStatus()
          }} />
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white/90">Relojes Biométricos ZKTeco</h2>
          <p className="text-sm text-slate-500 mt-0.5 dark:text-white/40">
            Gestión y operaciones directas (puerto 4370)
            {lastCheck && <span className="ml-2 text-slate-400 dark:text-white/30">— verificado a las {lastCheck}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={pingAll} disabled={pinging}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-50 transition-colors dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            <Activity size={14} className={pinging ? 'animate-pulse text-blue-500' : ''} />
            {pinging ? 'Verificando...' : 'Verificar estado'}
          </button>
          {canManageDevices && (
            <button onClick={openAdd}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors">
              <Plus size={14} /> Agregar reloj
            </button>
          )}
        </div>
      </div>

      {/* Sincronización automática (worker PM2) — sólo super_admin (autopolling). */}
      {canManageDevices && <SyncWizard />}

      {/* Formulario add/edit — sólo super_admin. */}
      {canManageDevices && showForm && (
        <div className="border border-blue-100 bg-blue-50 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-slate-800 dark:text-white/90">{editDevice ? 'Editar reloj' : 'Agregar nuevo reloj'}</h3>
            <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={18} /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Nombre *</label><input value={form.name} onChange={e => setForm(f=>({...f,name:e.target.value}))} placeholder="ej: Reloj Comedor" className={inputCls} /></div>
            <div><label className={labelCls}>Ubicación</label><input value={form.location} onChange={e => setForm(f=>({...f,location:e.target.value}))} placeholder="ej: Planta Baja" className={inputCls} /></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><label className={labelCls}>Dirección IP *</label><input value={form.ip_address} onChange={e => setForm(f=>({...f,ip_address:e.target.value}))} placeholder="10.0.0.160" className={inputCls} /></div>
            <div><label className={labelCls}>Puerto</label><input value={form.port} onChange={e => setForm(f=>({...f,port:e.target.value}))} placeholder="4370" className={inputCls} /></div>
          </div>
          <div><label className={labelCls}>N° de serie (opcional)</label><input value={form.serial_no} onChange={e => setForm(f=>({...f,serial_no:e.target.value}))} placeholder="ej: ABCD123456" className={inputCls} /></div>

          {/* Parámetros avanzados de conexión */}
          <details className="rounded-lg bg-white border border-blue-100 p-3 dark:bg-white/[0.04]">
            <summary className="text-sm font-medium text-slate-700 cursor-pointer dark:text-white/80">
              ⚙️ Parámetros de conexión ZKTeco (avanzado)
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <label className={labelCls}>Modo de conexión</label>
                <div className="flex gap-2">
                  {(['auto','tcp','udp'] as const).map(m => (
                    <label key={m} className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm ${
                      form.connection_mode === m ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 hover:bg-slate-50'
                    }`}>
                      <input type="radio" checked={form.connection_mode === m}
                        onChange={() => setForm(f => ({ ...f, connection_mode: m }))} className="sr-only" />
                      <span className="font-medium">{m.toUpperCase()}</span>
                      <span className="text-xs text-slate-500 dark:text-white/40">
                        {m === 'auto' && '(TCP con fallback UDP)'}
                        {m === 'tcp' && '(modelos modernos)'}
                        {m === 'udp' && '(GT200 y modelos antiguos)'}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-1 dark:text-white/30">
                  Si el reloj acepta TCP pero no responde al protocolo ZKTeco, probar <strong>UDP</strong>.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Contraseña comunicación (commkey)</label>
                  <input type="text" value={form.comm_password}
                    onChange={e => setForm(f => ({ ...f, comm_password: e.target.value }))}
                    placeholder="solo si está configurada en el reloj"
                    className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Timeout (ms)</label>
                  <input type="number" value={form.timeout_ms}
                    onChange={e => setForm(f => ({ ...f, timeout_ms: e.target.value }))}
                    placeholder="10000" className={inputCls} />
                </div>
              </div>
            </div>
          </details>

          <div className="flex gap-3">
            <button onClick={saveDevice} disabled={saving || !form.name || !form.ip_address}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700 disabled:opacity-50">
              <Save size={14} /> {saving ? 'Guardando...' : editDevice ? 'Actualizar' : 'Agregar'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          </div>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="py-8 text-center text-slate-400 dark:text-white/30">Cargando relojes...</div>
      ) : devices.length === 0 ? (
        <div className="py-8 text-center text-slate-400 dark:text-white/30">
          <Clock size={32} className="mx-auto mb-2 opacity-30" />
          <p>No hay relojes registrados.</p>
          {canManageDevices
            ? <button onClick={openAdd} className="mt-3 text-blue-600 text-sm hover:underline">+ Agregar el primer reloj</button>
            : <p className="mt-2 text-xs">Un super administrador debe registrar los relojes.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {devices.map(d => {
            const status = d.status || 'unknown'
            const isOpen = expanded === d.id
            const busy   = deviceLoading[d.id] || ''
            const tab    = getTab(d.id)
            const data   = deviceData[d.id] || {}
            const log    = opLog[d.id] || []

            return (
              <div key={d.id} className={`rounded-xl border overflow-hidden ${
                status === 'online' ? 'border-green-200' : status === 'offline' ? 'border-red-200' : 'border-slate-200'
              }`}>
                {/* Cabecera */}
                <div className={`flex items-center gap-4 p-4 ${
                  status === 'online' ? 'bg-green-50' : status === 'offline' ? 'bg-red-50' : 'bg-slate-50'
                }`}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    status === 'online' ? 'bg-green-100 text-green-600' : status === 'offline' ? 'bg-red-100 text-red-500' : 'bg-slate-100 text-slate-400'
                  }`}>
                    {status === 'online' ? <Wifi size={20} /> : <WifiOff size={20} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-800 dark:text-white/90">{d.name}</p>
                    <p className="text-sm font-mono text-slate-500 dark:text-white/40">{d.ip_address}:{d.port}</p>
                    {(d.location || d.serial_no) && (
                      <p className="text-xs text-slate-400 mt-0.5 dark:text-white/30">
                        {d.location && <span><MapPin size={10} className="inline mr-1"/>{d.location}</span>}
                        {d.serial_no && <span className="ml-2"><Hash size={10} className="inline mr-1"/>{d.serial_no}</span>}
                      </p>
                    )}
                    {d.last_sync && <p className="text-xs text-slate-400 dark:text-white/30">Sync: {new Date(d.last_sync).toLocaleString()}</p>}
                    {syncStatus[d.id] && (() => {
                      const s = syncStatus[d.id]
                      const run = s.last_run
                      return (
                        <>
                          <p className={`text-xs mt-0.5 ${s.suspect ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {s.suspect ? '⚠️' : '✓'} Hoy: {s.marks_today} marcas · {s.employees_today} empleados
                            {run && ` · último: ${run.status}${run.error ? ` (${String(run.error).slice(0, 60)})` : ''}${run.attempts ? ` · ${run.attempts} intento(s)` : ''}${run.duration_ms ? ` · ${(run.duration_ms / 1000).toFixed(1)}s` : ''}`}
                          </p>
                          {s.partial && (
                            <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70 mt-0.5">
                              ⚠️ Conectado, pero lectura parcial: no cubrió el rango. Recibido {run?.first_valid || '?'} → {run?.last_valid || '?'}. Reintentá con más intentos/cooldown.
                            </p>
                          )}
                          {run && run.unmapped > 0 && (
                            <p className="text-[11px] text-sky-700/80 dark:text-sky-300/70 mt-0.5">
                              🔗 {run.unmapped} marca(s) sin empleado en la última lectura (vinculá en “Marcaciones sin empleado”). No afecta el estado de lectura.
                            </p>
                          )}
                          {s.recommendation && <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70 mt-0.5">💡 {s.recommendation}</p>}
                        </>
                      )
                    })()}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full hidden sm:block ${
                      status === 'online' ? 'bg-green-100 text-green-700' : status === 'offline' ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {status === 'online' ? '● En línea' : status === 'offline' ? '● Sin conexión' : '● Sin estado'}
                    </span>
                    <button onClick={() => doDiagnose(d)} disabled={!!deviceLoading[d.id]}
                      title="Diagnosticar conectividad"
                      className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg disabled:opacity-50 dark:text-white/30">
                      <Activity size={15}/>
                    </button>
                    {canManageDevices && (
                      <>
                        <button onClick={() => openEdit(d)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg dark:text-white/30"><Edit2 size={15}/></button>
                        <button onClick={() => deleteDevice(d.id, d.name)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg dark:text-white/30"><Trash2 size={15}/></button>
                      </>
                    )}
                    <button onClick={() => toggleExpand(d.id)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg dark:text-white/30 dark:hover:bg-white/[0.06]">
                      {isOpen ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
                    </button>
                  </div>
                </div>

                {/* Resultado de diagnóstico (si existe) */}
                {diagnose[d.id] && (
                  <div className="px-4 py-3 bg-amber-50 border-t border-amber-100 text-xs">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <p className="font-semibold text-amber-900">🔍 Diagnóstico de conectividad</p>
                      <button onClick={() => setDiagnose(p => { const n = {...p}; delete n[d.id]; return n })}
                        className="text-amber-600 hover:text-amber-800"><X size={14}/></button>
                    </div>
                    <div className="space-y-1 font-mono text-slate-700 dark:text-white/80">
                      {diagnose[d.id].steps?.map((s: any, i: number) => (
                        <div key={i} className="flex gap-2">
                          <span className={s.ok ? 'text-green-600' : 'text-red-500'}>{s.ok ? '✓' : '✗'}</span>
                          <span className="font-semibold">{s.step}:</span>
                          <span className="text-slate-500 dark:text-white/40">{s.detail}</span>
                        </div>
                      ))}
                    </div>
                    {diagnose[d.id].recommendation && (
                      <div className="mt-2 p-2 rounded bg-white border border-amber-200 text-amber-900 dark:bg-white/[0.04]">
                        💡 <strong>Recomendación:</strong> {diagnose[d.id].recommendation}
                      </div>
                    )}
                  </div>
                )}

                {/* Panel expandido */}
                {isOpen && (
                  <div className="border-t border-slate-100 bg-white dark:bg-white/[0.04] dark:border-white/[0.06]">

                    {/* ── Estado de conexión + botón Conectar ── */}
                    {!data.info && !deviceLoading[d.id] && (
                      <div className="p-5 flex flex-col items-center gap-4 text-center">
                        <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center">
                          <Server size={24} className="text-blue-500"/>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-white/90">Conectar al reloj</p>
                          <p className="text-xs text-slate-500 mt-1 dark:text-white/40">
                            Establecerá una conexión directa vía protocolo ZKTeco (puerto 4370).<br/>
                            Asegúrese de que ningún otro software esté usando el reloj.
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => loadInfo(d)}
                            className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
                            <Wifi size={15}/> Conectar al reloj
                          </button>
                          <button onClick={() => loadPushStatus(d)} disabled={deviceLoading[d.id] === 'push'}
                            className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50 dark:bg-white/[0.06] dark:text-white/80">
                            <RefreshCw size={14} className={deviceLoading[d.id] === 'push' ? 'animate-spin' : ''}/> Verificar PUSH
                          </button>
                        </div>

                        {data.push?.available && (
                          <div className={`w-full mt-2 p-3 rounded-xl border text-left text-xs ${
                            data.push.status === 'online' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                                          : 'bg-amber-50 border-amber-200 text-amber-800'
                          }`}>
                            <p className="font-semibold">{PUSH_STATUS_LABEL[data.push.status] || data.push.status}</p>
                            <p className="mt-1">SN: {data.push.serial || '—'}</p>
                            <p>Último contacto: {data.push.last_push_at ? new Date(data.push.last_push_at).toLocaleString() : 'nunca'}</p>
                            <p>Último marcaje PUSH: {data.push.last_event_at ? new Date(data.push.last_event_at).toLocaleString() : 'nunca'}</p>
                            {data.push.status !== 'online' && (
                              <p className="mt-2 text-amber-700">
                                Configure el reloj: Menú → Comm → Cloud Server → IP del servidor SisHoras, puerto 8080, y reinicie el reloj.
                              </p>
                            )}
                          </div>
                        )}
                        {data.push && data.push.available === false && (
                          <div className="w-full mt-2 p-3 bg-red-50 border border-red-200 rounded-xl text-left text-xs text-red-700">
                            <p>{data.push.message || 'No se pudo verificar el estado PUSH.'}</p>
                            {data.push.correlation_id && (
                              <p className="mt-1 text-red-500">Referencia: {data.push.correlation_id}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Conectando... */}
                    {deviceLoading[d.id] === 'info' && !data.info && (
                      <div className="p-8 flex flex-col items-center gap-3 text-slate-500 dark:text-white/40">
                        <RefreshCw size={24} className="animate-spin text-blue-500"/>
                        <p className="text-sm font-medium">Conectando a {d.ip_address}:{d.port}...</p>
                        <p className="text-xs text-slate-400 dark:text-white/30">Protocolo ZKTeco — puede tardar hasta 15 segundos</p>
                      </div>
                    )}

                    {/* Información en vivo no disponible (neutro, con reintento manual).
                        No se muestran detalles técnicos ni se confunde con el estado
                        del servicio de sincronización: sólo la info de este reloj. */}
                    {data.info?.unavailable && (
                      <div className="p-4">
                        <div className="flex items-start gap-3 p-4 bg-slate-50 border border-slate-200 rounded-xl dark:bg-white/[0.03] dark:border-white/[0.08]">
                          <AlertCircle size={18} className="text-slate-400 flex-shrink-0 mt-0.5"/>
                          <div className="flex-1">
                            <p className="font-semibold text-slate-700 text-sm dark:text-white/80">{data.info.message || 'Información temporalmente no disponible.'}</p>
                            <p className="text-xs text-slate-500 mt-1 dark:text-white/40">
                              Los datos en vivo del reloj no están disponibles en este momento. Podés reintentar.
                            </p>
                            <button onClick={() => loadInfo(d)} disabled={deviceLoading[d.id] === 'info'}
                              className="mt-2 flex items-center gap-2 text-sm text-blue-600 hover:underline disabled:opacity-50">
                              <RefreshCw size={13} className={deviceLoading[d.id] === 'info' ? 'animate-spin' : ''}/> Reintentar
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Conectado: mostrar tabs ── */}
                    {data.info && !data.info.unavailable && (
                      <>
                        {/* Header: conectado + botón reconectar */}
                        <div className="flex items-center justify-between px-4 pt-3 pb-2">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500 inline-block"/>
                            <span className="text-xs font-semibold text-green-700">
                              {data.info._source === 'live' ? 'Conectado — datos en vivo' : 'Datos en caché'}
                            </span>
                          </div>
                          <button onClick={() => loadInfo(d)} disabled={deviceLoading[d.id] === 'info'}
                            className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 disabled:opacity-50 dark:text-white/40">
                            <RefreshCw size={11} className={deviceLoading[d.id] === 'info' ? 'animate-spin' : ''}/> Recargar
                          </button>
                        </div>

                        {/* Sub-tabs */}
                        <div className="flex border-b border-slate-100 dark:border-white/[0.06]">
                          {[
                            { id: 'info',      label: '📊 Información' },
                            { id: 'usuarios',  label: '👥 Usuarios' },
                            { id: 'funciones', label: '⬇️ Descargar' },
                          ].map(st => (
                            <button key={st.id} onClick={() => {
                              setTab(d.id, st.id as any)
                              if (st.id === 'usuarios' && !data.users) loadUsers(d)
                            }}
                              className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                                tab === st.id ? 'border-blue-500 text-blue-600 bg-blue-50' : 'border-transparent text-slate-500 hover:text-slate-700'
                              }`}>
                              {st.label}
                            </button>
                          ))}
                        </div>

                        <div className="p-4">
                          {/* TAB: INFORMACIÓN */}
                          {tab === 'info' && (() => {
                            const inf = data.info
                            const isLive = inf._source === 'live'
                            const fmt = (v: any) => v !== undefined && v !== null ? Number(v).toLocaleString() : '—'
                            const str = (v: any) => v || '—'
                            return (
                              <div className="space-y-4">
                                <div className="border border-slate-100 rounded-xl overflow-hidden dark:border-white/[0.06]">
                                  <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-white/[0.06]">
                                    <table className="text-xs w-full">
                                      <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                                        {[
                                          ['Usuarios registrados', fmt(inf.userCounts)],
                                          ['Huellas digitales',    fmt(inf.fpCount)],
                                          ['Versión huella',       str(inf.fpVersion)],
                                          ['Registros faciales',   fmt(inf.faceCount)],
                                          ['Fecha fabricación',    str(inf.manufactureTime)],
                                          ['Número de serie',      str(inf.serialNumber)],
                                        ].map(([label, val]) => (
                                          <tr key={label}>
                                            <td className="px-3 py-1.5 text-slate-500 w-40 dark:text-white/40">{label}</td>
                                            <td className="px-3 py-1.5 text-slate-800 font-semibold dark:text-white/90">{val}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                    <table className="text-xs w-full">
                                      <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                                        {[
                                          ['Marcaciones totales', fmt(inf.logCounts)],
                                          ['Administradores',     fmt(inf.adminCount)],
                                          ['Producto',            str(inf.productName)],
                                          ['Firmware',            str(inf.firmwareVersion)],
                                          ['Plataforma',          str(inf.platform)],
                                          ['Capacidad registros', fmt(inf.logCapacity)],
                                        ].map(([label, val]) => (
                                          <tr key={label}>
                                            <td className="px-3 py-1.5 text-slate-500 w-40 dark:text-white/40">{label}</td>
                                            <td className="px-3 py-1.5 text-slate-800 font-semibold dark:text-white/90">{val}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                                {isLive && inf.userCapacity && (
                                  <div className="grid grid-cols-3 gap-3 text-center text-xs">
                                    {[
                                      ['Cap. usuarios', inf.userCapacity, 'blue'],
                                      ['Cap. huellas',  inf.fpCapacity,   'purple'],
                                      ['Cap. registros',inf.logCapacity,  'green'],
                                    ].map(([label, val, color]) => (
                                      <div key={String(label)} className={`rounded-xl border p-3 bg-${color}-50 border-${color}-100`}>
                                        <p className={`text-${color}-500 mb-1`}>{label}</p>
                                        <p className={`text-lg font-bold text-${color}-700`}>{Number(val) > 0 ? Number(val).toLocaleString() : '—'}</p>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })()}

                          {/* TAB: USUARIOS */}
                          {tab === 'usuarios' && (
                            <div>
                              {deviceLoading[d.id] === 'users' && (
                                <div className="py-8 flex flex-col items-center gap-3 text-slate-400 dark:text-white/30">
                                  <RefreshCw size={20} className="animate-spin text-blue-500"/>
                                  <p className="text-sm">Leyendo usuarios del reloj...</p>
                                </div>
                              )}
                              {data.users?.error && (
                                <div className="flex items-start gap-2 p-3 bg-red-50 rounded-xl text-red-600 text-sm">
                                  <XCircle size={16} className="flex-shrink-0 mt-0.5"/>
                                  <div>
                                    <p className="font-medium">No se pudo leer los usuarios</p>
                                    <p className="text-xs mt-0.5">{data.users.error}</p>
                                    <button onClick={() => loadUsers(d)} className="mt-2 text-xs underline">Reintentar</button>
                                  </div>
                                </div>
                              )}
                              {data.users?.users && (() => {
                                const q = (userSearch[d.id] || '').toLowerCase().trim()
                                const list = (data.users.users as any[]).filter(u =>
                                  !q || String(u.userId).toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q))
                                return (
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <p className="text-sm font-semibold text-slate-700 dark:text-white/80">
                                      {data.users.total} usuario{data.users.total !== 1 ? 's' : ''} enrolado{data.users.total !== 1 ? 's' : ''}
                                      {q && ` · ${list.length} coinciden`}
                                    </p>
                                    <div className="flex items-center gap-2">
                                      <input value={userSearch[d.id] || ''} onChange={e => setUserSearch(p => ({ ...p, [d.id]: e.target.value }))}
                                        placeholder="Buscar por ID o nombre…"
                                        className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs w-48 dark:border-white/[0.08] bg-transparent" />
                                      <button onClick={() => loadUsers(d)} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                                        <RefreshCw size={12}/> Actualizar
                                      </button>
                                    </div>
                                  </div>
                                  <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/[0.06]">
                                    <table className="w-full text-xs">
                                      <thead className="bg-slate-50 sticky top-0 dark:bg-white/[0.03]">
                                        <tr>
                                          <th className="text-left px-3 py-2 text-slate-500 font-medium dark:text-white/40">ID</th>
                                          <th className="text-left px-3 py-2 text-slate-500 font-medium dark:text-white/40">Nombre en el reloj</th>
                                          <th className="text-left px-3 py-2 text-slate-500 font-medium dark:text-white/40">Empleado</th>
                                          <th className="text-left px-3 py-2 text-slate-500 font-medium dark:text-white/40">Pendientes</th>
                                          <th className="px-3 py-2"></th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                                        {list.map((u: any, i: number) => (
                                          <tr key={i} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                                            <td className="px-3 py-2 font-mono text-slate-600 dark:text-white/60">{u.userId}</td>
                                            <td className="px-3 py-2 text-slate-800 dark:text-white/90">{u.name || <span className="text-slate-400 italic dark:text-white/30">sin nombre</span>}</td>
                                            <td className="px-3 py-2">
                                              {u.linked
                                                ? <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300 font-medium">✓ {u.employee_name || `emp#${u.employee_id}`}</span>
                                                : <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/40">no vinculado</span>}
                                            </td>
                                            <td className="px-3 py-2">
                                              {u.pending > 0
                                                ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300 font-semibold">{u.pending}</span>
                                                : <span className="text-slate-300 dark:text-white/20">0</span>}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                              {!u.linked && (
                                                <button onClick={() => setLinkUser({ deviceId: d.id, deviceName: d.name, userId: String(u.userId), name: u.name || null, pending: u.pending || 0 })}
                                                  className="px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-[11px] whitespace-nowrap">
                                                  Vincular a empleado
                                                </button>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                                )
                              })()}
                              {!deviceLoading[d.id] && !data.users && (
                                <button onClick={() => loadUsers(d)} className="flex items-center gap-2 text-sm text-blue-600 hover:underline">
                                  <Users size={14}/> Cargar usuarios del reloj
                                </button>
                              )}
                            </div>
                          )}

                          {/* TAB: DESCARGAR */}
                          {tab === 'funciones' && (
                            <div className="space-y-4">
                              {/* Acción principal */}
                              <div className="border-2 border-blue-200 bg-blue-50 rounded-xl p-4 space-y-3">
                                <div>
                                  <p className="font-semibold text-blue-900 text-sm">Descargar marcaciones del reloj</p>
                                  <p className="text-xs text-blue-700 mt-0.5">
                                    Lee todas las marcaciones del reloj y las guarda en att2000 y MySQL local.
                                    Luego podés sincronizar desde la pestaña "Sincronización BD".
                                  </p>
                                </div>
                                <button onClick={() => doBackup(d, true)} disabled={!!busy}
                                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">
                                  <Database size={16} className={busy === 'backup' ? 'animate-bounce' : ''}/>
                                  {busy === 'backup' ? 'Descargando marcaciones...' : '⬇️  Descargar → att2000 + MySQL local'}
                                </button>
                                <button onClick={() => doBackup(d, false)} disabled={!!busy}
                                  className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-blue-200 text-blue-700 rounded-xl text-xs hover:bg-blue-100 disabled:opacity-50">
                                  <Download size={13}/> Solo MySQL local (sin att2000)
                                </button>
                              </div>

                              {/* Acciones secundarias (comandos al reloj real) — sólo super_admin. */}
                              {canManageDevices && (
                                <div className="grid grid-cols-3 gap-2">
                                  <button onClick={() => doClear(d)} disabled={!!busy}
                                    className="flex flex-col items-center gap-1 p-3 border border-red-200 text-red-600 rounded-xl hover:bg-red-50 disabled:opacity-50 text-xs">
                                    <Eraser size={16}/>
                                    {busy === 'clear' ? 'Limpiando...' : 'Limpiar reloj'}
                                  </button>
                                  <button onClick={() => doEnable(d)} disabled={!!busy}
                                    className="flex flex-col items-center gap-1 p-3 border border-green-200 text-green-700 rounded-xl hover:bg-green-50 disabled:opacity-50 text-xs">
                                    <Power size={16}/>
                                    {busy === 'enable' ? 'Habilitando...' : 'Habilitar'}
                                  </button>
                                  <button onClick={() => doDisable(d)} disabled={!!busy}
                                    className="flex flex-col items-center gap-1 p-3 border border-amber-200 text-amber-700 rounded-xl hover:bg-amber-50 disabled:opacity-50 text-xs">
                                    <PowerOff size={16}/>
                                    {busy === 'disable' ? 'Deshabilitando...' : 'Deshabilitar'}
                                  </button>
                                </div>
                              )}

                              {log.length > 0 && (
                                <div className="bg-slate-900 rounded-xl p-3 font-mono text-xs text-green-400 space-y-0.5 max-h-40 overflow-y-auto">
                                  {log.map((line, i) => <div key={i}>{line}</div>)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-600 space-y-1.5 dark:bg-white/[0.03] dark:text-white/60 dark:border-white/[0.08]">
        <p className="font-semibold text-slate-700 dark:text-white/80">Flujo de trabajo</p>
        <p>① <strong>Conectar al reloj</strong> — establece conexión directa vía protocolo ZKTeco</p>
        <p>② <strong>Descargar → att2000 + MySQL local</strong> — baja las marcaciones al servidor</p>
        <p>③ <strong>Sincronización BD</strong> (otra pestaña) — procesa att2000 y genera reportes</p>
        <p className="text-xs text-slate-400 pt-1 dark:text-white/30">⚠️ Cerrá el software Attendance Management (Windows) antes de conectar.</p>
      </div>
    </div>
  )
}

// ─── Tab: Webhooks ────────────────────────────────────────────
function WebhooksTab() {
  const qc = useQueryClient()
  const { data: webhooks = [] } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get('/api/webhooks').then(r => r.data)
  })
  const [showForm, setShowForm] = useState(false)
  const [broadcastMsg, setBroadcastMsg] = useState('')
  const [form, setForm] = useState<any>({
    name: '', url: '', secret: '', format: 'json', channel: '',
    events: ['attendance.checkin','attendance.checkout','alert.late','custom.message'],
  })

  async function createWebhook() {
    await api.post('/api/webhooks', form)
    qc.invalidateQueries({ queryKey: ['webhooks'] })
    setShowForm(false)
    setForm({ name: '', url: '', secret: '', format: 'json', channel: '',
      events: ['attendance.checkin','attendance.checkout','alert.late','custom.message'] })
  }
  async function deleteWebhook(id: number) {
    if (!confirm('¿Eliminar este webhook?')) return
    await api.delete(`/api/webhooks/${id}`)
    qc.invalidateQueries({ queryKey: ['webhooks'] })
  }
  async function broadcast() {
    if (!broadcastMsg.trim()) return
    await api.post('/api/webhooks/broadcast', { title: 'Mensaje SisHoras', message: broadcastMsg })
    setBroadcastMsg('')
    alert('Mensaje enviado a todos los webhooks que escuchan custom.message ✅')
  }

  const FORMAT_HINTS: Record<string, { hint: string; channelLabel: string }> = {
    json:     { hint: 'JSON estándar con event/data',                                    channelLabel: '' },
    slack:    { hint: 'Slack Incoming Webhook — payload {text, blocks}',                 channelLabel: '' },
    discord:  { hint: 'Discord Webhook — payload {content}',                             channelLabel: '' },
    telegram: { hint: 'Bot API: URL https://api.telegram.org/bot<TOKEN>/sendMessage',     channelLabel: 'Chat ID destino' },
    whatsapp: { hint: 'CallMeBot / similar. URL es el endpoint de envío',                 channelLabel: 'Número de teléfono' },
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white/90">Webhooks y notificaciones externas</h2>
          <p className="text-sm text-slate-500 mt-0.5 dark:text-white/40">Envía eventos a Slack, Telegram, WhatsApp, Discord o cualquier endpoint JSON</p>
        </div>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-blue-700">
          <Plus size={16}/> Agregar
        </button>
      </div>

      {/* Broadcast custom */}
      <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-2">
        <h3 className="font-medium text-slate-700 text-sm dark:text-white/80">Enviar mensaje a todos los webhooks</h3>
        <div className="flex gap-2">
          <input value={broadcastMsg} onChange={e => setBroadcastMsg(e.target.value)}
            placeholder="Escribe un mensaje para Slack/Telegram/WhatsApp..."
            className="flex-1 border border-amber-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04]" />
          <button onClick={broadcast} disabled={!broadcastMsg.trim()}
            className="bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium">
            Difundir
          </button>
        </div>
      </div>

      {showForm && (
        <div className="border border-blue-100 bg-blue-50 rounded-xl p-5 space-y-3">
          <h3 className="font-medium text-slate-700 dark:text-white/80">Nuevo Webhook</h3>
          <input placeholder="Nombre (ej: Slack #recursos-humanos)" value={form.name}
            onChange={e => setForm((f: any) => ({...f, name: e.target.value}))}
            className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm dark:border-white/[0.08]" />
          <div className="grid grid-cols-2 gap-2">
            <select value={form.format} onChange={e => setForm((f: any) => ({...f, format: e.target.value}))}
              className="border border-slate-200 rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
              <option value="json">JSON estándar</option>
              <option value="slack">Slack</option>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="discord">Discord</option>
            </select>
            {FORMAT_HINTS[form.format]?.channelLabel && (
              <input placeholder={FORMAT_HINTS[form.format].channelLabel} value={form.channel}
                onChange={e => setForm((f: any) => ({...f, channel: e.target.value}))}
                className="border border-slate-200 rounded-xl px-4 py-2.5 text-sm dark:border-white/[0.08]" />
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-white/40">{FORMAT_HINTS[form.format]?.hint}</p>
          <input placeholder="URL del endpoint" value={form.url}
            onChange={e => setForm((f: any) => ({...f, url: e.target.value}))}
            className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm dark:border-white/[0.08]" />
          {form.format === 'json' && (
            <input placeholder="Secreto HMAC (opcional)" value={form.secret}
              onChange={e => setForm((f: any) => ({...f, secret: e.target.value}))}
              className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm dark:border-white/[0.08]" />
          )}
          <div className="flex gap-3">
            <button onClick={createWebhook} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-blue-700">Guardar</button>
            <button onClick={() => setShowForm(false)} className="border border-slate-200 px-4 py-2 rounded-xl text-sm hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {(webhooks as Webhook[]).length === 0 && <p className="text-center py-8 text-slate-400 text-sm dark:text-white/30">No hay webhooks registrados.</p>}
        {(webhooks as Webhook[]).map(wh => (
          <div key={wh.id} className="flex items-center gap-4 p-4 rounded-xl border border-slate-100 dark:border-white/[0.06]">
            <Globe size={20} className="text-blue-500 flex-shrink-0"/>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-800 dark:text-white/90">{wh.name}</p>
              <p className="text-sm text-slate-500 truncate dark:text-white/40">{wh.url}</p>
            </div>
            <div className="flex items-center gap-2">
              {wh.last_status === 200 ? <CheckCircle size={16} className="text-green-500"/> :
               wh.last_status > 0 ? <XCircle size={16} className="text-red-500"/> :
               <AlertCircle size={16} className="text-slate-400 dark:text-white/30"/>}
              <button onClick={() => deleteWebhook(wh.id)} className="text-red-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50">
                <Trash2 size={14}/>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Tab: API ─────────────────────────────────────────────────
function ApiTab() {
  const baseUrl = (() => {
    const raw = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '').replace(/\/api$/i, '')
    if (raw) {
      if (typeof window !== 'undefined' && window.location.protocol === 'https:' && raw.startsWith('http://')) {
        return 'https://' + raw.slice('http://'.length)
      }
      return raw
    }
    return typeof window !== 'undefined' ? window.location.origin : ''
  })()
  const endpoints = [
    { method: 'GET',  path: '/api/integration/attendance/today', desc: 'Asistencia del día actual' },
    { method: 'GET',  path: '/api/integration/attendance/range', desc: 'Rango de fechas (para nómina)' },
    { method: 'GET',  path: '/api/integration/employees',        desc: 'Lista de empleados activos' },
    { method: 'GET',  path: '/api/integration/stats/summary',    desc: 'KPIs del día' },
    { method: 'POST', path: '/api/integration/checkin',          desc: 'Registrar marcaje externo' },
  ]
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white/90">API & Documentación</h2>
        <p className="text-sm text-slate-500 mt-0.5 dark:text-white/40">Integra con Oracle APEX, ERP, nómina y cualquier sistema</p>
      </div>
      <a href={`${baseUrl}/api/docs`} target="_blank"
        className="flex items-center gap-4 p-4 rounded-xl border border-blue-100 bg-blue-50 hover:bg-blue-100 transition-colors">
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-sm">API</div>
        <div>
          <p className="font-semibold text-blue-800">Swagger UI — Documentación Interactiva</p>
          <p className="text-sm text-blue-600">{baseUrl}/api/docs</p>
        </div>
      </a>
      <div className="space-y-2">
        {endpoints.map(e => (
          <div key={e.path} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100 font-mono text-sm dark:bg-white/[0.03] dark:border-white/[0.06]">
            <span className={`px-2 py-0.5 rounded font-bold text-xs ${e.method === 'GET' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{e.method}</span>
            <span className="text-slate-700 flex-1 dark:text-white/80">{e.path}</span>
            <span className="text-slate-400 text-xs font-sans dark:text-white/30">{e.desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const PUSH_STATUS_LABEL: Record<string, string> = {
  online:     '✅ PUSH ADMS activo',
  stale:      '⚠ PUSH ADMS sin actividad reciente',
  never_seen: '⚠ El reloj nunca envió datos por PUSH',
  unavailable:'⚠ No se pudo verificar',
}

export default function ConfiguracionPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400 dark:text-white/30">Cargando...</div>}>
      <ConfiguracionPageInner />
    </Suspense>
  )
}
