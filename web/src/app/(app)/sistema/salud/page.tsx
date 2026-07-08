'use client'
import { useEffect, useState } from 'react'
import { Activity, CheckCircle2, XCircle, RefreshCw, Server, Database, Network, Cpu } from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

interface Check { ok: boolean; latency_ms?: number; error?: string; status?: number }
interface Detailed {
  status: string; timestamp: string; uptime_sec: number; version: string; node: string; host: string
  checks: { mysql: Check; redis: Check; att2000: Check; bridge: Check }
  memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number }
  loadavg: number[]
}

const LABELS: Record<string, { label: string; icon: any }> = {
  mysql:   { label: 'MySQL (asistencia)', icon: Database },
  redis:   { label: 'Redis',              icon: Network },
  att2000: { label: 'att2000 (SQL Server)', icon: Server },
  bridge:  { label: 'Bridge ZKTeco',      icon: Cpu },
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400); s %= 86400
  const h = Math.floor(s / 3600);  s %= 3600
  const m = Math.floor(s / 60)
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m'
}

export default function HealthPage() {
  const [data, setData] = useState<Detailed | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const r = await api.get('/api/health/detailed')
      setData(r.data)
    } catch (e: any) {
      // aún cuando devuelve 503, axios incluye el body
      if (e?.response?.data) setData(e.response.data)
      else setErr(e?.response?.data?.error || 'Error al consultar salud')
    } finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="p-6 max-w-6xl space-y-5">
      <BackButton href="/sistema" label="Sistema" />
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-emerald-600 flex items-center justify-center">
          <Activity className="text-white" size={22} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Salud del sistema</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Estado de dependencias y métricas del proceso API</p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm text-slate-700 disabled:opacity-50 dark:bg-white/[0.06] dark:text-white/80">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {err && <div className="rounded-xl px-4 py-3 text-sm bg-red-50 border border-red-200 text-red-700">{err}</div>}

      {data && (
        <>
          <div className={`rounded-2xl p-4 border ${data.status === 'ok'
            ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className="flex items-center gap-3">
              {data.status === 'ok'
                ? <CheckCircle2 className="text-emerald-600" size={22} />
                : <XCircle className="text-amber-600" size={22} />}
              <div className="flex-1">
                <div className="font-semibold">
                  Sistema {data.status === 'ok' ? 'operativo' : 'degradado'}
                </div>
                <div className="text-xs text-slate-600 dark:text-white/60">
                  uptime {fmtUptime(data.uptime_sec)} · {data.host} · node {data.node} · v{data.version}
                </div>
              </div>
              <div className="text-xs text-slate-500 dark:text-white/40">
                {new Date(data.timestamp).toLocaleString()}
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {(Object.entries(data.checks) as [keyof Detailed['checks'], Check][]).map(([k, c]) => {
              const meta = LABELS[k]
              const Icon = meta.icon
              return (
                <div key={k} className="bg-white rounded-2xl border border-slate-100 shadow p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
                  <div className="flex items-center gap-3">
                    <Icon className="text-slate-500 dark:text-white/40" size={20} />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-900 dark:text-white">{meta.label}</div>
                      <div className="text-xs text-slate-500 dark:text-white/40">
                        {c.latency_ms != null && <>latencia {c.latency_ms}ms</>}
                        {c.status != null && <> · status {c.status}</>}
                      </div>
                    </div>
                    {c.ok
                      ? <span className="px-2 py-1 rounded bg-emerald-100 text-emerald-800 text-xs">OK</span>
                      : <span className="px-2 py-1 rounded bg-red-100 text-red-800 text-xs">FAIL</span>}
                  </div>
                  {c.error && <div className="mt-2 text-xs text-red-700 break-all">{c.error}</div>}
                </div>
              )
            })}
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow p-4 grid md:grid-cols-3 gap-4 text-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
            <div>
              <div className="text-xs text-slate-500 uppercase dark:text-white/40">RSS</div>
              <div className="text-2xl font-bold">{data.memory.rss_mb} MB</div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase dark:text-white/40">Heap</div>
              <div className="text-2xl font-bold">{data.memory.heap_used_mb} / {data.memory.heap_total_mb} MB</div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase dark:text-white/40">Load avg (1/5/15m)</div>
              <div className="text-2xl font-bold">
                {data.loadavg.map(n => n.toFixed(2)).join(' · ')}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
