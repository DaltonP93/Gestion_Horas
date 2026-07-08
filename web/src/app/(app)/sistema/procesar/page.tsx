'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Calculator, ArrowLeft, Play, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { getSocket } from '@/lib/socket'

interface Preview {
  pairs: number
  employees: number
  logs: number
  dateFrom: string
  dateTo: string
}

interface Progress {
  jobId: string
  stage: 'start' | 'progress' | 'done' | 'error'
  percent?: number
  done?: number
  total?: number
  date?: string
  error?: string
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
function daysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function ProcesarHorasPage() {
  const [dateFrom, setDateFrom] = useState(daysAgo(7))
  const [dateTo, setDateTo]     = useState(todayStr())
  const [preview, setPreview]   = useState<Preview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult]     = useState<any>(null)
  const [error, setError]       = useState('')
  const jobIdRef = useRef<string | null>(null)

  // Suscripción Socket.io
  useEffect(() => {
    const socket = getSocket()
    const handler = (p: Progress) => {
      if (!jobIdRef.current || p.jobId !== jobIdRef.current) return
      setProgress(p)
      if (p.stage === 'done') {
        setRunning(false)
        setResult({ done: p.done, total: p.total })
      }
      if (p.stage === 'error') {
        setRunning(false)
        setError(p.error || 'Error desconocido')
      }
    }
    socket.on('processing:progress', handler)
    return () => { socket.off('processing:progress', handler) }
  }, [])

  async function loadPreview() {
    setLoadingPreview(true); setError(''); setPreview(null)
    try {
      const { data } = await api.get('/api/processing/preview', { params: { dateFrom, dateTo } })
      setPreview(data)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally {
      setLoadingPreview(false)
    }
  }

  async function startProcessing() {
    if (!confirm(`Procesar horas del ${dateFrom} al ${dateTo}?\nEsto recalculará el resumen diario de todos los empleados con marcajes en ese rango.`)) return
    setRunning(true); setError(''); setResult(null); setProgress(null)
    try {
      const { data } = await api.post('/api/processing/recompute', { dateFrom, dateTo })
      jobIdRef.current = data.jobId
    } catch (e: any) {
      setRunning(false)
      setError(e.response?.data?.error || e.message)
    }
  }

  const pct = progress?.percent ?? 0

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/sistema" className="p-2 rounded-xl hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
          <ArrowLeft size={20} />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-emerald-500 flex items-center justify-center">
          <Calculator className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Procesar Horas</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Recalcula el resumen diario para un rango de fechas.</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-semibold text-slate-900 dark:text-white">Rango de fechas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Desde</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Hasta</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-white/[0.08]" />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {([[0,0,'Hoy'],[1,1,'Ayer'],[7,0,'Últimos 7d'],[30,0,'Últimos 30d']] as const).map(([a,b,label]) => (
            <button key={label}
              onClick={() => { setDateFrom(daysAgo(a)); setDateTo(daysAgo(b)) }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-white/[0.06] dark:text-white/80"
            >{label}</button>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={loadPreview} disabled={loadingPreview || running}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 dark:bg-white/[0.06] dark:text-white/80">
            {loadingPreview ? 'Calculando...' : 'Vista previa'}
          </button>
          <button onClick={startProcessing} disabled={running}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-60">
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {running ? 'Procesando...' : 'Procesar horas'}
          </button>
        </div>
      </div>

      {preview && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h3 className="font-semibold text-slate-900 mb-3 dark:text-white">Vista previa</h3>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Marcajes" value={preview.logs} />
            <Stat label="Empleados" value={preview.employees} />
            <Stat label="Pares (emp × día)" value={preview.pairs} />
          </div>
          <p className="text-xs text-slate-500 mt-4 dark:text-white/40">
            Se recalcularán <b>{preview.pairs}</b> filas de <code>daily_summary</code>.
          </p>
        </div>
      )}

      {(running || progress) && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="flex justify-between text-sm">
            <span className="font-medium text-slate-900 dark:text-white">
              {progress?.stage === 'done' ? 'Completado' : 'Procesando...'}
            </span>
            <span className="text-slate-500 dark:text-white/40">
              {progress?.done ?? 0} / {progress?.total ?? '?'} ({pct}%)
            </span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden dark:bg-white/[0.06]">
            <div className="h-full bg-emerald-500 transition-all"
                 style={{ width: `${pct}%` }} />
          </div>
          {progress?.date && (
            <p className="text-xs text-slate-500 dark:text-white/40">Último día procesado: {progress.date}</p>
          )}
        </div>
      )}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
          <CheckCircle2 className="text-emerald-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-emerald-900">
            <b>Procesamiento completado.</b> Se recalcularon {result.done} de {result.total} pares.
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900"><b>Error:</b> {error}</div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-50 rounded-xl p-4 dark:bg-white/[0.03]">
      <p className="text-xs text-slate-500 uppercase tracking-wide dark:text-white/40">{label}</p>
      <p className="text-2xl font-bold text-slate-900 mt-1 dark:text-white">{value.toLocaleString()}</p>
    </div>
  )
}
