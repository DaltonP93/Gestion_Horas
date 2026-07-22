'use client'
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { api } from '@/lib/api'

// Modal compartido para vincular un usuario biométrico (device_user_id) a un
// empleado: buscar → seleccionar → tarjeta de confirmación → confirmar.
// Hace el POST /api/devices/map (map + reproceso + recálculo + auditoría) y
// devuelve el resumen por onDone. Usado por Sincronización y por la pestaña
// Usuarios del reloj.
export default function VincularEmpleadoModal({
  deviceUserId, deviceId, deviceName, deviceUserName, marcas, periodo, onClose, onDone,
}: {
  deviceUserId: string
  deviceId: number | null
  deviceName?: string | null
  deviceUserName?: string | null
  marcas?: number
  periodo?: string
  onClose: () => void
  onDone?: (summary: any) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

  async function confirmar() {
    if (!selected) return
    setBusy(true); setError('')
    try {
      const r = await api.post('/api/devices/map', {
        employee_id: selected.id, device_user_id: deviceUserId, device_id: deviceId,
      })
      if (r.data.ok) { onDone?.(r.data); onClose() }
      else setError(r.data.error || 'No se pudo vincular')
    } catch (e: any) { setError(e?.response?.data?.error || e.message) }
    finally { setBusy(false) }
  }

  const crearHref = `/empleados/nuevo?device_id=${deviceId ?? ''}&device_user_id=${encodeURIComponent(deviceUserId)}&return_to=vinculacion`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/[0.1] shadow-2xl p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white">Vincular usuario del reloj</h3>
            <p className="text-xs text-slate-500 dark:text-white/40 mt-0.5">
              <span className="font-mono font-semibold">{deviceUserId}</span>
              {deviceUserName ? <> · “{deviceUserName}” en el reloj</> : null}
              {' · '}{deviceName || (deviceId ? `reloj #${deviceId}` : 'cualquier reloj')}
              {marcas != null && <> · {marcas} marca(s) pendiente(s)</>}
              {periodo && <> · {periodo}</>}
            </p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 text-lg leading-none disabled:opacity-50">✕</button>
        </div>

        {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}

        {!selected ? (
          <>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nombre, código, legajo o documento…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
            <div className="mt-2 max-h-64 overflow-y-auto space-y-0.5">
              {searching && <p className="text-xs text-slate-400 px-1 py-2">Buscando…</p>}
              {!searching && q.trim().length >= 2 && results.length === 0 && (
                <div className="px-1 py-3 text-xs text-slate-500 dark:text-white/40">No se encontró ningún empleado con “{q.trim()}”.</div>
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
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
              <span className="text-[11px] text-slate-400 dark:text-white/30">¿El empleado no existe todavía?</span>
              <a href={crearHref} className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs flex items-center gap-1">
                <Search size={12} /> Crear empleado y vincular
              </a>
            </div>
          </>
        ) : (
          <>
            {/* Tarjeta de confirmación antes de vincular */}
            <div className="rounded-xl border border-slate-200 dark:border-white/[0.08] divide-y divide-slate-100 dark:divide-white/[0.06] text-sm">
              <Row k="Usuario del reloj" v={deviceUserId} mono />
              <Row k="Reloj" v={deviceName || (deviceId ? `#${deviceId}` : 'cualquier reloj')} />
              <Row k="Empleado" v={`${selected.full_name}${selected.status !== 'active' ? ` (${selected.status})` : ''}`} />
              <Row k="Código" v={selected.code || '—'} />
              <Row k="Legajo" v={selected.employee_number || '—'} />
              <Row k="Documento" v={selected.document_number || '—'} />
              {marcas != null && <Row k="Marcas pendientes" v={String(marcas)} />}
              {periodo && <Row k="Período" v={periodo} />}
            </div>
            <p className="text-[11px] text-slate-400 dark:text-white/30 mt-2">
              Al confirmar se crea el vínculo, se importan sus marcas pendientes y se recalcula la asistencia de las fechas afectadas.
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button onClick={() => setSelected(null)} disabled={busy} className="px-3 py-2 rounded-xl border border-slate-200 dark:border-white/[0.08] text-sm disabled:opacity-50">Volver</button>
              <button onClick={confirmar} disabled={busy} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
                {busy ? 'Vinculando…' : 'Confirmar vínculo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-xs text-slate-400 dark:text-white/30">{k}</span>
      <span className={`text-slate-700 dark:text-white/80 ${mono ? 'font-mono font-semibold' : ''}`}>{v}</span>
    </div>
  )
}
