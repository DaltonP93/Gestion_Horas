'use client'
/**
 * EmployeeWorkdayViewer — jornada efectiva del empleado por fecha (FASE F3, read-only).
 *
 * Consulta `GET /api/labor-calendars/workday/:empId?date=` (sólo lectura; no
 * recalcula asistencia ni jornada) y muestra el `schema_state` de 3 estados con
 * un mensaje CONTROLADO, nunca un error SQL crudo:
 *   - missing     → sin esquema de jornada migrado → histórico (fallback).
 *   - incomplete  → migración parcial → no se resuelve configurada (mensaje del server).
 *   - complete    → jornada resuelta: origen + campos conocidos, o fallback histórico.
 *
 * No escribe nada. Si la consulta falla (sin permiso / fuera de alcance), muestra
 * un aviso controlado sin romper la ficha.
 */

import { useState } from 'react'
import { CalendarClock, Search, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

type Workday = {
  source?: string
  config?: unknown
  work_regime?: string | null
  weekly_target_minutes?: number | null
  daily_target_minutes?: number | null
  check_in?: string | null
  check_out?: string | null
} | null

interface WorkdayResult {
  employee_id: number
  date: string
  schema_state: 'missing' | 'incomplete' | 'complete'
  workday: Workday
  message?: string
}

const SOURCE_LABEL: Record<string, string> = {
  historical_fallback: 'Histórico (fallback)',
  schedule_history: 'Horario con vigencia',
  turnera: 'Turnera (planificación)',
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}
function mins(v: number | null | undefined): string | null {
  if (v == null) return null
  const h = Math.floor(v / 60)
  const m = v % 60
  return `${h}:${String(m).padStart(2, '0')} h`
}

export default function EmployeeWorkdayViewer({ employeeId }: { employeeId: number }) {
  const [date, setDate] = useState(today())
  const [res, setRes] = useState<WorkdayResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function consult() {
    if (!date) return
    setBusy(true); setErr(null); setRes(null)
    try {
      const data = await api.get(`/api/labor-calendars/workday/${employeeId}`, { params: { date } }).then(r => r.data as WorkdayResult)
      setRes(data)
    } catch (e: any) {
      const status = e?.response?.status
      setErr(status === 404
        ? 'Sin acceso a la jornada de este empleado (fuera de tu alcance).'
        : (e?.response?.data?.error || 'No se pudo consultar la jornada.'))
    } finally {
      setBusy(false)
    }
  }

  const wd = res?.workday
  const source = wd?.source
  const fields: { label: string; value: string }[] = []
  if (wd) {
    if (wd.work_regime) fields.push({ label: 'Régimen', value: String(wd.work_regime) })
    const daily = mins(wd.daily_target_minutes)
    if (daily) fields.push({ label: 'Objetivo diario', value: daily })
    const weekly = mins(wd.weekly_target_minutes)
    if (weekly) fields.push({ label: 'Objetivo semanal', value: weekly })
    if (wd.check_in) fields.push({ label: 'Entrada', value: String(wd.check_in).slice(0, 5) })
    if (wd.check_out) fields.push({ label: 'Salida', value: String(wd.check_out).slice(0, 5) })
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <CalendarClock size={18} className="text-indigo-600" />
          <h3 className="font-semibold text-slate-800 dark:text-white/90">Jornada efectiva</h3>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-slate-200 rounded-xl px-2 py-1 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
          <button onClick={consult} disabled={busy || !date}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
            <Search size={13} /> {busy ? 'Consultando…' : 'Consultar'}
          </button>
        </div>
      </div>

      <div className="p-5">
        {err && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.06] dark:text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{err}</span>
          </div>
        )}
        {!err && !res && (
          <p className="text-sm text-slate-400 dark:text-white/30">Elegí una fecha y consultá la jornada vigente.</p>
        )}
        {res && (
          <div className="space-y-3">
            {res.schema_state === 'incomplete' && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.06] dark:text-amber-200">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{res.message || 'Esquema de jornada parcialmente migrado; no se resuelve la jornada configurada.'}</span>
              </div>
            )}
            {res.schema_state !== 'incomplete' && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-slate-500 dark:text-white/50">Origen:</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-white/[0.06] dark:text-white/70">
                    {(source && SOURCE_LABEL[source]) || SOURCE_LABEL.historical_fallback}
                  </span>
                  {source === 'historical_fallback' && (
                    <span className="text-xs text-slate-400 dark:text-white/30">Sin configuración vigente: se usa el cálculo histórico.</span>
                  )}
                </div>
                {fields.length > 0 && (
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {fields.map(f => (
                      <div key={f.label} className="min-w-0">
                        <dt className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-white/40">{f.label}</dt>
                        <dd className="mt-0.5 text-sm font-medium text-slate-800 dark:text-white/90">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
            <p className="text-[11px] text-slate-400 dark:text-white/30">
              Vista de sólo lectura para la fecha {res.date}. No modifica asistencia ni jornada.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
