'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Server, Database, RefreshCw, Save, Zap, Eye, EyeOff, XCircle, CheckCircle,
  Users, Clock, Wifi, AlertCircle, Download, ArrowLeft, ShieldAlert, History,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, isSuperAdmin } from '@/lib/useCurrentUser'
import { TARGET_KEY, sanitizeTarget, parseTarget } from '@/lib/att2000Target'

/**
 * /sistema/legado-att2000 — Ubicación CANÓNICA de la integración legada att2000.
 * Contingencia, migración y recuperación histórica. NO es el flujo normal de
 * marcaciones. Visible sólo para super_admin.
 *
 * Seguridad: las credenciales NUNCA se persisten en localStorage. Sólo se guarda
 * el destino de conexión (host/puerto/base/etiqueta); usuario y contraseña viven
 * en el backend (variables de entorno) y se ingresan al vuelo si hace falta.
 */
interface DbConn { host: string; port: string; database: string; user: string; password: string; label: string }
interface ConnResult {
  ok: boolean; totalRecords?: number; totalEmployees?: number
  machines?: { MACHINE_ALIAS: string; IP_ADDRESS: string }[]
  recentRecords?: { USERID: number; nombre: string; CHECKTIME: string; CHECKTYPE: string }[]
  error?: string
}

// Sólo destino de conexión (SIN credenciales). Las credenciales quedan en el backend.
const emptyConn = (): DbConn => ({ host: '', port: '1433', database: 'att2000', user: '', password: '', label: '' })
function loadConn(): DbConn {
  const base = emptyConn()
  if (typeof window === 'undefined') return base
  try {
    const s = localStorage.getItem(TARGET_KEY)
    if (s) return { ...base, ...parseTarget(JSON.parse(s)) }  // nunca user/password desde storage
  } catch {}
  return base
}
// Enmascara el host para mostrarlo sin revelarlo por completo.
function maskHost(h: string): string {
  if (!h) return '—'
  const parts = h.split('.')
  if (parts.length === 4) return `${parts[0]}.•••.•••.${parts[3]}`
  return h.length <= 4 ? '•••' : `${h.slice(0, 2)}•••${h.slice(-2)}`
}

const inputCls = 'w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.04]'
const labelCls = 'text-xs font-medium text-slate-600 block mb-1 dark:text-white/50'

export default function LegadoAtt2000Page() {
  const user = useCurrentUser()

  // Gate: sólo super_admin. Un usuario sin permiso ve una página segura (no el contenido).
  if (user && !isSuperAdmin(user)) {
    return (
      <div className="p-6">
        <div className="max-w-lg mx-auto mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center dark:border-amber-500/20 dark:bg-amber-500/[0.06]">
          <ShieldAlert className="mx-auto mb-3 text-amber-500" size={28} />
          <h1 className="font-semibold text-amber-800 dark:text-amber-300">Acceso restringido</h1>
          <p className="text-sm text-amber-700 mt-1 dark:text-amber-300/80">La integración legada att2000 está disponible sólo para super administradores.</p>
          <Link href="/sistema" className="inline-block mt-4 text-sm text-slate-600 hover:underline dark:text-white/60">Volver a Sistema</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <Link href="/sistema" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 dark:text-white/40"><ArrowLeft size={15} /> Sistema</Link>
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-slate-900 flex items-center justify-center dark:bg-white/10"><History className="text-white" size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Integración legada att2000</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Contingencia, migración y recuperación histórica. No es el flujo normal de marcaciones.</p>
        </div>
      </div>
      <Att2000LegacyPanel />
    </div>
  )
}

function Att2000LegacyPanel() {
  const [log, setLog]           = useState<string[]>([])
  const [testing, setTesting]   = useState(false)
  const [syncing, setSyncing]   = useState(false)
  const [pushing, setPushing]   = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [pushPreview, setPushPreview] = useState<{ total: number } | null>(null)
  const [showPass, setShowPass] = useState(false)
  const [saved, setSaved]       = useState(false)
  const [connResult, setConnResult] = useState<ConnResult | null>(null)
  const [lastCheck, setLastCheck] = useState<string | null>(null)

  const today    = new Date().toISOString().split('T')[0]
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]
  const [dateFrom, setDateFrom] = useState(firstDay)
  const [dateTo, setDateTo]     = useState(today)
  const [pushFrom, setPushFrom] = useState(firstDay)
  const [pushTo, setPushTo]     = useState(today)

  const [conn, setConn] = useState<DbConn>(emptyConn)
  useEffect(() => { setConn(loadConn()) }, [])

  const addLog   = (msg: string) => setLog(prev => [new Date().toLocaleTimeString() + ' — ' + msg, ...prev])
  const setField = (k: keyof DbConn) => (e: React.ChangeEvent<HTMLInputElement>) => setConn(c => ({ ...c, [k]: e.target.value }))

  // Guarda SÓLO el destino (host/puerto/base/etiqueta). NUNCA user/password.
  function saveConn() {
    try { localStorage.setItem(TARGET_KEY, JSON.stringify(sanitizeTarget(conn))) } catch {}
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  async function testConnection() {
    setTesting(true); setConnResult(null)
    addLog(`🔌 Probando conexión a ${maskHost(conn.host)}:${conn.port}/${conn.database}...`)
    try {
      const r = await api.post('/api/sync/test-conn', conn)
      setConnResult(r.data)
      setLastCheck(new Date().toLocaleString())
      addLog(r.data.ok
        ? `✅ Conexión exitosa — ${r.data.totalRecords?.toLocaleString()} marcajes, ${r.data.totalEmployees?.toLocaleString()} empleados`
        : `❌ Error: ${r.data.error}`)
    } catch (e: any) {
      const err = e.response?.data?.error || e.message
      setConnResult({ ok: false, error: err }); setLastCheck(new Date().toLocaleString())
      addLog(`❌ Error: ${err}`)
    }
    setTesting(false)
  }

  async function runSync() {
    setSyncing(true)
    addLog(`🔄 Sincronizando ${dateFrom} → ${dateTo} (histórico)...`)
    try {
      const r = await api.post('/api/sync/full', { dateFrom, dateTo, conn })
      const res = r.data.result
      addLog('✅ Sincronización completada:')
      if (res?.departments) addLog(`   📁 Departamentos: ${res.departments.synced} sincronizados`)
      if (res?.employees)   addLog(`   👥 Empleados: ${res.employees.synced} sincronizados (${res.employees.errors ?? 0} errores)`)
      if (res?.attendance)  addLog(`   🕐 Marcajes: ${res.attendance.imported} importados`)
      if (res?.machines)    addLog(`   ⌚ Relojes: ${res.machines.synced} sincronizados`)
    } catch (e: any) {
      addLog(`❌ Error: ${e.response?.data?.error || e.message}`)
    }
    setSyncing(false)
  }

  async function previewPush() {
    setPreviewing(true); setPushPreview(null)
    try {
      const r = await api.get('/api/sync/push-to-att2000/preview', { params: { dateFrom: pushFrom, dateTo: pushTo } })
      setPushPreview(r.data)
      addLog(`🔍 Vista previa: ${r.data.total?.toLocaleString()} registros locales listos para enviar a att2000 (${pushFrom} → ${pushTo})`)
    } catch (e: any) {
      addLog(`❌ Error en vista previa: ${e.response?.data?.error || e.message}`)
    }
    setPreviewing(false)
  }

  async function pushToAtt2000() {
    if (!pushPreview) return
    if (!confirm(`¿Enviar ${pushPreview.total?.toLocaleString()} marcajes a att2000?\nSolo se insertarán registros que no existan todavía (no hay duplicados).`)) return
    setPushing(true)
    addLog(`📤 Enviando marcajes locales → att2000 (${pushFrom} → ${pushTo})...`)
    try {
      const r = await api.post('/api/sync/push-to-att2000', { dateFrom: pushFrom, dateTo: pushTo })
      addLog(`✅ Enviado a att2000: ${r.data.inserted} insertados, ${r.data.skipped} ya existían, ${r.data.errors} errores`)
      if (r.data.errList?.length) addLog(`   ⚠️ Primeros errores: ${r.data.errList.slice(0, 3).map((e: any) => e.error).join('; ')}`)
      setPushPreview(null)
    } catch (e: any) {
      addLog(`❌ Error: ${e.response?.data?.error || e.message}`)
    }
    setPushing(false)
  }

  const statusChip = connResult == null
    ? { txt: 'Sin comprobar', cls: 'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/50' }
    : connResult.ok
      ? { txt: 'Conectado', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' }
      : { txt: 'Desconectado', cls: 'bg-red-100 text-red-700 dark:bg-red-400/10 dark:text-red-300' }

  return (
    <div className="space-y-6">
      {/* Estado de la integración (sin exponer credenciales) */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 p-4 dark:border-white/[0.08]">
        <span className="text-sm font-medium text-slate-700 dark:text-white/80">{conn.label || 'Conexión att2000'}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusChip.cls}`}>{statusChip.txt}</span>
        <span className="text-xs text-slate-400 dark:text-white/30">host {maskHost(conn.host)}</span>
        <span className="text-xs text-slate-400 dark:text-white/30">· última comprobación {lastCheck || '—'}</span>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="border border-slate-200 rounded-2xl p-5 space-y-4 dark:border-white/[0.08]">
            <div className="flex items-center gap-2">
              <Server size={16} className="text-blue-600" />
              <h3 className="font-medium text-slate-800 dark:text-white/90">Configuración de conexión</h3>
            </div>
            <div>
              <label className={labelCls}>Nombre / Etiqueta</label>
              <input value={conn.label} onChange={setField('label')} placeholder="ej: ZKTeco Attendance Management" className={inputCls} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>Host / IP del servidor</label>
                <input value={conn.host} onChange={setField('host')} placeholder="host SQL Server" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Puerto</label>
                <input value={conn.port} onChange={setField('port')} placeholder="1433" className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Base de Datos</label>
              <input value={conn.database} onChange={setField('database')} placeholder="att2000" className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Usuario</label>
                <input value={conn.user} onChange={setField('user')} autoComplete="off" placeholder="sa" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Contraseña</label>
                <div className="relative">
                  <input type={showPass ? 'text' : 'password'} value={conn.password} onChange={setField('password')}
                    autoComplete="new-password" placeholder="••••••••" className={inputCls + ' pr-10'} />
                  <button onClick={() => setShowPass(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-white/30">
                    {showPass ? <EyeOff size={16}/> : <Eye size={16}/>}
                  </button>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 dark:text-white/30">Usuario y contraseña se usan sólo para esta operación y NO se guardan en el navegador.</p>
          </div>

          <div className="border border-slate-200 rounded-2xl p-5 space-y-3 dark:border-white/[0.08]">
            <div className="flex items-center gap-2">
              <Database size={16} className="text-blue-600" />
              <h3 className="font-medium text-slate-800 dark:text-white/90">Período a sincronizar (histórico)</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Desde</label><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls}>Hasta</label><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputCls} /></div>
            </div>
          </div>

          <div className="flex gap-3 flex-wrap">
            <button onClick={saveConn}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${saved ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-slate-800 text-white hover:bg-slate-700'}`}>
              <Save size={16}/>{saved ? '✓ Guardado' : 'Guardar destino'}
            </button>
            <button onClick={testConnection} disabled={testing || !conn.host}
              className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <Zap size={16} className="text-yellow-500"/>{testing ? 'Probando...' : 'Probar conexión'}
            </button>
            <button onClick={runSync} disabled={syncing || !conn.host}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700 disabled:opacity-50">
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''}/>{syncing ? 'Sincronizando...' : 'Sincronizar histórico'}
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {!connResult && (
            <div className="border border-dashed border-slate-200 rounded-2xl p-8 flex flex-col items-center justify-center text-center text-slate-400 h-full min-h-48 dark:text-white/30 dark:border-white/[0.08]">
              <Database size={32} className="mb-3 opacity-30"/>
              <p className="text-sm">Haz clic en <strong className="text-slate-600 dark:text-white/60">Probar conexión</strong> para ver la información de la base de datos</p>
            </div>
          )}
          {connResult && !connResult.ok && (
            <div className="border border-red-200 bg-red-50 rounded-2xl p-5">
              <div className="flex items-start gap-3">
                <XCircle size={20} className="text-red-500 flex-shrink-0 mt-0.5"/>
                <div><p className="font-semibold text-red-700">Error de conexión</p><p className="text-sm text-red-600 mt-1">{connResult.error}</p></div>
              </div>
            </div>
          )}
          {connResult?.ok && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="border border-green-100 bg-green-50 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-1"><CheckCircle size={14} className="text-green-600"/><span className="text-xs text-green-700 font-medium">Marcajes totales</span></div>
                  <p className="text-2xl font-bold text-green-800">{connResult.totalRecords?.toLocaleString()}</p>
                </div>
                <div className="border border-blue-100 bg-blue-50 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-1"><Users size={14} className="text-blue-600"/><span className="text-xs text-blue-700 font-medium">Empleados</span></div>
                  <p className="text-2xl font-bold text-blue-800">{connResult.totalEmployees?.toLocaleString()}</p>
                </div>
              </div>
              {connResult.machines && connResult.machines.length > 0 && (
                <div className="border border-slate-200 rounded-2xl p-4 space-y-2 dark:border-white/[0.08]">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5 dark:text-white/40"><Clock size={12}/> Relojes en la base de datos</p>
                  {connResult.machines.map((m, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <Wifi size={13} className="text-green-500 flex-shrink-0"/>
                      <span className="text-slate-700 font-medium dark:text-white/80">{m.MACHINE_ALIAS}</span>
                      <span className="font-mono text-slate-400 text-xs dark:text-white/30">{m.IP_ADDRESS}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Enviar marcajes locales → att2000 (recuperación) */}
      <div className="border border-slate-200 rounded-2xl overflow-hidden dark:border-white/[0.08]">
        <div className="bg-gradient-to-r from-indigo-50 to-blue-50 px-5 py-3 border-b border-slate-200 flex items-center gap-3 dark:border-white/[0.08]">
          <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center flex-shrink-0"><Database size={16} className="text-indigo-600"/></div>
          <div>
            <p className="font-semibold text-slate-800 text-sm dark:text-white/90">Enviar marcajes locales → att2000 (recuperación)</p>
            <p className="text-xs text-slate-500 dark:text-white/40">Publica en att2000 los registros almacenados en SisHoras (contingencia/recuperación histórica).</p>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5"/>
            <div>Sólo inserta en att2000 los registros que aún no existan (sin duplicados). Es una operación de contingencia, no el flujo normal.</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Desde</label><input type="date" value={pushFrom} onChange={e => { setPushFrom(e.target.value); setPushPreview(null) }} className={inputCls} /></div>
            <div><label className={labelCls}>Hasta</label><input type="date" value={pushTo} onChange={e => { setPushTo(e.target.value); setPushPreview(null) }} className={inputCls} /></div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={previewPush} disabled={previewing || pushing}
              className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <Eye size={15}/> {previewing ? 'Verificando...' : 'Vista previa'}
            </button>
            {pushPreview && (
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600 dark:text-white/60"><strong className="text-slate-900 dark:text-white">{pushPreview.total?.toLocaleString()}</strong> registros listos</span>
                <button onClick={pushToAtt2000} disabled={pushing || pushPreview.total === 0}
                  className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm hover:bg-indigo-700 disabled:opacity-50 font-medium">
                  <Download size={15} className={pushing ? 'animate-bounce' : ''}/>{pushing ? 'Enviando...' : `Enviar ${pushPreview.total?.toLocaleString()} registros → att2000`}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {log.length > 0 && (
        <div className="bg-slate-900 rounded-xl p-4 font-mono text-xs text-green-400 space-y-1 max-h-48 overflow-y-auto">
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}
