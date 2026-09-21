'use client'
/**
 * Configuración Laboral Histórica, Jerárquica y Masiva.
 *
 * Superficie de administración escalable para los DEFAULTS de jornada por
 * alcance (general / empresa / departamento) con vigencia histórica, más el
 * resolutor de "qué configuración efectiva tiene un empleado en una fecha"
 * (precedencia completa de 6 capas) y la importación masiva con preview/dry-run.
 *
 * INVARIANTES respetadas por la UI: no recalcula asistencia ni daily_summary;
 * toda escritura es fail-closed en la API (503 WORKDAY_CONFIG_WRITES_DISABLED)
 * y la importación exige un preview sin conflictos antes de aplicar. El alcance
 * y el permiso reales los impone la API (403/400); la UI sólo ofrece acciones.
 */
import { useEffect, useMemo, useState } from 'react'
import { SlidersHorizontal, Search, Plus, X, Upload, CheckCircle, AlertTriangle, Layers } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'
import {
  WorkdayDefaultRow, EffectiveHierarchical, DefaultForm, DefaultScope, CompanyRef, DeptRef,
  SCOPE_LABEL, DAY_LABELS, emptyDefaultForm, validateDefaultForm, defaultPayload,
  parseBulkItems, layerLabel, scopeSummary, companyLabel, unwrapList, bulkBlockingCount,
  versionIsOpen, canMutateVersion, formFromDefaultRow, supersedePayload, closePayload, mutationErrorMessage,
} from '@/lib/workdayDefaults'

const WRITE_ROLES = ['super_admin', 'admin', 'gth', 'hr']
const inputCls = 'border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-white/[0.08] bg-white dark:bg-transparent'

function today(): string { return new Date().toISOString().slice(0, 10) }
function t5(v: string | null | undefined): string { return v ? String(v).slice(0, 5) : '—' }
function vigencia(r: WorkdayDefaultRow): string {
  return `${String(r.valid_from).slice(0, 10)} → ${r.valid_to ? String(r.valid_to).slice(0, 10) : 'abierta'}`
}

export default function ConfiguracionLaboralPage() {
  const user = useCurrentUser()
  const canWrite = WRITE_ROLES.includes(String(user?.role || ''))

  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null)
  const [precedence, setPrecedence] = useState<string[]>([])
  const [rows, setRows] = useState<WorkdayDefaultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const [scopeFilter, setScopeFilter] = useState<'' | DefaultScope>('')
  const [companies, setCompanies] = useState<CompanyRef[]>([])
  const [departments, setDepartments] = useState<DeptRef[]>([])

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<DefaultForm>(emptyDefaultForm(today()))
  const [formErr, setFormErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Resolutor efectivo por empleado+fecha.
  const [empId, setEmpId] = useState('')
  const [effDate, setEffDate] = useState(today())
  const [eff, setEff] = useState<EffectiveHierarchical | null>(null)
  const [effErr, setEffErr] = useState<string | null>(null)
  const [effBusy, setEffBusy] = useState(false)

  // Importación masiva.
  const [bulkText, setBulkText] = useState('')
  const [bulkPreview, setBulkPreview] = useState<any | null>(null)
  const [bulkErr, setBulkErr] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  // Append-only (Corrección N): supersede / cerrar vigencia por versión abierta.
  const [superseding, setSuperseding] = useState<WorkdayDefaultRow | null>(null)
  const [supersedeDate, setSupersedeDate] = useState(today())
  const [supersedeForm, setSupersedeForm] = useState<DefaultForm>(emptyDefaultForm(today()))
  const [closingRow, setClosingRow] = useState<WorkdayDefaultRow | null>(null)
  const [closeTo, setCloseTo] = useState(today())
  const [closeReason, setCloseReason] = useState('')
  const [mutBusy, setMutBusy] = useState(false)
  const [mutErr, setMutErr] = useState<string | null>(null)
  const canMutate = (r: WorkdayDefaultRow) => canMutateVersion(r, { canWrite, writesEnabled: writesEnabled === true })

  function openSupersede(r: WorkdayDefaultRow) {
    setMutErr(null); setClosingRow(null)
    setSuperseding(r)
    setSupersedeDate(today())
    setSupersedeForm(formFromDefaultRow(r, today()))
  }
  function openClose(r: WorkdayDefaultRow) {
    setMutErr(null); setSuperseding(null)
    setClosingRow(r); setCloseTo(today()); setCloseReason('')
  }
  async function submitSupersede(e: React.FormEvent) {
    e.preventDefault(); setMutErr(null); setFeedback(null)
    if (!superseding) return
    let payload: ReturnType<typeof supersedePayload>
    try { payload = supersedePayload(supersedeDate, supersedeForm) } catch (err: any) { setMutErr(err.message); return }
    setMutBusy(true)
    try {
      await api.post(`/api/workday-config/defaults/${superseding.id}/supersede`, payload)
      setFeedback('Nueva versión creada; la anterior quedó cerrada.')
      setSuperseding(null)
      await loadDefaults()
    } catch (err) { setMutErr(mutationErrorMessage(err)) } finally { setMutBusy(false) }
  }
  async function submitClose(e: React.FormEvent) {
    e.preventDefault(); setMutErr(null); setFeedback(null)
    if (!closingRow) return
    let payload: ReturnType<typeof closePayload>
    try { payload = closePayload(closeTo, closeReason) } catch (err: any) { setMutErr(err.message); return }
    setMutBusy(true)
    try {
      await api.post(`/api/workday-config/defaults/${closingRow.id}/close`, payload)
      setFeedback('Vigencia cerrada.')
      setClosingRow(null)
      await loadDefaults()
    } catch (err) { setMutErr(mutationErrorMessage(err)) } finally { setMutBusy(false) }
  }

  async function loadMeta() {
    try {
      const r = await api.get('/api/workday-config/precedence')
      setPrecedence(r.data?.data?.precedence || [])
      setWritesEnabled(!!r.data?.data?.writes_enabled)
    } catch { /* la lista sigue siendo útil sin meta */ }
  }

  async function loadDefaults() {
    setLoading(true); setError('')
    try {
      const params: Record<string, string> = {}
      if (scopeFilter) params.scope = scopeFilter
      const r = await api.get('/api/workday-config/defaults', { params })
      setRows((r.data?.data ?? []) as WorkdayDefaultRow[])
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }

  useEffect(() => { loadMeta() }, [])
  useEffect(() => { loadDefaults() }, [scopeFilter])
  useEffect(() => {
    if (!canWrite) return
    // /api/companies → { data: [...] }; /api/departments → [ ... ] (array directo).
    api.get('/api/companies').then(r => setCompanies(unwrapList<CompanyRef>(r.data))).catch(() => setCompanies([]))
    api.get('/api/departments').then(r => setDepartments(unwrapList<DeptRef>(r.data))).catch(() => setDepartments([]))
  }, [canWrite])

  function toggleDay(d: number) {
    setForm(f => ({ ...f, work_days: f.work_days.includes(d) ? f.work_days.filter(x => x !== d) : [...f.work_days, d].sort((a, b) => a - b) }))
  }

  const formErrors = useMemo(() => validateDefaultForm(form), [form])

  async function submitForm(e: React.FormEvent) {
    e.preventDefault()
    setFormErr(null); setFeedback(null)
    let payload: ReturnType<typeof defaultPayload>
    try { payload = defaultPayload(form) } catch (err: any) { setFormErr(err.message); return }
    setBusy(true)
    try {
      await api.post('/api/workday-config/defaults', payload)
      setFeedback('Default creado.')
      setShowForm(false)
      setForm(emptyDefaultForm(today()))
      await loadDefaults()
    } catch (err: any) {
      const code = err?.response?.data?.code
      if (err?.response?.status === 503) setFormErr('Escrituras deshabilitadas (fail-closed). Requiere activar WORKDAY_CONFIG_WRITE_ENABLED.')
      else setFormErr(err?.response?.data?.error || code || err?.message || 'No se pudo crear')
    } finally { setBusy(false) }
  }

  async function resolveEffective(e: React.FormEvent) {
    e.preventDefault()
    setEffErr(null); setEff(null)
    const id = Number(empId)
    if (!Number.isInteger(id) || id <= 0) { setEffErr('ID de empleado inválido.'); return }
    setEffBusy(true)
    try {
      const r = await api.get(`/api/workday-config/employees/${id}/effective-hierarchical`, { params: { date: effDate } })
      setEff(r.data?.data as EffectiveHierarchical)
    } catch (err: any) {
      setEffErr(err?.response?.data?.error || err?.message || 'No se pudo resolver')
    } finally { setEffBusy(false) }
  }

  async function runBulkPreview() {
    setBulkErr(null); setBulkPreview(null)
    let items: Record<string, unknown>[]
    try { items = parseBulkItems(bulkText) } catch (err: any) { setBulkErr(err.message); return }
    if (!items.length) { setBulkErr('Pegá al menos un ítem (JSON array o NDJSON).'); return }
    setBulkBusy(true)
    try {
      const r = await api.post('/api/workday-config/defaults/bulk/preview', { items })
      setBulkPreview(r.data?.data)
    } catch (err: any) {
      setBulkErr(err?.response?.data?.error || err?.message || 'Error en el preview')
    } finally { setBulkBusy(false) }
  }

  async function applyBulk() {
    setBulkErr(null); setFeedback(null)
    let items: Record<string, unknown>[]
    try { items = parseBulkItems(bulkText) } catch (err: any) { setBulkErr(err.message); return }
    setBulkBusy(true)
    try {
      const r = await api.post('/api/workday-config/defaults/bulk/apply', { items })
      setFeedback(`Importación aplicada: ${r.data?.data?.applied ?? 0} default(s).`)
      setBulkPreview(null); setBulkText('')
      await loadDefaults()
    } catch (err: any) {
      if (err?.response?.status === 503) setBulkErr('Escrituras deshabilitadas (fail-closed).')
      else if (err?.response?.data?.code === 'BULK_HAS_CONFLICTS') setBulkErr('El preview tiene conflictos; resolvelos antes de aplicar.')
      else setBulkErr(err?.response?.data?.error || err?.message || 'No se pudo aplicar')
    } finally { setBulkBusy(false) }
  }

  const bulkBlocking = bulkPreview ? bulkBlockingCount(bulkPreview.results) : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-6 h-6 text-indigo-600" />
          <div>
            <h1 className="text-xl font-semibold">Configuración laboral histórica y jerárquica</h1>
            <p className="text-sm text-slate-500">Defaults por alcance (general / empresa / departamento) con vigencia y precedencia auditable.</p>
          </div>
        </div>
        {canWrite && (
          <button onClick={() => { setShowForm(v => !v); setFormErr(null) }} className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700">
            <Plus className="w-4 h-4" /> Nuevo default
          </button>
        )}
      </div>

      {writesEnabled === false && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10">
          <AlertTriangle className="w-4 h-4" /> Modo sólo lectura: las escrituras de configuración están deshabilitadas (fail-closed). Podés previsualizar sin aplicar.
        </div>
      )}
      {feedback && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10">
          <CheckCircle className="w-4 h-4" /> {feedback}
        </div>
      )}

      {/* Precedencia */}
      {precedence.length > 0 && (
        <div className="rounded-2xl border border-slate-200 p-4 dark:border-white/[0.08]">
          <div className="flex items-center gap-2 mb-2 text-sm font-medium"><Layers className="w-4 h-4 text-indigo-600" /> Precedencia (mayor → menor)</div>
          <ol className="flex flex-wrap gap-2 text-xs">
            {precedence.map((p, i) => (
              <li key={p} className="rounded-lg bg-slate-100 px-2 py-1 dark:bg-white/[0.06]">{i + 1}. {layerLabel(p)}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Resolutor efectivo */}
      <div className="rounded-2xl border border-slate-200 p-4 dark:border-white/[0.08]">
        <div className="text-sm font-medium mb-3">Jornada efectiva por empleado y fecha</div>
        <form onSubmit={resolveEffective} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">ID empleado
            <input value={empId} onChange={e => setEmpId(e.target.value)} className={`${inputCls} block mt-1 w-32`} placeholder="123" inputMode="numeric" />
          </label>
          <label className="text-sm">Fecha
            <input type="date" value={effDate} onChange={e => setEffDate(e.target.value)} className={`${inputCls} block mt-1`} />
          </label>
          <button type="submit" disabled={effBusy} className="inline-flex items-center gap-1 rounded-xl border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-white/[0.12] dark:hover:bg-white/[0.04]">
            <Search className="w-4 h-4" /> {effBusy ? 'Resolviendo…' : 'Resolver'}
          </button>
        </form>
        {effErr && <p className="mt-2 text-sm text-rose-600">{effErr}</p>}
        {eff && (
          <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm dark:bg-white/[0.04]">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span><b>Capa:</b> {layerLabel(eff.layer)}</span>
              <span><b>Modo:</b> {eff.calculation_mode}</span>
              <span><b>Depto:</b> {eff.scope?.department_id ?? '—'} {eff.scope?.scope_source === 'current_fallback' ? '(actual, sin asignación vigente)' : ''}</span>
              <span><b>Empresa:</b> {eff.scope?.company_id ?? '—'}</span>
              <span><b>Contrato:</b> {eff.contract_id ?? '—'}</span>
            </div>
            {eff.config && (
              <div className="mt-2 text-slate-600 dark:text-slate-300">
                Entrada {t5(eff.config.check_in as string)} · Salida {t5(eff.config.check_out as string)}
                {eff.config.night_start ? ` · Nocturno ${t5(eff.config.night_start as string)}–${t5(eff.config.night_end as string)}` : ''}
              </div>
            )}
            <div className="mt-2 text-xs text-slate-500">Considerado: {(eff.precedence_considered || []).map(layerLabel).join(' → ')}</div>
          </div>
        )}
      </div>

      {/* Alta de default */}
      {canWrite && showForm && (
        <form onSubmit={submitForm} className="rounded-2xl border border-slate-200 p-4 space-y-3 dark:border-white/[0.08]">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Nuevo default de jornada</div>
            <button type="button" onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-sm">Alcance
              <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value as DefaultScope }))} className={`${inputCls} block mt-1 w-full`}>
                {(['general', 'company', 'department'] as DefaultScope[]).map(s => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
              </select>
            </label>
            {form.scope === 'company' && (
              <label className="text-sm">Empresa
                <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))} className={`${inputCls} block mt-1 w-full`}>
                  <option value="">—</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
                </select>
              </label>
            )}
            {form.scope === 'department' && (
              <label className="text-sm">Departamento
                <select value={form.department_id} onChange={e => setForm(f => ({ ...f, department_id: e.target.value }))} className={`${inputCls} block mt-1 w-full`}>
                  <option value="">—</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            <label className="text-sm">Etiqueta (opcional)
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} className={`${inputCls} block mt-1 w-full`} placeholder="Turno estándar" />
            </label>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-sm">Vigente desde
              <input type="date" value={form.valid_from} onChange={e => setForm(f => ({ ...f, valid_from: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
            </label>
            <label className="text-sm">Vigente hasta
              <input type="date" value={form.valid_to} onChange={e => setForm(f => ({ ...f, valid_to: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
            </label>
            <label className="text-sm">Entrada
              <input type="time" value={form.check_in} onChange={e => setForm(f => ({ ...f, check_in: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
            </label>
            <label className="text-sm">Salida
              <input type="time" value={form.check_out} onChange={e => setForm(f => ({ ...f, check_out: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
            </label>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-sm">Tolerancia entrada
              <input value={form.tolerance_in} onChange={e => setForm(f => ({ ...f, tolerance_in: e.target.value }))} className={`${inputCls} block mt-1 w-full`} inputMode="numeric" />
            </label>
            <label className="text-sm">Tolerancia salida
              <input value={form.tolerance_out} onChange={e => setForm(f => ({ ...f, tolerance_out: e.target.value }))} className={`${inputCls} block mt-1 w-full`} inputMode="numeric" />
            </label>
            <label className="text-sm">Nocturno desde
              <input type="time" value={form.night_start} onChange={e => setForm(f => ({ ...f, night_start: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
            </label>
            <label className="text-sm">Nocturno hasta
              <input type="time" value={form.night_end} onChange={e => setForm(f => ({ ...f, night_end: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
            </label>
          </div>
          <div className="text-sm">
            <span className="block mb-1">Días laborables</span>
            <div className="flex flex-wrap gap-1">
              {[1, 2, 3, 4, 5, 6, 7].map(d => (
                <button type="button" key={d} onClick={() => toggleDay(d)}
                  className={`rounded-lg px-2 py-1 text-xs border ${form.work_days.includes(d) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-300 dark:border-white/[0.12]'}`}>
                  {DAY_LABELS[d]}
                </button>
              ))}
            </div>
          </div>
          <label className="text-sm block">Motivo del cambio (auditoría)
            <input value={form.change_reason} onChange={e => setForm(f => ({ ...f, change_reason: e.target.value }))} className={`${inputCls} block mt-1 w-full`} placeholder="Ej: alta de política 2026" />
          </label>
          {formErrors.length > 0 && <p className="text-xs text-amber-600">{formErrors[0]}</p>}
          {formErr && <p className="text-sm text-rose-600">{formErr}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || formErrors.length > 0} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Guardando…' : 'Crear default'}
            </button>
          </div>
        </form>
      )}

      {/* Importación masiva */}
      {canWrite && (
        <div className="rounded-2xl border border-slate-200 p-4 dark:border-white/[0.08]">
          <div className="flex items-center gap-2 text-sm font-medium mb-2"><Upload className="w-4 h-4 text-indigo-600" /> Importación masiva (preview / dry-run)</div>
          <p className="text-xs text-slate-500 mb-2">Pegá un array JSON o NDJSON de defaults. El preview no escribe nada; aplicar exige cero conflictos.</p>
          <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={5} className={`${inputCls} w-full font-mono text-xs`}
            placeholder='[{"scope":"department","department_id":5,"valid_from":"2026-01-01","check_in":"08:00","check_out":"17:00","work_days":[2,3,4,5,6]}]' />
          <div className="flex flex-wrap gap-2 mt-2">
            <button onClick={runBulkPreview} disabled={bulkBusy} className="rounded-xl border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-white/[0.12] dark:hover:bg-white/[0.04]">
              {bulkBusy ? 'Procesando…' : 'Previsualizar'}
            </button>
            <button onClick={applyBulk} disabled={bulkBusy || !bulkPreview || bulkBlocking > 0} className="rounded-xl bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
              Aplicar
            </button>
          </div>
          {bulkErr && <p className="mt-2 text-sm text-rose-600">{bulkErr}</p>}
          {bulkPreview && (
            <div className="mt-3 text-sm">
              <div className="mb-1">Total {bulkPreview.total} · {Object.entries(bulkPreview.summary || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
              <div className="max-h-56 overflow-auto rounded-xl border border-slate-200 dark:border-white/[0.08]">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-white/[0.04]"><tr><th className="p-2 text-left">#</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Alcance</th><th className="p-2 text-left">Vigencia</th><th className="p-2 text-left">Mensajes</th></tr></thead>
                  <tbody>
                    {(bulkPreview.results || []).map((r: any) => (
                      <tr key={r.index} className="border-t border-slate-100 dark:border-white/[0.06]">
                        <td className="p-2">{r.index}</td>
                        <td className={`p-2 ${r.status === 'ok' ? 'text-emerald-600' : r.status === 'incomplete' ? 'text-amber-600' : 'text-rose-600'}`}>{r.status}</td>
                        <td className="p-2">{r.scope_key ?? '—'}</td>
                        <td className="p-2">{r.valid_from ? `${r.valid_from} → ${r.valid_to || 'abierta'}` : '—'}</td>
                        <td className="p-2">{(r.messages || []).join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {bulkBlocking > 0 && <p className="mt-1 text-xs text-rose-600">{bulkBlocking} fila(s) bloquean la aplicación (invalid / incomplete / overlap).</p>}
            </div>
          )}
        </div>
      )}

      {/* Listado de defaults */}
      <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08]">
        <div className="flex items-center justify-between gap-2 p-3 border-b border-slate-100 dark:border-white/[0.06]">
          <div className="text-sm font-medium">Defaults por alcance</div>
          <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value as any)} className={`${inputCls} text-sm`}>
            <option value="">Todos los alcances</option>
            <option value="general">General</option>
            <option value="company">Empresa</option>
            <option value="department">Departamento</option>
          </select>
        </div>
        {loading ? (
          <div className="p-6 text-sm text-slate-500">Cargando…</div>
        ) : error ? (
          <div className="p-6 text-sm text-rose-600">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">Sin defaults configurados.</div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-white/[0.04]">
                <tr>
                  <th className="p-2 text-left">Alcance</th><th className="p-2 text-left">Etiqueta</th>
                  <th className="p-2 text-left">Vigencia</th><th className="p-2 text-left">Horario</th>
                  <th className="p-2 text-left">Días</th><th className="p-2 text-left">v</th>
                  <th className="p-2 text-left">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-white/[0.06]">
                    <td className="p-2">{scopeSummary(r)}</td>
                    <td className="p-2">{r.label || '—'}</td>
                    <td className="p-2">{vigencia(r)}{!versionIsOpen(r) && <span className="ml-1 text-xs text-slate-400">(cerrada)</span>}</td>
                    <td className="p-2">{t5(r.check_in)}–{t5(r.check_out)}{r.night_start ? ` · noct ${t5(r.night_start)}–${t5(r.night_end)}` : ''}</td>
                    <td className="p-2">{(r.work_days || '').split(',').filter(Boolean).map(d => DAY_LABELS[Number(d)]).join(' ')}</td>
                    <td className="p-2">{r.config_version ?? 1}</td>
                    <td className="p-2">
                      {canMutate(r) ? (
                        <div className="flex gap-2">
                          <button onClick={() => openSupersede(r)} className="text-xs text-indigo-600 hover:underline" data-testid={`supersede-${r.id}`}>Nueva versión</button>
                          <button onClick={() => openClose(r)} className="text-xs text-slate-600 hover:underline" data-testid={`close-${r.id}`}>Cerrar vigencia</button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">{versionIsOpen(r) ? '—' : 'histórica'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Nueva versión (supersede, append-only) */}
      {superseding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <form onSubmit={submitSupersede} className="w-full max-w-lg rounded-2xl bg-white p-4 space-y-3 dark:bg-slate-900 max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Nueva versión — {scopeSummary(superseding)}</div>
              <button type="button" onClick={() => setSuperseding(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-slate-500">Crea una versión nueva desde la fecha indicada; la versión vigente se cierra el día anterior. El pasado no se modifica.</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <label className="text-sm">Vigente desde
                <input type="date" value={supersedeDate} onChange={e => setSupersedeDate(e.target.value)} className={`${inputCls} block mt-1 w-full`} />
              </label>
              <label className="text-sm">Entrada
                <input type="time" value={supersedeForm.check_in} onChange={e => setSupersedeForm(f => ({ ...f, check_in: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
              </label>
              <label className="text-sm">Salida
                <input type="time" value={supersedeForm.check_out} onChange={e => setSupersedeForm(f => ({ ...f, check_out: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
              </label>
              <label className="text-sm">Nocturno desde
                <input type="time" value={supersedeForm.night_start} onChange={e => setSupersedeForm(f => ({ ...f, night_start: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
              </label>
              <label className="text-sm">Nocturno hasta
                <input type="time" value={supersedeForm.night_end} onChange={e => setSupersedeForm(f => ({ ...f, night_end: e.target.value }))} className={`${inputCls} block mt-1 w-full`} />
              </label>
            </div>
            <div className="text-sm">
              <span className="block mb-1">Días laborables</span>
              <div className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5, 6, 7].map(d => (
                  <button type="button" key={d} onClick={() => setSupersedeForm(f => ({ ...f, work_days: f.work_days.includes(d) ? f.work_days.filter(x => x !== d) : [...f.work_days, d].sort((a, b) => a - b) }))}
                    className={`rounded-lg px-2 py-1 text-xs border ${supersedeForm.work_days.includes(d) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-300 dark:border-white/[0.12]'}`}>
                    {DAY_LABELS[d]}
                  </button>
                ))}
              </div>
            </div>
            <label className="text-sm block">Motivo del cambio
              <input value={supersedeForm.change_reason} onChange={e => setSupersedeForm(f => ({ ...f, change_reason: e.target.value }))} className={`${inputCls} block mt-1 w-full`} placeholder="Ej: nuevo horario 2026" />
            </label>
            {mutErr && <p className="text-sm text-rose-600">{mutErr}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={mutBusy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">{mutBusy ? 'Guardando…' : 'Crear nueva versión'}</button>
              <button type="button" onClick={() => setSuperseding(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm dark:border-white/[0.12]">Cancelar</button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Cerrar vigencia */}
      {closingRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <form onSubmit={submitClose} className="w-full max-w-sm rounded-2xl bg-white p-4 space-y-3 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Cerrar vigencia — {scopeSummary(closingRow)}</div>
              <button type="button" onClick={() => setClosingRow(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-slate-500">Termina la vigencia de esta versión sin abrir una sucesora. El payload histórico no cambia.</p>
            <label className="text-sm block">Vigente hasta
              <input type="date" value={closeTo} onChange={e => setCloseTo(e.target.value)} className={`${inputCls} block mt-1 w-full`} />
            </label>
            <label className="text-sm block">Motivo
              <input value={closeReason} onChange={e => setCloseReason(e.target.value)} className={`${inputCls} block mt-1 w-full`} />
            </label>
            {mutErr && <p className="text-sm text-rose-600">{mutErr}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={mutBusy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">{mutBusy ? 'Cerrando…' : 'Cerrar vigencia'}</button>
              <button type="button" onClick={() => setClosingRow(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm dark:border-white/[0.12]">Cancelar</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
