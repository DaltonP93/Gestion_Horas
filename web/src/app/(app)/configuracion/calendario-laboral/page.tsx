'use client'
/**
 * Calendario laboral — autoría + resolutor (FASE F3 + UI de writers F+).
 *
 * Superficie de UI para los writers ya existentes y fail-closed
 * (CALENDAR_WRITE_ENABLED): crear calendario versionado por alcance y agregar
 * excepciones por fecha. Además conserva el resolutor de días efectivos
 * (sólo lectura) y la lista de calendarios.
 *
 * No recalcula asistencia ni jornada; sólo estructura el calendario. Toda
 * escritura respeta el 503 fail-closed sin romper la vista; las acciones se
 * ofrecen a roles de gestión (el permiso y el alcance reales los impone la API:
 * 403 OUT_OF_SCOPE / 400 INCOHERENT_SCOPE / INVALID_DATE, etc.).
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Search, Plus, X, CheckCircle, AlertTriangle, CalendarPlus } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface LaborCalendar {
  id: number; code: string; name: string; company_id: number | null; branch_id: number | null
  timezone: string; week_start: number; work_days: string | null; active: number
  valid_from: string; valid_to: string | null
}
interface EffectiveDay { date: string; working: boolean; reason: string }
interface CalException { id: number; calendar_id: number; day: string; kind: string; label: string | null }
interface Ref { id: number; name: string }

const REASON_LABEL: Record<string, string> = {
  workday: 'Laborable', special: 'Especial', sunday: 'Domingo', rest_day: 'Descanso',
  holiday: 'Feriado', exception_working: 'Excepción laborable', exception_nonworking: 'Excepción no laborable',
}
const KIND_LABEL: Record<string, string> = { nonworking: 'No laborable', working: 'Laborable', special: 'Especial' }
const DAY_LABELS = [
  { v: 1, l: 'Lun' }, { v: 2, l: 'Mar' }, { v: 3, l: 'Mié' }, { v: 4, l: 'Jue' },
  { v: 5, l: 'Vie' }, { v: 6, l: 'Sáb' }, { v: 7, l: 'Dom' },
]
const WRITE_ROLES = ['super_admin', 'admin', 'gth', 'hr']
const emptyCal = { code: '', name: '', company_id: '', branch_id: '', timezone: 'America/Asuncion', work_days: [1, 2, 3, 4, 5] as number[], valid_from: '', valid_to: '' }
const emptyExc = { day: '', kind: 'nonworking' as string, label: '' }

const inputCls = 'border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08] bg-white dark:bg-transparent'

function scopeLabel(c: LaborCalendar): string {
  if (c.branch_id != null) return `Sucursal #${c.branch_id}`
  if (c.company_id != null) return `Empresa #${c.company_id}`
  return 'Global'
}

export default function CalendarioLaboralPage() {
  const user = useCurrentUser()
  const canWrite = WRITE_ROLES.includes(String(user?.role || ''))

  const [cals, setCals] = useState<LaborCalendar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const [selected, setSelected] = useState<string>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [days, setDays] = useState<EffectiveDay[] | null>(null)
  const [resolving, setResolving] = useState(false)

  const [companies, setCompanies] = useState<Ref[]>([])
  const [branches, setBranches] = useState<Ref[]>([])
  const [showCalForm, setShowCalForm] = useState(false)
  const [cal, setCal] = useState({ ...emptyCal })
  const [calErr, setCalErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [excFor, setExcFor] = useState<LaborCalendar | null>(null)
  const [exceptions, setExceptions] = useState<CalException[]>([])
  const [exc, setExc] = useState({ ...emptyExc })
  const [excErr, setExcErr] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const data = await api.get('/api/labor-calendars').then(r => (r.data?.data ?? []) as LaborCalendar[])
      setCals(data)
      if (data.length && !selected) setSelected(String(data[0].id))
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!canWrite) return
    api.get('/api/companies').then(r => setCompanies(r.data?.data ?? [])).catch(() => setCompanies([]))
    api.get('/api/branches').then(r => setBranches(r.data ?? [])).catch(() => setBranches([]))
  }, [canWrite])
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 3500)
    return () => clearTimeout(t)
  }, [feedback])

  function writerError(e: any): string {
    const status = e?.response?.status
    const code = e?.response?.data?.code
    const msg = e?.response?.data?.error
    if (status === 503 || code === 'CALENDAR_WRITES_DISABLED') {
      return 'La configuración de calendario está en modo sólo lectura durante el rollout. No se registraron cambios.'
    }
    if (code === 'OUT_OF_SCOPE') return msg || 'Fuera de tu alcance.'
    return msg || 'No se pudo completar la operación.'
  }

  async function resolve() {
    if (!selected || !from || !to) return
    setResolving(true); setError('')
    try {
      const r = await api.get(`/api/labor-calendars/${selected}/effective`, { params: { from, to } })
      setDays((r.data?.days ?? []) as EffectiveDay[])
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al resolver')
      setDays(null)
    } finally { setResolving(false) }
  }

  function toggleDay(d: number) {
    setCal(c => ({ ...c, work_days: c.work_days.includes(d) ? c.work_days.filter(x => x !== d) : [...c.work_days, d].sort() }))
  }

  async function createCalendar() {
    setCalErr(null)
    if (!cal.code.trim() || !cal.name.trim() || !cal.valid_from) { setCalErr('Completá código, nombre y vigencia desde.'); return }
    if (cal.valid_to && cal.valid_to < cal.valid_from) { setCalErr('La vigencia hasta no puede ser anterior a desde.'); return }
    setBusy(true)
    try {
      await api.post('/api/labor-calendars', {
        code: cal.code.trim(), name: cal.name.trim(),
        company_id: cal.company_id ? Number(cal.company_id) : null,
        branch_id: cal.branch_id ? Number(cal.branch_id) : null,
        timezone: cal.timezone || 'America/Asuncion',
        work_days: cal.work_days.join(','),
        valid_from: cal.valid_from, valid_to: cal.valid_to || null,
      })
      setShowCalForm(false); setCal({ ...emptyCal }); setFeedback('Calendario creado.')
      await load()
    } catch (e: any) {
      setCalErr(writerError(e))
    } finally { setBusy(false) }
  }

  async function openExceptions(c: LaborCalendar) {
    setExcFor(c); setExceptions([]); setExc({ ...emptyExc }); setExcErr(null)
    try {
      const r = await api.get(`/api/labor-calendars/${c.id}/exceptions`)
      setExceptions((r.data?.data ?? []) as CalException[])
    } catch (e: any) {
      setExcErr(e?.response?.data?.error || 'No se pudieron cargar las excepciones.')
    }
  }

  async function addException() {
    if (!excFor) return
    setExcErr(null)
    if (!exc.day) { setExcErr('Indicá la fecha.'); return }
    setBusy(true)
    try {
      await api.post(`/api/labor-calendars/${excFor.id}/exceptions`, {
        day: exc.day, kind: exc.kind, label: exc.label.trim() || null,
      })
      setExc({ ...emptyExc }); setFeedback('Excepción registrada.')
      await openExceptions(excFor)
    } catch (e: any) {
      setExcErr(writerError(e))
    } finally { setBusy(false) }
  }

  const selectedCal = useMemo(() => cals.find(c => String(c.id) === selected), [cals, selected])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center">
          <CalendarRange className="text-white" size={22} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Calendario laboral</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Calendarios versionados por alcance, excepciones y resolutor de días efectivos.</p>
        </div>
        {canWrite && (
          <button onClick={() => { setShowCalForm(s => !s); setCalErr(null) }}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700">
            <Plus size={15} /> Nuevo calendario
          </button>
        )}
      </div>

      {feedback && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white/80">
          <CheckCircle size={15} className="text-emerald-500" /> <span className="flex-1">{feedback}</span>
          <button onClick={() => setFeedback(null)} aria-label="Cerrar aviso"><X size={14} /></button>
        </div>
      )}
      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      {showCalForm && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5 space-y-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-white/80">Nuevo calendario versionado</h2>
          {calErr && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/[0.06] dark:text-red-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{calErr}</span>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Código *</span>
              <input value={cal.code} maxLength={40} onChange={e => setCal(c => ({ ...c, code: e.target.value }))} placeholder="ej: STD-2026" className={`mt-1 w-full ${inputCls}`} /></label>
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Nombre *</span>
              <input value={cal.name} maxLength={200} onChange={e => setCal(c => ({ ...c, name: e.target.value }))} placeholder="ej: Estándar 2026" className={`mt-1 w-full ${inputCls}`} /></label>
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Empresa (alcance)</span>
              <select value={cal.company_id} onChange={e => setCal(c => ({ ...c, company_id: e.target.value }))} className={`mt-1 w-full ${inputCls}`}>
                <option value="">Global</option>
                {companies.map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
              </select></label>
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Sucursal (alcance)</span>
              <select value={cal.branch_id} onChange={e => setCal(c => ({ ...c, branch_id: e.target.value }))} className={`mt-1 w-full ${inputCls}`}>
                <option value="">—</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></label>
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Zona horaria</span>
              <input value={cal.timezone} maxLength={64} onChange={e => setCal(c => ({ ...c, timezone: e.target.value }))} className={`mt-1 w-full ${inputCls}`} /></label>
            <div className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Días laborables</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {DAY_LABELS.map(d => (
                  <button key={d.v} type="button" onClick={() => toggleDay(d.v)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${cal.work_days.includes(d.v)
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-slate-200 text-slate-600 dark:border-white/[0.08] dark:text-white/60'}`}>{d.l}</button>
                ))}
              </div>
            </div>
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Vigente desde *</span>
              <input type="date" value={cal.valid_from} onChange={e => setCal(c => ({ ...c, valid_from: e.target.value }))} className={`mt-1 w-full ${inputCls}`} /></label>
            <label className="block"><span className="text-xs font-medium text-slate-600 dark:text-white/60">Vigente hasta</span>
              <input type="date" value={cal.valid_to} min={cal.valid_from || undefined} onChange={e => setCal(c => ({ ...c, valid_to: e.target.value }))} className={`mt-1 w-full ${inputCls}`} /></label>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowCalForm(false); setCal({ ...emptyCal }); setCalErr(null) }}
              className="border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
            <button onClick={createCalendar} disabled={busy}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-60">
              <CheckCircle size={14} /> {busy ? 'Guardando…' : 'Crear calendario'}
            </button>
          </div>
        </div>
      )}

      {/* Lista de calendarios */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">Calendarios</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Código</th><th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Alcance</th><th className="px-4 py-3">Vigencia</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {loading && <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>}
              {!loading && cals.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Sin calendarios</td></tr>}
              {cals.map(c => (
                <tr key={c.id}>
                  <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{c.code}</td>
                  <td className="px-4 py-2 text-slate-600 dark:text-white/60">{c.name}</td>
                  <td className="px-4 py-2 text-slate-500 dark:text-white/50">{scopeLabel(c)}</td>
                  <td className="px-4 py-2 text-slate-500 dark:text-white/50">{c.valid_from}{c.valid_to ? ` → ${c.valid_to}` : ' →'}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => openExceptions(c)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-white/[0.08] dark:text-white/60 dark:hover:bg-white/[0.04]">
                      <CalendarPlus size={12} /> Excepciones
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Panel de excepciones del calendario seleccionado */}
      {excFor && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">
              Excepciones · {excFor.code}
            </h2>
            <button onClick={() => setExcFor(null)} aria-label="Cerrar" className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={16} /></button>
          </div>
          {excErr && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/[0.06] dark:text-red-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{excErr}</span>
            </div>
          )}
          {canWrite && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm"><span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Fecha</span>
                <input type="date" value={exc.day} onChange={e => setExc(x => ({ ...x, day: e.target.value }))} className={inputCls} /></label>
              <label className="text-sm"><span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Tipo</span>
                <select value={exc.kind} onChange={e => setExc(x => ({ ...x, kind: e.target.value }))} className={inputCls}>
                  <option value="nonworking">No laborable</option>
                  <option value="working">Laborable</option>
                  <option value="special">Especial</option>
                </select></label>
              <label className="text-sm flex-1 min-w-[8rem]"><span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Etiqueta</span>
                <input value={exc.label} maxLength={200} onChange={e => setExc(x => ({ ...x, label: e.target.value }))} placeholder="Opcional" className={`w-full ${inputCls}`} /></label>
              <button onClick={addException} disabled={busy}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60">
                <Plus size={15} /> Agregar
              </button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
                <tr><th className="px-4 py-2">Fecha</th><th className="px-4 py-2">Tipo</th><th className="px-4 py-2">Etiqueta</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {exceptions.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-slate-400 dark:text-white/30">Sin excepciones</td></tr>}
                {exceptions.map(x => (
                  <tr key={x.id}>
                    <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{x.day}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-white/60">{KIND_LABEL[x.kind] || x.kind}</td>
                    <td className="px-4 py-2 text-slate-500 dark:text-white/50">{x.label || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Resolutor de rango efectivo (sólo lectura) */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">Consultar rango efectivo</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Calendario</span>
            <select value={selected} onChange={e => setSelected(e.target.value)} className={inputCls}>
              {loading && <option>Cargando…</option>}
              {!loading && cals.length === 0 && <option value="">Sin calendarios</option>}
              {cals.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Desde</span>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1 dark:text-white/50">Hasta</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className={inputCls} />
          </label>
          <button onClick={resolve} disabled={resolving || !selected || !from || !to}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60">
            <Search size={16} /> {resolving ? 'Resolviendo…' : 'Resolver'}
          </button>
          {selectedCal && <span className="text-xs text-slate-400 dark:text-white/30">Alcance: {scopeLabel(selectedCal)}</span>}
        </div>
      </div>

      {days && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Motivo</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {days.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-slate-400 dark:text-white/30">Sin resultados</td></tr>}
              {days.map(d => (
                <tr key={d.date}>
                  <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{d.date}</td>
                  <td className="px-4 py-2">
                    {d.working
                      ? <span className="text-emerald-600 text-xs font-medium">Laborable</span>
                      : <span className="text-slate-400 text-xs">No laborable</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-white/50">{REASON_LABEL[d.reason] || d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
