'use client'
import { useCallback, useEffect, useState } from 'react'
import { Fingerprint, Link2, Unlink, RefreshCw, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTimePy } from '@/lib/datetime'

interface Linked { id: number; device_id: number | null; device_name: string | null; device_user_id: string; last_mark: string | null }
interface Suggestion { device_id: number | null; device_name: string | null; device_user_id: string; marcas: number; first_py: string; last_py: string }
interface ByDevice { device_id: number | null; device_name: string | null; marcas: number; last_mark: string | null }

// Sección "Biometría / Relojes" del perfil del empleado. Permite vincular un
// usuario del reloj (device_user_id) al empleado, desvincular (sin borrar
// marcaciones históricas) y reprocesar. El botón "Enviar al reloj" queda para
// una fase posterior (sync inversa) — acá no se incluye.
export default function BiometriaRelojes({ employeeId }: { employeeId: number }) {
  const [linked, setLinked] = useState<Linked[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [byDevice, setByDevice] = useState<ByDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [manualUid, setManualUid] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get(`/api/employees/${employeeId}/biometrics`)
      setLinked(r.data.linked || [])
      setSuggestions(r.data.suggestions || [])
      setByDevice(r.data.by_device || [])
    } catch (e: any) { setMsg(e?.response?.data?.error || e.message) }
    finally { setLoading(false) }
  }, [employeeId])

  useEffect(() => { load() }, [load])

  async function link(deviceUserId: string, deviceId: number | null) {
    if (!deviceUserId) return
    setBusy(true); setMsg('')
    try {
      const r = await api.post(`/api/employees/${employeeId}/biometrics`, { device_user_id: deviceUserId, device_id: deviceId })
      if (r.data.ok) setMsg(`Vinculado ${deviceUserId}: ${r.data.mapped || 0} marcas importadas, ${r.data.duplicate || 0} duplicadas.`)
      else setMsg(r.data.error || 'Error')
      setManualUid('')
      await load()
    } catch (e: any) { setMsg(e?.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  async function unlink(mapId: number) {
    if (!confirm('¿Desvincular este usuario del reloj? Las marcaciones históricas NO se borran.')) return
    setBusy(true); setMsg('')
    try {
      await api.delete(`/api/employees/${employeeId}/biometrics/${mapId}`)
      setMsg('Vínculo desactivado (marcaciones históricas conservadas).')
      await load()
    } catch (e: any) { setMsg(e?.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Fingerprint size={18} className="text-indigo-500" />
          <h3 className="font-semibold text-slate-800 dark:text-white/90">Biometría / Relojes</h3>
        </div>
        <button onClick={load} disabled={loading} className="p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg disabled:opacity-50">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {msg && <p className="text-xs mb-3 text-slate-500 dark:text-white/50">{msg}</p>}

      {/* Vínculos activos */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-white/30 mb-2">Usuarios de reloj vinculados</p>
        {linked.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-white/30">Sin vínculos activos. El empleado mapea por su código si coincide con el reloj.</p>
        ) : (
          <div className="space-y-2">
            {linked.map(l => (
              <div key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 dark:border-white/[0.06] px-3 py-2">
                <div className="text-sm">
                  <span className="font-mono font-semibold">{l.device_user_id}</span>
                  <span className="text-slate-400 dark:text-white/30"> · {l.device_name || (l.device_id ? `reloj #${l.device_id}` : 'cualquier reloj')}</span>
                  {l.last_mark && <span className="text-[11px] text-slate-400 dark:text-white/30 ml-2"><Clock size={10} className="inline mr-1" />{fmtTimePy(l.last_mark)}</span>}
                </div>
                <button onClick={() => unlink(l.id)} disabled={busy} className="text-xs flex items-center gap-1 text-rose-600 hover:text-rose-700 disabled:opacity-50">
                  <Unlink size={13} /> Desvincular
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sugerencias (marcas sin empleado que coinciden por código) */}
      {suggestions.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-500 mb-2">Marcas sin empleado que coinciden</p>
          <div className="space-y-2">
            {suggestions.map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-400/20 bg-amber-50/50 dark:bg-amber-400/[0.05] px-3 py-2">
                <div className="text-sm">
                  <span className="font-mono font-semibold">{s.device_user_id}</span>
                  <span className="text-slate-400 dark:text-white/30"> · {s.device_name} · {s.marcas} marcas</span>
                </div>
                <button onClick={() => link(s.device_user_id, s.device_id)} disabled={busy} className="text-xs flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
                  <Link2 size={13} /> Vincular
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Vinculación manual (para casos sin coincidencia, p.ej. device_user_id=5404) */}
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-white/30 mb-2">Vincular un usuario de reloj manualmente</p>
        <div className="flex items-center gap-2">
          <input value={manualUid} onChange={e => setManualUid(e.target.value.trim())} placeholder="device_user_id (p.ej. 5404)"
            className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
          <button onClick={() => link(manualUid, null)} disabled={busy || !manualUid} className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50">
            Vincular
          </button>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-white/30 mt-1">Se aplica a cualquier reloj (mapeo global) y reprocesa sus marcas sin empleado.</p>
      </div>

      {/* Última marca por reloj */}
      {byDevice.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-white/30 mb-2">Última marca por reloj</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-white/40">
            {byDevice.map((b, i) => (
              <span key={i}>{b.device_name || (b.device_id ? `#${b.device_id}` : 'móvil/manual')}: {b.marcas} · {b.last_mark ? fmtTimePy(b.last_mark) : '—'}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
