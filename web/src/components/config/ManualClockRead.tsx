'use client'
import { useEffect, useRef, useState } from 'react'
import { Cpu } from 'lucide-react'
import { api } from '@/lib/api'

type JobStatus = 'queued' | 'running' | 'success' | 'partial' | 'error' | 'cancelled'
interface ClockJob {
  id: number
  device_id: number
  batch_id: string
  device_name?: string
  status: JobStatus
  progress?: string
  error?: string
  cancel_requested?: boolean | number
  result?: Record<string, unknown> | null
}
interface Batch { id: string; from: string; to: string; jobs: ClockJob[] }

const terminal = (job: ClockJob) => ['success', 'partial', 'error', 'cancelled'].includes(job.status)
const labels: Record<JobStatus, string> = {
  queued: 'En cola', running: 'Leyendo reloj', success: 'Lectura finalizada',
  partial: 'Lectura parcial', error: 'Error de lectura', cancelled: 'Lectura cancelada',
}
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : '—'

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number(value.slice(0, 4)) > 0
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
}

function readBatch(data: any, from: string, to: string): Batch {
  if (data?.ok !== true || typeof data.batch_id !== 'string' || !data.batch_id
    || !Array.isArray(data.jobs) || !data.jobs.length
    || data.jobs.some((job: any) => !positiveId(job?.id) || !positiveId(job?.device_id))
    || new Set(data.jobs.map((job: any) => job.id)).size !== data.jobs.length) {
    throw new Error(data?.error || 'No se pudo confirmar la lectura. Verifique si ya hay una lectura en curso antes de repetirla.')
  }
  return { id: data.batch_id, from, to, jobs: data.jobs.map((job: any) => ({
    id: job.id, device_id: job.device_id, batch_id: data.batch_id, status: 'queued',
  })) }
}

function readJob(data: any, previous: ClockJob): ClockJob {
  const job = data?.job
  if (data?.ok !== true || job?.id !== previous.id || job?.device_id !== previous.device_id
    || job?.batch_id !== previous.batch_id || !Object.hasOwn(labels, job?.status)) {
    throw new Error(data?.error || 'Respuesta de estado no válida')
  }
  return { ...job, status: job.status === 'success' && job.result?.partial === true ? 'partial' : job.status }
}

export default function ManualClockRead({ from, to, onFromChange, onToChange, onFinished }: {
  from: string
  to: string
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onFinished: () => void
}) {
  const [batch, setBatch] = useState<Batch | null>(null)
  const [jobs, setJobs] = useState<ClockJob[]>([])
  const [enqueuing, setEnqueuing] = useState(false)
  const [error, setError] = useState('')
  const [queryError, setQueryError] = useState('')
  const [cancelRequested, setCancelRequested] = useState<Record<number, boolean>>({})
  const mounted = useRef(false)
  const enqueuePending = useRef(false)
  const finished = useRef(onFinished)
  const active = enqueuing || jobs.some(job => !terminal(job))

  useEffect(() => { finished.current = onFinished }, [onFinished])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!batch) return
    let alive = true
    let current = batch.jobs
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    async function update() {
      const pending = current.filter(job => !terminal(job))
      const responses = await Promise.allSettled(pending.map(async job => {
        const response = await api.get(`/api/devices/sync-jobs/${job.id}`, {
          signal: controller.signal, timeout: 10000,
        })
        return readJob(response.data, job)
      }))
      if (!alive) return
      const updated = new Map<number, ClockJob>()
      let failed = false
      responses.forEach((response, index) => {
        if (response.status === 'fulfilled') updated.set(pending[index].id, response.value)
        else failed = true
      })
      current = current.map(job => updated.get(job.id) || job)
      setJobs(current)
      setQueryError(failed ? 'No se pudo actualizar el estado de uno o más relojes. Se volverá a consultar; la lectura continúa en el servidor.' : '')
      if (current.every(terminal)) finished.current()
      else timer = setTimeout(update, 3000)
    }

    void update()
    return () => { alive = false; clearTimeout(timer); controller.abort() }
  }, [batch])

  async function start() {
    if (active || enqueuePending.current) return
    setError('')
    if (!validDate(from) || !validDate(to)) { setError('Seleccione fechas válidas en Desde y Hasta.'); return }
    if (from > to) { setError('Desde debe ser anterior o igual a Hasta.'); return }
    enqueuePending.current = true
    setEnqueuing(true)
    try {
      const response = await api.post('/api/devices/sync-jobs', { from, to, attempts: 2 }, { timeout: 15000 })
      const next = readBatch(response.data, from, to)
      if (!mounted.current) return
      setJobs(next.jobs)
      setCancelRequested({})
      setQueryError('')
      setBatch(next)
    } catch (cause: any) {
      if (mounted.current) setError(cause?.response?.data?.error || (
        cause?.code === 'ECONNABORTED' || cause?.response?.status === 504
          ? 'No se pudo confirmar la solicitud. Verifique si ya hay una lectura en curso antes de repetirla.'
          : cause?.message || 'No se pudo solicitar la lectura.'
      ))
    } finally {
      enqueuePending.current = false
      if (mounted.current) setEnqueuing(false)
    }
  }

  async function cancel(job: ClockJob) {
    setCancelRequested(previous => ({ ...previous, [job.id]: true }))
    setError('')
    try {
      const response = await api.post(`/api/devices/sync-jobs/${job.id}/cancel`)
      if (response.data?.ok !== true) throw new Error(response.data?.error || response.data?.message || 'No se pudo solicitar la cancelación.')
    } catch (cause: any) {
      if (!mounted.current) return
      setCancelRequested(previous => ({ ...previous, [job.id]: false }))
      setError(cause?.response?.data?.error || cause?.message || 'No se pudo solicitar la cancelación.')
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="clock-read-from" className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Desde</label>
          <input id="clock-read-from" type="date" value={from} disabled={active} onChange={event => onFromChange(event.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent disabled:opacity-50" />
        </div>
        <div>
          <label htmlFor="clock-read-to" className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Hasta</label>
          <input id="clock-read-to" type="date" value={to} disabled={active} onChange={event => onToChange(event.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent disabled:opacity-50" />
        </div>
        <button onClick={start} disabled={active} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm flex items-center gap-2 disabled:opacity-50">
          <Cpu size={15} /> {enqueuing ? 'Solicitando lectura…' : active ? 'Leyendo relojes…' : 'Leer relojes del rango'}
        </button>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-white/40 mt-2">
        La lectura continúa en el servidor aunque cierre esta pantalla. Puede revisar el estado de los equipos en <a href="/configuracion?tab=relojes" className="underline">Relojes</a>.
      </p>
      {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-300 mt-3">{error}</p>}
      {queryError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300 mt-3">{queryError}</p>}
      {batch && (
        <div className="mt-3 space-y-2">
          <p role="status" className="text-sm text-slate-600 dark:text-white/70">
            {batch.from} → {batch.to} · {jobs.filter(terminal).length} de {jobs.length} relojes finalizados.
          </p>
          <ul className="space-y-2">
            {jobs.map(job => {
              const name = job.device_name || `Reloj #${job.device_id}`
              const requested = cancelRequested[job.id] || !!job.cancel_requested
              const warning = ['partial', 'error', 'cancelled'].includes(job.status)
              return (
                <li key={job.id} aria-label={name} className={`rounded-xl border p-3 ${warning ? 'border-amber-200 dark:border-amber-400/30' : 'border-slate-200 dark:border-white/[0.08]'}`}>
                  <div className="flex justify-between items-center flex-wrap gap-2 text-sm">
                    <div className="text-slate-700 dark:text-white/80"><span className="font-semibold">{name}</span> · <span>{labels[job.status]}</span></div>
                    {!terminal(job) && <button onClick={() => cancel(job)} disabled={requested} aria-label={`Cancelar lectura de ${name}`}
                      className="text-xs text-slate-500 underline disabled:opacity-50 dark:text-white/50">
                      {requested ? 'Cancelación solicitada' : 'Cancelar lectura'}
                    </button>}
                  </div>
                  {job.progress && !terminal(job) && <p className="text-xs text-slate-500 dark:text-white/40 mt-1">{job.progress}</p>}
                  {job.error && <p className="text-xs text-rose-600 dark:text-rose-300 mt-1">{job.error}</p>}
                  {job.status === 'partial' && <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">No se confirma la cobertura completa del período. Revise este reloj antes de usar sus datos para calcular horas.</p>}
                  {terminal(job) && <p className="text-xs text-slate-500 dark:text-white/40 mt-1">
                    Leídas: {count(job.result?.total_read)} · En rango: {count(job.result?.in_range)} · Importadas: {count(job.result?.imported)} · Duplicadas: {count(job.result?.skipped)} · Sin empleado: {count(job.result?.notFound)}
                  </p>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
