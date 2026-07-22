'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, Database, Cpu, Send, MapPinOff, Activity, Star, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'

interface Diag {
  local?: { total?: number; last_mark?: string | null }
  att2000?: { ok: boolean; total?: number; last_mark?: string | null; error?: string }
  per_day?: { date: string; att2000: number; local: number; diff: number; by_source: Record<string, number> }[]
  devices?: { id: number; name: string; ip_address: string | null; status: string; last_sync: string | null; last_mark: string | null; valid: boolean }[]
  unmapped_userids?: string[]; unmapped_count?: number
  auto_poll?: { zkteco_auto_poll?: boolean; att2000_pull_cron?: boolean }
}

interface UnmappedRow {
  device_id: number; device_name: string | null; device_user_id: string
  user_sn: number | null; marcas: number; first_py: string; last_py: string
  candidate: { id: number; via: string; status: string } | null
}

export default function SincronizacionPage() {
  const user = useCurrentUser()
  const canManage = hasRole(user, 'admin', 'super_admin')
  const [diag, setDiag] = useState<Diag | null>(null)
  const [loadingDiag, setLoadingDiag] = useState(false)
  const [busy, setBusy] = useState('')
  const [log, setLog] = useState<string[]>([])
  const now = new Date()
  const [from, setFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  // Rango para la lectura directa de relojes (default: últimos 3 días — el hueco).
  const [readFrom, setReadFrom] = useState(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10))
  const [readTo, setReadTo] = useState(new Date().toISOString().slice(0, 10))
  // Marcaciones sin empleado (staging raw_device_punches).
  const [unmapped, setUnmapped] = useState<UnmappedRow[] | null>(null)
  const [unmappedTotals, setUnmappedTotals] = useState<{ marks: number; today: number } | null>(null)
  const [loadingUnmapped, setLoadingUnmapped] = useState(false)
  const [linkTarget, setLinkTarget] = useState<UnmappedRow | null>(null)
  const unmappedRef = useRef<HTMLDivElement | null>(null)

  const addLog = (s: string) => setLog(l => [`${new Date().toLocaleTimeString('es-PY')} · ${s}`, ...l].slice(0, 60))

  const loadDiag = useCallback(async () => {
    setLoadingDiag(true)
    try { const r = await api.get('/api/sync/diagnostics', { params: { days: 15 } }); setDiag(r.data) }
    catch (e: any) { addLog(`✖ Diagnóstico: ${e?.response?.data?.error || e.message}`) }
    finally { setLoadingDiag(false) }
  }, [])
  useEffect(() => { loadDiag() }, [loadDiag])

  // B) Relojes → SisHoras (flujo principal)
  async function readAllDevices() {
    setBusy('devices'); addLog(`▶ Leyendo relojes válidos → SisHoras (${readFrom} … ${readTo})...`)
    try {
      const r = await api.post('/api/devices/backup-all', { from: readFrom, to: readTo, attempts: 2 }, { timeout: 120000 })
      if (r.data.ok === false) { addLog(`✖ ${r.data.error || 'Error en la lectura'}`) }
      const t = r.data.totals || {}
      addLog(`✅ Relojes: ${r.data.devices ?? 0}. En rango ${t.in_range || 0}, importados ${t.imported || 0}, duplicados ${t.skipped || 0}, sin empleado ${t.notFound || 0}, basura ${t.junk || 0}.`)
      if ((t.in_range || 0) > 0 && (t.notFound || 0) / (t.in_range || 1) > 0.5) {
        addLog('🚨 La mayoría de las marcas en rango NO se importó por falta de mapeo deviceUserId→empleado.')
      }
      for (const d of r.data.results || []) {
        if (!d.ok) { addLog(`   · ${d.device}: ✖ ${d.error}`); continue }
        addLog(`   · ${d.device}: leídos ${d.total_read} · basura ${d.junk ?? 0} · en rango ${d.in_range} · +${d.imported} (dup ${d.skipped}, sinEmp ${d.notFound})`)
        if (d.read_unstable) addLog(`      ⚠️ lectura inestable del reloj; puede faltar data. Reintentá o usá el script con --attempts 3.`)
        if (d.warn_unmapped) addLog(`      🚨 ${d.notFound}/${d.in_range} marcas sin empleado. deviceUserId no coincide con employees (${(d.match_columns || []).join(', ')}).`)
      }
      loadDiag()
    } catch (e: any) {
      // 504 de Nginx o timeout del cliente: el request web es demasiado largo.
      if (e?.code === 'ECONNABORTED' || e?.response?.status === 504) {
        addLog('✖ La lectura tardó demasiado para el navegador/Nginx (504/timeout).')
        addLog('   → Probá un rango más chico, o corré en el servidor:')
        addLog('     cd api && node scripts/read-zkteco-now.js --from ' + readFrom + ' --to ' + readTo)
      } else {
        addLog(`✖ ${e?.response?.data?.error || e.message}`)
      }
    } finally { setBusy('') }
  }

  // A) att2000 → SisHoras (histórico por rango)
  async function importAtt2000() {
    setBusy('att2000'); addLog(`▶ Importando att2000 → SisHoras (${from} … ${to})...`)
    try {
      const r = await api.post('/api/sync/attendance', { dateFrom: `${from} 00:00:00`, dateTo: `${to} 23:59:59`, limit: 200000 })
      addLog(`✅ att2000: importados ${r.data.imported}, duplicados ${r.data.skipped}, sin empleado ${r.data.notFound} (de ${r.data.total}).`)
      loadDiag()
    } catch (e: any) { addLog(`✖ ${e?.response?.data?.error || e.message}`) }
    finally { setBusy('') }
  }

  async function cleanupInvalid() {
    if (!confirm('¿Eliminar los relojes sin IP que nunca sincronizaron y no tienen marcajes?')) return
    setBusy('cleanup')
    try {
      const r = await api.post('/api/devices/cleanup-invalid')
      addLog(`🧹 ${r.data.message}`); loadDiag()
    } catch (e: any) { addLog(`✖ ${e?.response?.data?.error || e.message}`) }
    finally { setBusy('') }
  }

  // Marcaciones sin empleado (staging). Sin rango = TODAS las pendientes.
  const loadUnmapped = useCallback(async () => {
    setLoadingUnmapped(true)
    try {
      const r = await api.get('/api/devices/unmapped')   // status=unmapped, todas las pendientes
      setUnmapped(r.data.items || [])
      setUnmappedTotals(r.data.totals || null)
    } catch (e: any) { addLog(`✖ Sin empleado: ${e?.response?.data?.error || e.message}`) }
    finally { setLoadingUnmapped(false) }
  }, [])

  // Deep-link desde el dashboard (?unmapped=1): cargar y desplazarse solo.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('unmapped') === '1') {
      loadUnmapped()
      setTimeout(() => unmappedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400)
    }
  }, [loadUnmapped])

  async function linkEmployee(row: UnmappedRow, employeeId: number) {
    if (!employeeId) return
    setBusy('map')
    try {
      const r = await api.post('/api/devices/map', { employee_id: employeeId, device_user_id: row.device_user_id, device_id: row.device_id })
      if (r.data.ok) {
        addLog(`🔗 ${row.device_user_id} → empleado vinculado: importadas ${r.data.mapped || 0}, duplicadas ${r.data.duplicate || 0}.`)
        setLinkTarget(null)
      } else addLog(`✖ ${r.data.error}`)
      await loadUnmapped(); loadDiag()
    } catch (e: any) { addLog(`✖ ${e?.response?.data?.error || e.message}`) }
    finally { setBusy('') }
  }

  async function reprocessUnmapped() {
    setBusy('reprocess')
    try {
      const r = await api.post('/api/devices/reprocess-unmapped', { from: readFrom, to: readTo })
      if (r.data.ok) addLog(`♻ Reproceso: mapeadas ${r.data.mapped || 0}, sin empleado ${r.data.still_unmapped || 0}, duplicadas ${r.data.duplicate || 0}, errores ${r.data.errors || 0}.`)
      else addLog(`✖ ${r.data.error}`)
      await loadUnmapped(); loadDiag()
    } catch (e: any) { addLog(`✖ ${e?.response?.data?.error || e.message}`) }
    finally { setBusy('') }
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <Link href="/configuracion" className="text-slate-500 hover:text-slate-700 flex items-center gap-1 text-sm dark:text-white/40 w-fit">
        <ArrowLeft size={16} /> Volver a configuración
      </Link>

      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(56,189,248,0.5)]">
          <RefreshCw size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Sincronización de marcaciones</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Tres flujos separados. La <b>fuente principal recomendada</b> es leer los relojes directamente.</p>
        </div>
      </div>

      {/* Diagnóstico */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2"><Activity size={17} className="text-sky-500" /><h2 className="font-bold text-slate-900 dark:text-white">Diagnóstico del flujo</h2></div>
          <button onClick={loadDiag} disabled={loadingDiag} className="px-3 py-1.5 rounded-xl border border-slate-200 hover:border-sky-300 text-sm text-slate-600 dark:border-white/[0.08] dark:text-white/70 disabled:opacity-50">{loadingDiag ? 'Cargando...' : 'Actualizar'}</button>
        </div>
        {diag ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <Stat label="att2000 (origen)" value={diag.att2000?.ok ? `${diag.att2000.total ?? 0}` : 'sin conexión'} sub={diag.att2000?.last_mark ? `última: ${diag.att2000.last_mark}` : diag.att2000?.error} warn={!diag.att2000?.ok} />
              <Stat label="attendance_logs (destino)" value={`${diag.local?.total ?? 0}`} sub={diag.local?.last_mark ? `última: ${diag.local.last_mark}` : '—'} good />
              <Stat label="att2000: USERID sin empleado" value={`${diag.unmapped_count ?? 0}`} sub={diag.unmapped_count ? `ej: ${(diag.unmapped_userids || []).slice(0, 6).join(', ')}` : 'todos mapeados'} warn={!!diag.unmapped_count} />
              <button onClick={() => { loadUnmapped(); setTimeout(() => unmappedRef.current?.scrollIntoView({ behavior: 'smooth' }), 300) }} className="text-left">
                <Stat label="ZKTeco: pendientes de vinculación" value={`${(unmapped || []).length || '—'}`} sub="clic para ver y vincular" warn={(unmapped || []).length > 0} />
              </button>
            </div>
            {diag.per_day && diag.per_day.length > 0 && (
              <div className="overflow-x-auto max-h-56 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/[0.06]">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06] sticky top-0">
                    <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                      <th className="px-3 py-2">Día</th><th className="px-3 py-2 text-right">att2000</th><th className="px-3 py-2 text-right">local</th>
                      <th className="px-3 py-2 text-right">dif.</th><th className="px-3 py-2">por origen (local)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                    {diag.per_day.map(d => (
                      <tr key={d.date} className="text-slate-700 dark:text-white/70">
                        <td className="px-3 py-2 tabular-nums">{d.date}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{d.att2000}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{d.local}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${d.diff > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>{d.diff > 0 ? `+${d.diff}` : d.diff}</td>
                        <td className="px-3 py-2 text-[11px] text-slate-400">{Object.entries(d.by_source).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* Relojes inválidos */}
            {diag.devices?.some(d => !d.valid) && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 dark:bg-amber-400/[0.06] dark:border-amber-400/30">
                <span className="text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2"><MapPinOff size={15} /> Hay relojes sin IP (no operativos): {diag.devices.filter(d => !d.valid).map(d => `#${d.id} ${d.name}`).join(', ')}</span>
                {canManage && <button onClick={cleanupInvalid} disabled={busy === 'cleanup'} className="text-xs px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">Limpiar inválidos</button>}
              </div>
            )}
          </>
        ) : <p className="text-slate-400 text-sm py-4 text-center dark:text-white/30">{loadingDiag ? 'Cargando...' : 'Sin datos de diagnóstico.'}</p>}
      </section>

      {/* B) Relojes → SisHoras (principal) */}
      <FlowCard color="emerald" icon={<Cpu size={18} />} title="B) Leer relojes → SisHoras" principal
        desc="Fuente: relojes ZKTeco. Destino: attendance_logs. Flujo recomendado para el día a día — no depende de att2000. Filtra por rango: el reloj guarda todo su histórico, acá sólo importás lo que pedís.">
        {canManage && (
          <div className="flex flex-wrap items-end gap-3">
            <div><label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Desde</label><input type="date" value={readFrom} onChange={e => setReadFrom(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" /></div>
            <div><label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Hasta</label><input type="date" value={readTo} onChange={e => setReadTo(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" /></div>
            <button onClick={readAllDevices} disabled={busy === 'devices'} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm flex items-center gap-2 disabled:opacity-50">
              <Cpu size={15} /> {busy === 'devices' ? 'Leyendo relojes...' : 'Leer relojes del rango'}
            </button>
          </div>
        )}
        <p className="text-[11px] text-slate-400 dark:text-white/30 mt-2">Para lecturas grandes o si el navegador da timeout (504), usá el script <code>read-zkteco-now.js</code> en el servidor.</p>
      </FlowCard>

      {/* Marcaciones sin empleado (staging) */}
      <section ref={unmappedRef} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06] scroll-mt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <MapPinOff size={18} className="text-amber-500" />
            <h3 className="font-semibold text-slate-700 dark:text-white/80">Marcaciones sin empleado</h3>
            {unmappedTotals && (
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${unmappedTotals.marks > 0 ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'}`}>
                {unmappedTotals.marks} pendientes acumuladas · {unmappedTotals.today} recibidas hoy
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadUnmapped} disabled={loadingUnmapped} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/[0.08] text-sm flex items-center gap-1.5 disabled:opacity-50">
              <RefreshCw size={14} className={loadingUnmapped ? 'animate-spin' : ''} /> {loadingUnmapped ? 'Cargando...' : 'Cargar'}
            </button>
            {canManage && <button onClick={reprocessUnmapped} disabled={busy === 'reprocess'} className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm disabled:opacity-50">{busy === 'reprocess' ? 'Reprocesando...' : 'Reprocesar rango'}</button>}
          </div>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-white/30 mt-1">
          Las marcas crudas del reloj que aún no se vinculan a un empleado quedan acá (no se pierden). Vinculá el usuario del reloj a un empleado y reprocesá para que pasen a asistencia.
        </p>
        {unmapped && unmapped.length === 0 && <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-3">✅ No hay marcaciones sin empleado pendientes.</p>}
        {unmapped && unmapped.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-400 dark:text-white/40 border-b border-slate-100 dark:border-white/[0.06]">
                <th className="py-2 pr-3">deviceUserId</th><th className="pr-3">userSn</th><th className="pr-3">Marcas</th><th className="pr-3">Primera → Última</th><th className="pr-3">Reloj</th><th className="pr-3">Candidato</th><th>Vincular</th>
              </tr></thead>
              <tbody>
                {unmapped.map((r, i) => (
                  <tr key={i} className="border-b border-slate-50 dark:border-white/[0.04]">
                    <td className="py-2 pr-3 font-mono">{r.device_user_id}</td>
                    <td className="pr-3 text-slate-400">{r.user_sn ?? '—'}</td>
                    <td className="pr-3">{r.marcas}</td>
                    <td className="pr-3 text-xs text-slate-500 dark:text-white/40">{String(r.first_py).slice(0, 16)} → {String(r.last_py).slice(0, 16)}</td>
                    <td className="pr-3">{r.device_name || r.device_id}</td>
                    <td className="pr-3">{r.candidate ? <span className="text-xs">emp#{r.candidate.id} <span className="text-slate-400">({r.candidate.via}, {r.candidate.status})</span></span> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td>{canManage && (
                      <button onClick={() => setLinkTarget(r)} disabled={busy === 'map'}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-xs disabled:opacity-50 flex items-center gap-1 whitespace-nowrap">
                        <Search size={12} /> Vincular a empleado
                      </button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Modal de vinculación (centrado — no se solapa con la tabla) */}
      {linkTarget && (
        <VincularModal row={linkTarget} busy={busy === 'map'}
          onClose={() => setLinkTarget(null)}
          onConfirm={(empId) => linkEmployee(linkTarget, empId)} />
      )}

      {/* A) att2000 → SisHoras (histórico) */}
      <FlowCard color="sky" icon={<Database size={18} />} title="A) Importar histórico att2000 → SisHoras"
        desc="Fuente: att2000.CHECKINOUT. Destino: attendance_logs. Para reconstruir el histórico. La migración completa se corre con el script migrate-att2000-history.js.">
        <div className="flex flex-wrap items-end gap-3">
          <div><label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Desde</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" /></div>
          <div><label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Hasta</label><input type="date" value={to} onChange={e => setTo(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" /></div>
          {canManage && <button onClick={importAtt2000} disabled={busy === 'att2000'} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm flex items-center gap-2 disabled:opacity-50"><Database size={15} /> {busy === 'att2000' ? 'Importando...' : 'Importar rango'}</button>}
        </div>
      </FlowCard>

      {/* C) SisHoras → att2000 (legacy) */}
      <details className="bg-white rounded-2xl shadow-sm border border-slate-100 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-slate-500 dark:text-white/50 flex items-center gap-2">
          <Send size={15} /> C) Enviar marcajes a att2000 (compatibilidad legacy)
        </summary>
        <div className="px-5 pb-5 text-sm text-slate-500 dark:text-white/40">
          Flujo inverso, sólo para mantener att2000 actualizado por compatibilidad. <b>No es el flujo principal.</b> Se dispara desde cada reloj con la opción “enviar a att2000” (parámetro <code>push_att2000</code>) en la pantalla de relojes.
        </div>
      </details>

      {/* Log */}
      {log.length > 0 && (
        <section className="bg-slate-900 text-slate-100 rounded-2xl p-4 text-xs font-mono max-h-64 overflow-y-auto">
          {log.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
        </section>
      )}
    </div>
  )
}

// Modal de vinculación centrado: buscar empleado → tarjeta de confirmación →
// confirmar. Evita el popover solapado dentro de la tabla. "Crear empleado y
// vincular" lleva a /empleados/nuevo conservando device_id/device_user_id para
// que al crear vuelva y vincule automáticamente.
function VincularModal({ row, busy, onClose, onConfirm }: {
  row: UnmappedRow; busy: boolean; onClose: () => void; onConfirm: (employeeId: number) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<any | null>(null)

  useEffect(() => {
    if (selected || q.trim().length < 2) { setResults([]); return }
    let alive = true
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/api/employees', { params: { search: q.trim(), status: 'all', limit: 10 } })
        if (alive) setResults(r.data?.data || [])
      } catch { if (alive) setResults([]) }
      finally { if (alive) setSearching(false) }
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [q, selected])

  const crearHref = `/empleados/nuevo?device_id=${row.device_id ?? ''}&device_user_id=${encodeURIComponent(row.device_user_id)}&return_to=vinculacion`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/[0.1] shadow-2xl p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white">Vincular usuario del reloj</h3>
            <p className="text-xs text-slate-500 dark:text-white/40 mt-0.5">
              <span className="font-mono font-semibold">{row.device_user_id}</span> · {row.device_name || `reloj #${row.device_id}`} · {row.marcas} marca(s) pendiente(s) · {String(row.first_py).slice(0, 16)} → {String(row.last_py).slice(0, 16)}
            </p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 text-lg leading-none disabled:opacity-50">✕</button>
        </div>

        {!selected ? (
          <>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nombre, código, legajo o documento…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
            <div className="mt-2 max-h-64 overflow-y-auto space-y-0.5">
              {searching && <p className="text-xs text-slate-400 px-1 py-2">Buscando…</p>}
              {!searching && q.trim().length >= 2 && results.length === 0 && (
                <div className="px-1 py-3 text-xs text-slate-500 dark:text-white/40">
                  No se encontró ningún empleado con “{q.trim()}”.
                </div>
              )}
              {results.map(e => (
                <button key={e.id} onClick={() => setSelected(e)} disabled={busy}
                  className="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-white/[0.05] disabled:opacity-50">
                  <div className="text-sm font-semibold text-slate-700 dark:text-white/80">
                    {e.full_name} {e.status !== 'active' && <span className="text-[10px] text-amber-500 font-normal">({e.status})</span>}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    código {e.code || '—'} · legajo {e.employee_number || '—'} · C.I. {e.document_number || '—'}{e.department ? ` · ${e.department}` : ''}
                  </div>
                </button>
              ))}
            </div>
            {row.candidate && row.candidate.status === 'active' && (
              <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                Sugerencia automática por coincidencia de código: empleado con {row.candidate.via} = {row.device_user_id}. Buscalo arriba para confirmar con sus datos.
              </p>
            )}
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
              <span className="text-[11px] text-slate-400 dark:text-white/30">¿El empleado no existe todavía?</span>
              <a href={crearHref} className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs">
                Crear empleado y vincular
              </a>
            </div>
          </>
        ) : (
          <>
            {/* Tarjeta de confirmación antes de vincular */}
            <div className="rounded-xl border border-slate-200 dark:border-white/[0.08] divide-y divide-slate-100 dark:divide-white/[0.06] text-sm">
              <ConfirmRow k="Usuario del reloj" v={row.device_user_id} mono />
              <ConfirmRow k="Reloj" v={row.device_name || `#${row.device_id}`} />
              <ConfirmRow k="Empleado" v={`${selected.full_name}${selected.status !== 'active' ? ` (${selected.status})` : ''}`} />
              <ConfirmRow k="Código" v={selected.code || '—'} />
              <ConfirmRow k="Legajo" v={selected.employee_number || '—'} />
              <ConfirmRow k="Documento" v={selected.document_number || '—'} />
              <ConfirmRow k="Marcas pendientes" v={String(row.marcas)} />
              <ConfirmRow k="Período" v={`${String(row.first_py).slice(0, 16)} → ${String(row.last_py).slice(0, 16)}`} />
            </div>
            <p className="text-[11px] text-slate-400 dark:text-white/30 mt-2">
              Al confirmar se crea el vínculo, se importan sus marcas pendientes y se recalcula la asistencia de las fechas afectadas.
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button onClick={() => setSelected(null)} disabled={busy} className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/[0.08] text-sm disabled:opacity-50">Volver</button>
              <button onClick={() => onConfirm(selected.id)} disabled={busy} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
                {busy ? 'Vinculando…' : 'Confirmar vínculo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ConfirmRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-xs text-slate-400 dark:text-white/30">{k}</span>
      <span className={`text-slate-700 dark:text-white/80 ${mono ? 'font-mono font-semibold' : ''}`}>{v}</span>
    </div>
  )
}

function Stat({ label, value, sub, good, warn }: { label: string; value: string; sub?: string | null; good?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2.5 border ${warn ? 'bg-amber-50 border-amber-200 dark:bg-amber-400/[0.06] dark:border-amber-400/30' : good ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-400/[0.06] dark:border-emerald-400/30' : 'bg-slate-50 border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]'}`}>
      <div className="text-[11px] text-slate-500 dark:text-white/40">{label}</div>
      <div className="text-lg font-bold tabular-nums text-slate-800 dark:text-white/90">{value}</div>
      {sub && <div className="text-[11px] text-slate-400 dark:text-white/30 truncate" title={sub}>{sub}</div>}
    </div>
  )
}

function FlowCard({ color, icon, title, desc, principal, children }: { color: 'emerald' | 'sky'; icon: React.ReactNode; title: string; desc: string; principal?: boolean; children: React.ReactNode }) {
  const ring = principal ? 'ring-2 ring-emerald-400/50' : ''
  const iconBg = color === 'emerald' ? 'bg-emerald-500' : 'bg-sky-500'
  return (
    <section className={`bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06] ${ring}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-8 h-8 rounded-xl flex items-center justify-center text-white ${iconBg}`}>{icon}</span>
        <h2 className="font-bold text-slate-900 dark:text-white">{title}</h2>
        {principal && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300 inline-flex items-center gap-1"><Star size={10} /> Principal</span>}
      </div>
      <p className="text-xs text-slate-500 dark:text-white/40 mb-3">{desc}</p>
      {children}
    </section>
  )
}
