'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  RefreshCw, Save, X, ChevronDown, Check, Play, Pause, History, ArrowLeft, ArrowRight,
  CheckCircle2, AlertCircle, Wifi, WifiOff, Clock3, ShieldCheck, PowerOff,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  enabledIds, devicePayload, hasPendingChanges, reviewState, type ReviewState,
} from './syncWizardState'

// ── Tipos ──────────────────────────────────────────────────────────
interface ActiveJob { job_id: number; status: string; progress?: string | null }
interface Device {
  id: number; name: string; ip_address: string; connection_mode?: string
  auto_sync_enabled: number; auto_sync_paused: number
  auto_sync_interval_min: number; auto_sync_offset_min: number
  auto_sync_attempts: number; auto_sync_cooldown_sec: number; auto_sync_timeout_sec: number
  last_auto_sync_at: string | null; next_auto_sync_at: string | null
  active_job?: ActiveJob | null
}
interface Cfg {
  ok: boolean; enabled: boolean; window: string; within_window?: boolean
  kill_switch_blocking?: boolean
  worker: { alive: boolean; heartbeat: string | null; state?: string }
  devices: Device[]
}
interface StatusItem {
  id: number; connectivity?: string; read_state?: string; status?: string
  marks_today?: number
  last_run?: { status: string; finished_at?: string; error?: string } | null
}

// ── Configuración recomendada por reloj (por nombre) ───────────────
type Rec = { label: string; interval: number; offset: number; mode: string; attempts: number; cooldown: number; timeout: number }
const RECOMMENDED: { match: RegExp; rec: Rec }[] = [
  { match: /gerencia/i, rec: { label: 'cada 15 minutos', interval: 15, offset: 0,  mode: 'auto', attempts: 3, cooldown: 4, timeout: 600 } },
  { match: /comedor/i,  rec: { label: 'cada 30 minutos', interval: 30, offset: 5,  mode: 'auto', attempts: 5, cooldown: 6, timeout: 900 } },
  { match: /lavadero/i, rec: { label: 'cada 60 minutos', interval: 60, offset: 10, mode: 'tcp',  attempts: 5, cooldown: 4, timeout: 600 } },
]
const recFor = (name: string): Rec | null => RECOMMENDED.find(r => r.match.test(name))?.rec || null
const CONN_MODE_LABEL: Record<string, string> = { auto: 'Automático', tcp: 'TCP (moderno)', udp: 'UDP (antiguo)' }

const fmtDT = (v?: string | null) => {
  if (!v) return '—'
  const d = new Date(v); return isNaN(d.getTime()) ? '—' : d.toLocaleString('es-PY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const fmtHM = (v?: string | null) => {
  if (!v) return '—'
  const d = new Date(v); return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })
}
// Próxima ejecución estimada (alineada al minuto de inicio).
function computeNext(interval: number, offset: number, from = new Date()): Date {
  const iv = Math.max(5, interval || 15)
  const base = (((offset || 0) % iv) + iv) % iv
  const d = new Date(from.getTime() + 60_000)
  const mins = d.getHours() * 60 + d.getMinutes()
  let m = Math.ceil((mins - base) / iv) * iv + base
  if (m <= mins) m += iv
  const next = new Date(d); next.setHours(0, m, 0, 0); return next
}

// Draft por reloj (config avanzada editable antes de guardar).
type Draft = { interval?: number; offset?: number; mode?: string; attempts?: number; cooldown?: number; timeout?: number; paused?: boolean }

export default function SyncWizard() {
  const router = useRouter()
  const [cfg, setCfg]       = useState<Cfg | null>(null)
  const [status, setStatus] = useState<Record<number, StatusItem>>({})
  const [loading, setLoading] = useState(true)
  const [step, setStep]     = useState<1 | 2 | 3>(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [draft, setDraft]   = useState<Record<number, Draft>>({})
  const [win, setWin]       = useState('04:00-23:59')
  const [advOpen, setAdvOpen] = useState<Record<number, boolean>>({})
  const [busy, setBusy]     = useState<Record<number, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [msg, setMsg]       = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [historyFor, setHistoryFor] = useState<Device | null>(null)
  const [showTech, setShowTech] = useState(false)

  // resync = re-derivar la selección (y limpiar el draft) desde el backend.
  // Se usa en la carga inicial y DESPUÉS de guardar/activar/desactivar o de un
  // error, para no conservar una selección local distinta de la real. El
  // sondeo de fondo (load()) NO resincroniza, así no pisa la edición en curso.
  async function load({ resync = false }: { resync?: boolean } = {}) {
    try {
      const [c, s] = await Promise.all([
        api.get('/api/devices/auto-sync-config'),
        api.get('/api/devices/sync-status').catch(() => ({ data: { items: [] } })),
      ])
      if (c.data?.ok !== false) {
        setCfg(c.data); setWin(c.data.window || '04:00-23:59')
        if (resync) { setSelected(enabledIds(c.data.devices || [])); setDraft({}) }
      }
      const map: Record<number, StatusItem> = {}
      for (const it of (s.data?.items || [])) map[it.id] = it
      setStatus(map)
    } catch { /* opcional */ }
    setLoading(false)
  }
  useEffect(() => { load({ resync: true }) }, [])
  const hasActiveJob = (cfg?.devices || []).some(d => d.active_job)
  useEffect(() => {
    const t = setInterval(() => load(), hasActiveJob ? 4000 : 25000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveJob])

  const devices = cfg?.devices || []
  const blocked = cfg?.kill_switch_blocking ?? false
  const alive   = cfg?.worker?.alive ?? false
  const enabled = cfg?.enabled ?? false
  const activeCount = devices.filter(d => d.auto_sync_enabled && !d.auto_sync_paused).length
  const nextRead = devices
    .filter(d => d.auto_sync_enabled && !d.auto_sync_paused && d.next_auto_sync_at)
    .map(d => new Date(d.next_auto_sync_at as string).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b)[0]

  const dval = (d: Device, k: keyof Draft, fallback: any) => (draft[d.id]?.[k] ?? fallback)
  const setD = (id: number, k: keyof Draft, v: any) => setDraft(p => ({ ...p, [id]: { ...p[id], [k]: v } }))

  // ¿Hay cambios sin guardar? (inclusión/exclusión, pausa, parámetros o ventana)
  const windowChanged = String(win ?? '').trim() !== String(cfg?.window ?? '').trim()
  const pending = hasPendingChanges(devices, selected, draft, win, cfg?.window)

  function applyRecommended() {
    const next: Record<number, Draft> = { ...draft }
    const sel = new Set(selected)
    for (const d of devices) {
      const r = recFor(d.name)
      if (!r) continue
      next[d.id] = { interval: r.interval, offset: r.offset, mode: r.mode, attempts: r.attempts, cooldown: r.cooldown, timeout: r.timeout, paused: false }
      sel.add(d.id)
    }
    setDraft(next); setSelected(sel)
    setMsg({ tone: 'ok', text: 'Se aplicó la configuración recomendada a los relojes reconocidos.' })
  }

  function toggleSelect(id: number) {
    setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  // Guardar la config por reloj (incluir/excluir + parámetros), en orden por id
  // para un orden de escritura determinista. Es SECUENCIAL: si un PUT falla, los
  // relojes anteriores ya quedaron guardados (guardado parcial, sin rollback
  // compensatorio). Por eso, ante un fallo, el llamador identifica el reloj y
  // RESINCRONIZA desde el backend para que la UI refleje lo realmente guardado.
  // Devuelve true si TODOS los PUT fueron correctos.
  async function persistDevices(): Promise<boolean> {
    const ordered = [...devices].sort((a, b) => a.id - b.id)
    for (const d of ordered) {
      try {
        await api.put(`/api/devices/${d.id}/auto-sync`, devicePayload(d, selected, draft))
      } catch (e: any) {
        setMsg({ tone: 'err', text: `No se pudo guardar ${d.name}: ${e.response?.data?.error || e.message}` })
        return false
      }
    }
    return true
  }

  async function activate() {
    setSaving(true); setMsg(null)
    const ok = await persistDevices()
    if (!ok) { await load({ resync: true }); setSaving(false); setConfirm(false); return }
    try {
      if (!blocked) {
        const r = await api.post('/api/devices/auto-sync-global', { enabled: true, window: win })
        if (r.data?.ok === false) throw new Error(r.data.error)
        setMsg({ tone: 'ok', text: 'Sincronización automática activada. Las lecturas se ejecutarán según lo programado, aunque el navegador esté cerrado.' })
      } else {
        // No se activa el servicio (falta el permiso del servidor). Solo queda la selección guardada.
        setMsg({ tone: 'ok', text: 'Configuración guardada como pendiente. Falta que un administrador técnico habilite el servicio en el servidor para que comience a leer.' })
      }
      await load({ resync: true })
    } catch (e: any) { setMsg({ tone: 'err', text: e.response?.data?.error || e.message }); await load({ resync: true }) }
    setSaving(false); setConfirm(false)
  }

  // Guardar cambios con la programación general YA activa: persiste la selección
  // por reloj SIN desactivar ni reiniciar el master (no toca Gerencia ni las
  // demás lecturas en curso). Sólo re-emite la ventana global si cambió. Muestra
  // éxito recién tras confirmar la respuesta real y resincroniza con el backend.
  async function saveChanges() {
    setSaving(true); setMsg(null)
    const ok = await persistDevices()
    if (!ok) { await load({ resync: true }); setSaving(false); return }
    try {
      // La ventana sólo se reescribe si cambió; se mantiene master enabled=true.
      if (!blocked && windowChanged) {
        const r = await api.post('/api/devices/auto-sync-global', { enabled: true, window: win })
        if (r.data?.ok === false) throw new Error(r.data.error)
      }
      setMsg({ tone: 'ok', text: 'Cambios guardados. La programación automática sigue activa; los relojes incluidos se leerán según lo programado.' })
      await load({ resync: true })
    } catch (e: any) { setMsg({ tone: 'err', text: e.response?.data?.error || e.message }); await load({ resync: true }) }
    setSaving(false)
  }

  // Desactivar la programación general: detiene sólo las FUTURAS lecturas
  // (el master pasa a off); no cancela una lectura en curso y CONSERVA la
  // selección de relojes (no toca auto_sync_enabled por reloj).
  async function deactivate() {
    setSaving(true); setMsg(null)
    try {
      const r = await api.post('/api/devices/auto-sync-global', { enabled: false, window: win })
      if (r.data?.ok === false) throw new Error(r.data.error)
      setMsg({ tone: 'ok', text: 'Sincronización automática desactivada. No se programarán nuevas lecturas; una lectura en curso termina normalmente.' })
      await load({ resync: true })
    } catch (e: any) { setMsg({ tone: 'err', text: e.response?.data?.error || e.message }) }
    setSaving(false); setConfirmOff(false)
  }

  // Acciones por reloj.
  async function syncNow(id: number) {
    setBusy(p => ({ ...p, [id]: true })); setMsg(null)
    try {
      const r = await api.post('/api/devices/sync-jobs', { device_ids: [id] })
      if (r.data?.ok === false) setMsg({ tone: 'err', text: r.data.error })
      else setMsg({ tone: 'ok', text: 'Lectura encolada. Se ejecuta en segundo plano.' })
      await load()
    } catch (e: any) { setMsg({ tone: 'err', text: e.response?.data?.error || e.message }) }
    setBusy(p => ({ ...p, [id]: false }))
  }
  async function setPaused(id: number, paused: boolean) {
    setBusy(p => ({ ...p, [id]: true }))
    try { await api.put(`/api/devices/${id}/auto-sync`, { paused }); await load() }
    catch (e: any) { setMsg({ tone: 'err', text: e.response?.data?.error || e.message }) }
    setBusy(p => ({ ...p, [id]: false }))
  }

  // Para el resumen del Paso 3: relojes seleccionados + los que estaban
  // habilitados y ahora se desmarcan (para mostrar la baja pendiente).
  const reviewDevices = devices.filter(d => selected.has(d.id) || d.auto_sync_enabled)

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50/60 to-white p-4 dark:border-indigo-500/20 dark:from-indigo-500/[0.06] dark:to-transparent">
      {/* Encabezado + progreso */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <RefreshCw size={18} className="text-indigo-500" />
          <h3 className="font-semibold text-slate-800 dark:text-white/90">Sincronización automática</h3>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {[1, 2, 3].map(n => (
            <span key={n} className={`px-2 py-0.5 rounded-full font-medium ${step === n ? 'bg-indigo-600 text-white' : step > n ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400 dark:bg-white/[0.06] dark:text-white/40'}`}>Paso {n} de 3</span>
          ))}
        </div>
      </div>

      {msg && (
        <div className={`mb-3 rounded-xl px-3 py-2 text-sm flex items-center gap-2 ${msg.tone === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
          {msg.tone === 'ok' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />} {msg.text}
        </div>
      )}

      {loading ? <p className="text-sm text-slate-400 dark:text-white/30 py-4">Cargando…</p> : (
        <>
          {/* ── PASO 1 — Verificar disponibilidad ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Tile label="Servicio automático" value={alive ? 'Disponible' : 'No disponible'} tone={alive ? 'ok' : 'bad'} />
                <Tile label="Permiso del servidor" value={blocked ? 'Pendiente' : 'Habilitado'} tone={blocked ? 'warn' : 'ok'} />
                <Tile label="Programación general" value={enabled ? 'Activada' : 'Desactivada'} tone={enabled ? 'ok' : 'muted'} />
                <Tile label="Relojes incluidos" value={`${activeCount} de ${devices.length}`} tone="muted" />
                <Tile label="Próxima lectura" value={nextRead ? fmtDT(new Date(nextRead).toISOString()) : '—'} tone="muted" />
              </div>

              {blocked ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/20 dark:bg-amber-500/[0.06]">
                  <p className="font-semibold text-amber-800 dark:text-amber-300">Falta habilitar el servicio automático en el servidor</p>
                  <p className="text-sm text-amber-700 dark:text-amber-300/80 mt-1">
                    Las lecturas manuales continúan disponibles. Un administrador técnico debe habilitar una vez el servicio antes de programar lecturas automáticas.
                  </p>
                  <div className="mt-3 flex gap-2 flex-wrap">
                    <button onClick={() => router.push('/configuracion/sincronizacion')} className="px-4 py-2 rounded-xl bg-slate-700 text-white text-sm hover:bg-slate-800">Continuar con lecturas manuales</button>
                    <button onClick={() => setStep(2)} className="px-4 py-2 rounded-xl border border-amber-300 text-amber-800 text-sm hover:bg-amber-100 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10">Configurar para más adelante</button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <button onClick={() => setStep(2)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm hover:bg-indigo-700">Siguiente <ArrowRight size={15} /></button>
                </div>
              )}
            </div>
          )}

          {/* ── PASO 2 — Seleccionar relojes ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-slate-500 dark:text-white/50">Elegí qué relojes se sincronizan automáticamente.</p>
                <button onClick={applyRecommended} className="text-sm px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 dark:border-indigo-500/30 dark:hover:bg-indigo-500/10">Usar configuración recomendada</button>
              </div>

              <div className="space-y-3">
                {devices.map(d => {
                  const st = status[d.id]
                  const rec = recFor(d.name)
                  const isSel = selected.has(d.id)
                  const paused = dval(d, 'paused', !!d.auto_sync_paused)
                  return (
                    <div key={d.id} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
                      <div className="flex items-start gap-3">
                        <input type="checkbox" checked={isSel} onChange={() => toggleSelect(d.id)} className="w-4 h-4 mt-1 accent-indigo-600" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-slate-800 dark:text-white/90">{d.name}</span>
                            <span className="text-xs text-slate-400 dark:text-white/30">{d.ip_address}</span>
                          </div>
                          {rec && <p className="text-xs text-slate-500 dark:text-white/40">Recomendado: {rec.label}</p>}
                          <ClockStatus st={st} device={d} />
                        </div>
                        {/* Acciones */}
                        <div className="flex items-center gap-1 shrink-0">
                          {d.active_job
                            ? <span className="text-[11px] px-2 py-1 rounded-lg bg-indigo-100 text-indigo-700 flex items-center gap-1"><RefreshCw size={11} className="animate-spin" /> {d.active_job.status === 'queued' ? 'En cola' : 'Leyendo'}</span>
                            : <button onClick={() => syncNow(d.id)} disabled={busy[d.id]} title="Sincronizar ahora"
                                className="p-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-500/30"><RefreshCw size={13} className={busy[d.id] ? 'animate-spin' : ''} /></button>}
                          {d.auto_sync_enabled ? (paused
                            ? <button onClick={() => setPaused(d.id, false)} disabled={busy[d.id]} title="Reanudar" className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/[0.08]"><Play size={13} /></button>
                            : <button onClick={() => setPaused(d.id, true)} disabled={busy[d.id]} title="Pausar" className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/[0.08]"><Pause size={13} /></button>) : null}
                          <button onClick={() => setHistoryFor(d)} title="Ver historial" className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/[0.08]"><History size={13} /></button>
                        </div>
                      </div>

                      {/* Configuración avanzada (acordeón) */}
                      <button onClick={() => setAdvOpen(p => ({ ...p, [d.id]: !p[d.id] }))}
                        className="mt-2 text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 dark:text-white/40">
                        <ChevronDown size={13} className={advOpen[d.id] ? '' : '-rotate-90'} /> Configuración avanzada
                      </button>
                      {advOpen[d.id] && (
                        <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 rounded-lg bg-slate-50 p-3 dark:bg-white/[0.03]">
                          <Num label="Intervalo (min)" value={dval(d, 'interval', d.auto_sync_interval_min)} onChange={v => setD(d.id, 'interval', v)} />
                          <Num label="Minuto de inicio" hint="Distribuye las conexiones para que los relojes no se consulten al mismo tiempo." value={dval(d, 'offset', d.auto_sync_offset_min)} onChange={v => setD(d.id, 'offset', v)} />
                          <div>
                            <Lbl>Modo de conexión</Lbl>
                            <select value={dval(d, 'mode', d.connection_mode || 'auto')} onChange={e => setD(d.id, 'mode', e.target.value)}
                              className="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
                              {['auto', 'tcp', 'udp'].map(m => <option key={m} value={m}>{CONN_MODE_LABEL[m]}</option>)}
                            </select>
                          </div>
                          <Num label="Intentos" hint="Cantidad máxima de veces que SisHoras vuelve a intentar una lectura incompleta." value={dval(d, 'attempts', d.auto_sync_attempts)} onChange={v => setD(d.id, 'attempts', v)} />
                          <Num label="Espera entre intentos (s)" hint="Tiempo que SisHoras espera antes de volver a intentar." value={dval(d, 'cooldown', d.auto_sync_cooldown_sec)} onChange={v => setD(d.id, 'cooldown', v)} />
                          <Num label="Tiempo máximo (s)" hint="Tiempo máximo permitido para completar una lectura." value={dval(d, 'timeout', d.auto_sync_timeout_sec)} onChange={v => setD(d.id, 'timeout', v)} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Ventana operativa (avanzado, global) */}
              <details className="text-xs text-slate-500 dark:text-white/40">
                <summary className="cursor-pointer">Horario permitido (avanzado)</summary>
                <div className="mt-2 flex items-center gap-2">
                  <input value={win} onChange={e => setWin(e.target.value)} placeholder="04:00-23:59"
                    className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm w-32 dark:border-white/[0.08] dark:bg-white/[0.04]" />
                  <span className="text-slate-400">Solo se leen los relojes dentro de este horario.</span>
                </div>
              </details>

              <div className="flex justify-between">
                <button onClick={() => setStep(1)} className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-sm hover:bg-slate-50 dark:border-white/[0.08]"><ArrowLeft size={15} /> Atrás</button>
                <button onClick={() => setStep(3)} disabled={selected.size === 0} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm hover:bg-indigo-700 disabled:opacity-50">Siguiente <ArrowRight size={15} /></button>
              </div>
            </div>
          )}

          {/* ── PASO 3 — Revisar y guardar/activar ── */}
          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-500 dark:text-white/50">
                {enabled && !blocked ? 'Revisá los cambios antes de guardar:' : 'Revisá antes de activar:'}
              </p>
              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <ul className="space-y-1 text-sm">
                  {reviewDevices.map(d => {
                    const iv = Number(dval(d, 'interval', d.auto_sync_interval_min))
                    const off = Number(dval(d, 'offset', d.auto_sync_offset_min))
                    const rs = reviewState(d, selected, draft)
                    const badge: Record<ReviewState, { label: string; cls: string }> = {
                      saved:          { label: 'Guardado',           cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' },
                      pending_add:    { label: 'Se activará al guardar', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' },
                      pending_update: { label: 'Cambios sin guardar', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' },
                      pending_remove: { label: 'Se quitará al guardar', cls: 'bg-red-100 text-red-700 dark:bg-red-400/10 dark:text-red-300' },
                    }
                    // "próxima lectura" REAL sólo si ya está activa y guardada;
                    // en pendientes se muestra la estimación, no un dato activo.
                    const detail = rs === 'pending_remove'
                      ? 'dejará de leerse'
                      : rs === 'saved'
                        ? (d.auto_sync_enabled && !d.auto_sync_paused && d.next_auto_sync_at
                            ? `cada ${iv} min · próxima ${fmtHM(d.next_auto_sync_at)}` : `cada ${iv} min`)
                        : `cada ${iv} min · primera lectura ≈ ${fmtHM(computeNext(iv, off).toISOString())}`
                    return (
                      <li key={d.id} className="flex items-center justify-between gap-3 border-b border-slate-50 dark:border-white/[0.06] py-1">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-slate-800 dark:text-white/90 truncate">{d.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${badge[rs].cls}`}>{badge[rs].label}</span>
                        </span>
                        <span className="text-xs text-slate-500 dark:text-white/40 text-right">{detail}</span>
                      </li>
                    )
                  })}
                </ul>
                <p className="text-xs text-slate-500 dark:text-white/40 pt-1">Horario operativo: <strong>{win}</strong>{windowChanged && <span className="ml-1 text-amber-600 dark:text-amber-400">(sin guardar)</span>}</p>
                <p className="text-xs text-slate-500 dark:text-white/40 flex items-center gap-1.5"><Clock3 size={13} /> Las lecturas se ejecutan aunque el navegador esté cerrado.</p>
              </div>

              {enabled && !blocked && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-500/20 dark:bg-green-500/[0.06] dark:text-green-300 flex items-center gap-2">
                  <CheckCircle2 size={16} /> <span>
                    <strong>Sincronización automática activa.</strong> Las lecturas se ejecutan según lo programado{nextRead ? ` · próxima ${fmtDT(new Date(nextRead).toISOString())}` : ''}.
                    {pending ? ' Hay cambios sin guardar: usá “Guardar cambios” para aplicarlos.' : ''}
                  </span>
                </div>
              )}
              {blocked && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.06] dark:text-amber-300">
                  El servicio automático todavía no está habilitado en el servidor. Al confirmar, la selección quedará <strong>guardada como pendiente</strong>: no se ejecutarán lecturas automáticas hasta que un administrador técnico habilite el servicio.
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button onClick={() => setStep(2)} className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-sm hover:bg-slate-50 dark:border-white/[0.08]"><ArrowLeft size={15} /> Atrás</button>
                {enabled && !blocked ? (
                  // Programación general activa: Guardar cambios (principal) +
                  // Desactivar (secundario, separado). Nunca se reemplazan.
                  <div className="flex items-center gap-2">
                    <button onClick={() => setConfirmOff(true)} disabled={saving}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-200 text-red-600 text-sm hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10">
                      <PowerOff size={15} /> Desactivar
                    </button>
                    <button onClick={saveChanges} disabled={saving || !pending}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                      <Save size={15} /> {saving ? 'Guardando…' : pending ? 'Guardar cambios' : 'Configuración actualizada'}
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setConfirm(true)} disabled={saving || selected.size === 0}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                    <ShieldCheck size={15} /> {blocked ? 'Guardar configuración' : 'Activar sincronización automática'}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Detalles técnicos (colapsado, fuera de la vista principal) */}
      <details className="mt-4 text-xs text-slate-400 dark:text-white/30" open={showTech} onToggle={e => setShowTech((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer">Detalles técnicos</summary>
        <div className="mt-1 space-y-0.5 font-mono">
          <div>Servicio (heartbeat): {cfg?.worker?.heartbeat ? fmtDT(cfg.worker.heartbeat) : '—'}</div>
          <div>Permiso del servidor (ZKTECO_AUTO_POLL): {blocked ? 'bloqueado (false)' : 'habilitado (true)'}</div>
          <div>Programación general (setting): {enabled ? 'activada' : 'desactivada'}</div>
          <div>Estado interno del worker: {cfg?.worker?.state}</div>
        </div>
      </details>

      {/* Confirmación final */}
      {confirm && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
            <h3 className="font-bold text-slate-900 dark:text-white">{blocked ? 'Guardar configuración pendiente' : 'Activar sincronización automática'}</h3>
            <p className="text-sm text-slate-500 dark:text-white/50">
              {blocked
                ? 'Se guardará la selección de relojes y sus parámetros. No comenzará a leer hasta que el servicio esté habilitado en el servidor.'
                : `Se activará la sincronización automática para ${selected.size} reloj(es), dentro del horario ${win}.`}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirm(false)} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
              <button onClick={activate} disabled={saving} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                <Check size={15} /> {saving ? 'Guardando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmación de desactivación */}
      {confirmOff && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 dark:bg-[#0d0d0f]">
            <h3 className="font-bold text-slate-900 dark:text-white">Desactivar sincronización automática</h3>
            <p className="text-sm text-slate-500 dark:text-white/50">
              No se programarán nuevas lecturas automáticas. Una lectura que ya esté en curso terminará normalmente. La selección de relojes se conserva, así podés reactivarla cuando quieras.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmOff(false)} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
              <button onClick={deactivate} disabled={saving} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                <PowerOff size={15} /> {saving ? 'Desactivando…' : 'Desactivar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Historial de sincronizaciones */}
      {historyFor && <HistoryModal device={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  )
}

// ── Estado por reloj: conectividad · última lectura · programación ──
function ClockStatus({ st, device }: { st?: StatusItem; device: Device }) {
  const conn = st?.connectivity
  const connLabel = conn === 'online' ? 'En línea' : conn === 'offline' ? 'Sin conexión' : 'Comprobando'
  const ConnIcon = conn === 'online' ? Wifi : conn === 'offline' ? WifiOff : Clock3
  const READ: Record<string, string> = {
    complete: 'última lectura completada', partial: 'última lectura parcial', error: 'última lectura con error',
    reading: 'leyendo ahora', pending_first_read: 'todavía no se realizaron lecturas hoy', no_data: 'sin datos todavía',
  }
  const readLabel = READ[st?.read_state || ''] || 'todavía no ejecutada'
  const prog = !device.auto_sync_enabled ? 'no incluido' : device.auto_sync_paused ? 'pausado' : 'incluido'
  const nextTxt = device.auto_sync_enabled && !device.auto_sync_paused && device.next_auto_sync_at ? ` · próxima lectura ${fmtHM(device.next_auto_sync_at)}` : ''
  const readTone = st?.read_state === 'error' ? 'text-red-600' : st?.read_state === 'partial' ? 'text-amber-600' : 'text-slate-500 dark:text-white/40'
  return (
    <p className="text-xs mt-1 flex items-center gap-1 flex-wrap">
      <span className={`inline-flex items-center gap-1 ${conn === 'online' ? 'text-emerald-600' : conn === 'offline' ? 'text-slate-500' : 'text-slate-400'}`}>
        <ConnIcon size={12} /> {connLabel}
      </span>
      <span className="text-slate-300">·</span>
      <span className={readTone}>{readLabel}</span>
      {nextTxt && <><span className="text-slate-300">·</span><span className="text-slate-500 dark:text-white/40">{prog}{nextTxt}</span></>}
      {!nextTxt && <><span className="text-slate-300">·</span><span className="text-slate-400 dark:text-white/30">{prog}</span></>}
    </p>
  )
}

function HistoryModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  useEffect(() => {
    api.get(`/api/devices/${device.id}/sync-runs`, { params: { limit: 30 } })
      .then(r => setRows(r.data?.items || [])).catch(() => setRows([]))
  }, [device.id])
  const STATUS: Record<string, { label: string; cls: string }> = {
    success: { label: 'Completada', cls: 'bg-emerald-100 text-emerald-700' },
    partial: { label: 'Parcial', cls: 'bg-amber-100 text-amber-700' },
    error:   { label: 'Error', cls: 'bg-red-100 text-red-700' },
    timeout: { label: 'Timeout', cls: 'bg-red-100 text-red-700' },
  }
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-2xl p-6 space-y-3 dark:bg-[#0d0d0f]">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-900 dark:text-white">Historial de sincronizaciones — {device.name}</h3>
          <button aria-label="Cerrar" onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        {rows === null ? <p className="text-sm text-slate-400 py-6 text-center">Cargando…</p>
          : rows.length === 0 ? <p className="text-sm text-slate-400 py-6 text-center">Sin corridas registradas.</p>
          : (
            <div className="max-h-96 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/[0.06]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 dark:bg-white/[0.04] text-left text-slate-500 dark:text-white/40">
                  <tr><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Importadas</th><th className="px-3 py-2">Intentos</th><th className="px-3 py-2">Duración</th><th className="px-3 py-2">Detalle</th></tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const s = STATUS[r.status] || { label: r.status, cls: 'bg-slate-100 text-slate-500' }
                    return (
                      <tr key={r.id} className="border-t border-slate-50 dark:border-white/[0.04]">
                        <td className="px-3 py-1.5">{fmtDT(r.finished_at || r.started_at)}</td>
                        <td className="px-3 py-1.5"><span className={`px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span></td>
                        <td className="px-3 py-1.5">{r.imported_count ?? 0}{r.in_range_count != null ? ` / ${r.in_range_count}` : ''}</td>
                        <td className="px-3 py-1.5">{r.attempts ?? '—'}{r.attempts_requested != null && r.attempts_requested !== r.attempts ? ` de ${r.attempts_requested}` : ''}</td>
                        <td className="px-3 py-1.5">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                        <td className="px-3 py-1.5 text-slate-500 dark:text-white/40 max-w-[16rem] truncate" title={r.error_message || ''}>{r.error_message || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  )
}

// ── Helpers de UI ──────────────────────────────────────────────────
function Tile({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }) {
  const cls = tone === 'ok' ? 'text-green-700 dark:text-green-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : tone === 'bad' ? 'text-red-700 dark:text-red-400' : 'text-slate-700 dark:text-white/80'
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-3 py-2 dark:bg-white/[0.03] dark:border-white/[0.06]">
      <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-white/30">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  )
}
function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="text-[11px] text-slate-500 block mb-0.5 dark:text-white/40">{children}</label>
}
function Num({ label, value, onChange, hint }: { label: string; value: any; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      <input type="number" min={0} value={value ?? 0} onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm dark:border-white/[0.08] dark:bg-white/[0.04]" />
      {hint && <p className="text-[10px] text-slate-400 mt-0.5 leading-tight dark:text-white/30">{hint}</p>}
    </div>
  )
}
