'use client'
import { useState } from 'react'
import { Radar, Search, CheckCircle, XCircle, Wifi, Plus, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

interface FoundDevice {
  ip: string
  port: number
  latency_ms: number
}

export default function DiscoveryPage() {
  const [subnet, setSubnet] = useState('192.168.1')
  const [port, setPort] = useState(4370)
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<FoundDevice[]>([])
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Probe individual
  const [probeIp, setProbeIp] = useState('')
  const [probeResult, setProbeResult] = useState<{ reachable: boolean; latency_ms?: number } | null>(null)
  const [probing, setProbing] = useState(false)

  async function scan() {
    setScanning(true); setError(''); setFound([]); setDone(false)
    try {
      // La llamada va al bridge (puerto 8081) a través del proxy de la API
      const r = await api.get('/api/bridge/discovery', { params: { subnet, port } })
      setFound(r.data.found || [])
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al escanear — verifique la configuración del bridge')
    } finally {
      setScanning(false); setDone(true)
    }
  }

  async function probe() {
    if (!probeIp) return
    setProbing(true); setProbeResult(null)
    try {
      const r = await api.post('/api/bridge/discovery/probe', { ip: probeIp, port })
      setProbeResult({ reachable: r.data.reachable, latency_ms: r.data.latency_ms })
    } catch {
      setProbeResult({ reachable: false })
    } finally {
      setProbing(false) }
  }

  async function addDevice(ip: string) {
    try {
      await api.post('/api/devices', { ip, port, name: `Reloj ${ip}`, connection_mode: 'auto' })
      alert(`Reloj ${ip} agregado. Configuralo en Relojes ZKTeco.`)
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error al agregar')
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <BackButton href="/configuracion" />
        <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
          <Radar className="text-white" size={20} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Descubrimiento de Relojes</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Escanea la LAN buscando relojes ZKTeco (puerto {port})</p>
        </div>
      </div>

      {/* Scan config */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-semibold text-slate-800 text-sm dark:text-white/90">Escaneo de subred</h2>
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs text-slate-500 mb-1 block dark:text-white/40">Subred (X.X.X)</label>
            <input value={subnet} onChange={e => setSubnet(e.target.value)}
              placeholder="192.168.1"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          </div>
          <div className="w-24">
            <label className="text-xs text-slate-500 mb-1 block dark:text-white/40">Puerto</label>
            <input type="number" value={port} onChange={e => setPort(+e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
          </div>
          <div className="flex items-end">
            <button onClick={scan} disabled={scanning}
              className="bg-blue-600 text-white rounded-xl px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2">
              {scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              {scanning ? 'Escaneando...' : 'Escanear'}
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-400 dark:text-white/30">
          Escanea {subnet}.1 — {subnet}.254 (254 hosts). Puede tardar 15–30 segundos.
        </p>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

        {done && !error && (
          <div className={`text-sm rounded-xl px-4 py-3 ${found.length ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-50 text-slate-500 border border-slate-200'}`}>
            {found.length
              ? `Se encontraron ${found.length} dispositivo(s) respondiendo en ${subnet}.x:${port}.`
              : `Sin respuesta en ${subnet}.x:${port}. Verificá que el puerto sea correcto y estés en la misma LAN.`}
          </div>
        )}

        {found.length > 0 && (
          <div className="space-y-2">
            {found.map(d => (
              <div key={d.ip} className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3 border border-slate-200 dark:bg-white/[0.03] dark:border-white/[0.08]">
                <div className="flex items-center gap-3">
                  <Wifi size={16} className="text-emerald-500" />
                  <div>
                    <span className="font-mono font-semibold text-slate-800 text-sm dark:text-white/90">{d.ip}:{d.port}</span>
                    <span className="text-xs text-slate-400 ml-2 dark:text-white/30">{d.latency_ms}ms</span>
                  </div>
                </div>
                <button onClick={() => addDevice(d.ip)}
                  className="flex items-center gap-1 text-xs bg-blue-100 text-blue-700 rounded-lg px-3 py-1.5 hover:bg-blue-200 transition-colors">
                  <Plus size={12} /> Agregar
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Probe puntual */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-semibold text-slate-800 text-sm dark:text-white/90">Probar IP puntual</h2>
        <div className="flex gap-3">
          <input value={probeIp} onChange={e => setProbeIp(e.target.value)}
            placeholder="172.16.20.160"
            className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
          <button onClick={probe} disabled={probing || !probeIp}
            className="bg-slate-700 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-slate-800 disabled:opacity-60 flex items-center gap-2">
            {probing ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Probar
          </button>
        </div>
        {probeResult && (
          <div className={`flex items-center gap-2 text-sm rounded-xl px-4 py-3 ${probeResult.reachable ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
            {probeResult.reachable
              ? <><CheckCircle size={16} /> Alcanzable — {probeResult.latency_ms}ms</>
              : <><XCircle size={16} /> Sin respuesta en {probeIp}:{port}</>}
          </div>
        )}
      </div>

      <p className="text-xs text-slate-400 text-center dark:text-white/30">
        El escaneo se ejecuta en el servicio Bridge (puerto 8081). El bridge debe estar activo y en la misma red que los relojes.
      </p>
    </div>
  )
}
