'use client'
/**
 * Nómina (base / sandbox) — vista NO OFICIAL (FASE F4 + UI de ciclo de vida F+).
 *
 * Superficie de UI para los writers ya existentes y fail-closed
 * (PAYROLL_WRITE_ENABLED + requireGlobalHR):
 *   - Crear período (`POST /periods`) en estado `draft`.
 *   - Máquina de estados (`POST /periods/:id/transition`): draft→preview→locked→closed.
 *     `closed` es terminal e inmutable (persiste snapshot agregado).
 *   - Previsualización agregada NO OFICIAL (`GET /periods/:id/preview`): headcount y
 *     conceptos activos, sin montos ni PII.
 *
 * No calcula liquidación ni haberes ni paga. Toda escritura respeta el 503
 * fail-closed (modo sólo lectura) sin romper la vista; sólo roles globales de
 * RR.HH. ven las acciones (el permiso real lo impone la API).
 */
import { useEffect, useMemo, useState } from 'react'
import { DollarSign, AlertTriangle, Plus, Eye, ArrowRight, Lock, X, CheckCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface Period { id: number; code: string; label: string; period_start: string; period_end: string; status: string; is_official: number; closed_at?: string | null }
interface Integration { key: string; label: string; enabled: boolean }
interface Concept { id: number; code: string; name: string; kind: 'earning' | 'deduction'; formula_hint: string | null; version: number; active: number; valid_from: string; valid_to: string | null }
interface Preview {
  official: boolean
  disclaimer: string
  period: { id: number; code: string; status: string }
  headcount: { by_status: Record<string, number>; active: number }
  active_concepts: { earnings: number; deductions: number }
}

const STATUS_LABEL: Record<string, string> = { draft: 'Borrador', preview: 'Previsualización', locked: 'Bloqueado', closed: 'Cerrado' }
const STATUS_CLS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/60',
  preview: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  locked: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
}
// Espejo de la máquina de estados del backend (services/payrollBase.js). Sólo
// orienta la UI; la transición real la valida y serializa la API.
const TRANSITIONS: Record<string, string[]> = {
  draft: ['preview'],
  preview: ['draft', 'locked'],
  locked: ['preview', 'closed'],
  closed: [],
}
const WRITE_ROLES = ['super_admin', 'admin', 'gth', 'hr']

const emptyForm = { code: '', label: '', period_start: '', period_end: '' }
const emptyConcept = { code: '', name: '', kind: 'earning' as 'earning' | 'deduction', formula_hint: '', version: '1', valid_from: '', valid_to: '' }

export default function NominaBasePage() {
  const user = useCurrentUser()
  const canWrite = WRITE_ROLES.includes(String(user?.role || ''))

  const [periods, setPeriods] = useState<Period[]>([])
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })
  const [formErr, setFormErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  const [concepts, setConcepts] = useState<Concept[]>([])
  const [showConceptForm, setShowConceptForm] = useState(false)
  const [concept, setConcept] = useState({ ...emptyConcept })
  const [conceptErr, setConceptErr] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const [p, i, c] = await Promise.all([
        api.get('/api/payroll-base/periods').then(r => (r.data?.data ?? []) as Period[]),
        api.get('/api/payroll-base/integrations').then(r => (r.data?.data ?? []) as Integration[]).catch(() => [] as Integration[]),
        api.get('/api/payroll-base/concepts').then(r => (r.data?.data ?? []) as Concept[]).catch(() => [] as Concept[]),
      ])
      setPeriods(p); setIntegrations(i); setConcepts(c)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 3500)
    return () => clearTimeout(t)
  }, [feedback])

  // Traduce un error del writer a un mensaje humano; devuelve el aviso a mostrar.
  function writerError(e: any): string {
    const status = e?.response?.status
    const code = e?.response?.data?.code
    const msg = e?.response?.data?.error
    if (status === 503 || code === 'PAYROLL_WRITES_DISABLED') {
      return 'La base de nómina está en modo sólo lectura durante el rollout. No se registraron cambios.'
    }
    if (code === 'GLOBAL_HR_ONLY') return 'Requiere un rol global de RR.HH.'
    return msg || 'No se pudo completar la operación.'
  }

  async function createPeriod() {
    setFormErr(null)
    if (!form.code.trim() || !form.label.trim() || !form.period_start || !form.period_end) {
      setFormErr('Completá código, etiqueta y ambas fechas.'); return
    }
    if (form.period_end < form.period_start) { setFormErr('El fin del período no puede ser anterior al inicio.'); return }
    setBusy(true)
    try {
      await api.post('/api/payroll-base/periods', {
        code: form.code.trim(), label: form.label.trim(),
        period_start: form.period_start, period_end: form.period_end,
      })
      setShowForm(false); setForm({ ...emptyForm })
      setFeedback('Período creado en borrador.')
      await load()
    } catch (e: any) {
      setFormErr(writerError(e))
    } finally { setBusy(false) }
  }

  async function createConcept() {
    setConceptErr(null)
    if (!concept.code.trim() || !concept.name.trim() || !concept.valid_from) {
      setConceptErr('Completá código, nombre y vigencia desde.'); return
    }
    if (concept.valid_to && concept.valid_to < concept.valid_from) {
      setConceptErr('La vigencia hasta no puede ser anterior a desde.'); return
    }
    setBusy(true)
    try {
      await api.post('/api/payroll-base/concepts', {
        code: concept.code.trim(), name: concept.name.trim(), kind: concept.kind,
        formula_hint: concept.formula_hint.trim() || null,
        version: Number(concept.version) || 1,
        valid_from: concept.valid_from, valid_to: concept.valid_to || null,
      })
      setShowConceptForm(false); setConcept({ ...emptyConcept })
      setFeedback('Concepto creado.')
      await load()
    } catch (e: any) {
      setConceptErr(writerError(e))
    } finally { setBusy(false) }
  }

  async function transition(p: Period, to: string) {
    if (to === 'closed' && !confirm(
      `Cerrar el período "${p.label}" es IRREVERSIBLE: queda inmutable y se persiste su evidencia agregada. ¿Continuar?`
    )) return
    setBusy(true)
    try {
      await api.post(`/api/payroll-base/periods/${p.id}/transition`, { to })
      setFeedback(`Período "${p.code}" → ${STATUS_LABEL[to] || to}.`)
      await load()
    } catch (e: any) {
      setFeedback(writerError(e))
    } finally { setBusy(false) }
  }

  async function openPreview(p: Period) {
    setPreviewBusy(true); setPreview(null)
    try {
      const data = await api.get(`/api/payroll-base/periods/${p.id}/preview`).then(r => r.data as Preview)
      setPreview(data)
    } catch (e: any) {
      setFeedback(e?.response?.data?.error || 'No se pudo generar la previsualización.')
    } finally { setPreviewBusy(false) }
  }

  const activeCount = useMemo(() => periods.filter(p => p.status !== 'closed').length, [periods])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-green-600 flex items-center justify-center">
          <DollarSign className="text-white" size={22} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Nómina — base (sandbox)</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Períodos, conceptos y previsualización agregada.</p>
        </div>
        {canWrite && (
          <button onClick={() => { setShowForm(s => !s); setFormErr(null) }}
            className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-green-700">
            <Plus size={15} /> Nuevo período
          </button>
        )}
      </div>

      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-300">
        <AlertTriangle size={18} className="mt-0.5 shrink-0" />
        <p className="text-sm">
          <b>NO OFICIAL.</b> Esta base no calcula liquidación legal ni haberes, no realiza pagos ni integra con IPS/MTESS/bancos.
          Sólo estructura períodos y conceptos con trazabilidad para una etapa futura con fuente normativa y aprobación humana.
        </p>
      </div>

      {feedback && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white/80">
          <CheckCircle size={15} className="text-emerald-500" /> <span className="flex-1">{feedback}</span>
          <button onClick={() => setFeedback(null)} aria-label="Cerrar aviso"><X size={14} /></button>
        </div>
      )}
      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      {showForm && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5 space-y-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-white/80">Nuevo período (nace en borrador)</h2>
          {formErr && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/[0.06] dark:text-red-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{formErr}</span>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Código *</span>
              <input value={form.code} maxLength={40} onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                placeholder="ej: 2026-04"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Etiqueta *</span>
              <input value={form.label} maxLength={200} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="ej: Abril 2026"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Inicio *</span>
              <input type="date" value={form.period_start} onChange={e => setForm(f => ({ ...f, period_start: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Fin *</span>
              <input type="date" value={form.period_end} min={form.period_start || undefined}
                onChange={e => setForm(f => ({ ...f, period_end: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowForm(false); setForm({ ...emptyForm }); setFormErr(null) }}
              className="border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
            <button onClick={createPeriod} disabled={busy}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-60">
              <CheckCircle size={14} /> {busy ? 'Guardando…' : 'Crear período'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">Períodos</h2>
          <span className="text-xs text-slate-400 dark:text-white/30">{activeCount} activo(s) · {periods.length} total</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Código</th><th className="px-4 py-3">Período</th>
                <th className="px-4 py-3">Rango</th><th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {loading && <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>}
              {!loading && periods.length === 0 && !error && <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Sin períodos</td></tr>}
              {periods.map(p => {
                const nexts = canWrite ? (TRANSITIONS[p.status] || []) : []
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{p.code}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-white/60">{p.label}</td>
                    <td className="px-4 py-2 text-slate-500 dark:text-white/50">{p.period_start} → {p.period_end}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[p.status] || STATUS_CLS.draft}`}>
                        {p.status === 'closed' && <Lock size={11} />}{STATUS_LABEL[p.status] || p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => openPreview(p)} title="Previsualización NO OFICIAL"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-white/[0.08] dark:text-white/60 dark:hover:bg-white/[0.04]">
                          <Eye size={12} /> Preview
                        </button>
                        {nexts.map(to => (
                          <button key={to} onClick={() => transition(p, to)} disabled={busy}
                            title={`Pasar a ${STATUS_LABEL[to] || to}`}
                            className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium disabled:opacity-60 ${
                              to === 'closed'
                                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                                : 'border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]'
                            }`}>
                            {to === 'closed' ? <Lock size={11} /> : <ArrowRight size={11} />} {STATUS_LABEL[to] || to}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(preview || previewBusy) && (
        <div role="dialog" aria-modal="true" aria-labelledby="preview-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => { setPreview(null) }}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 space-y-4 dark:bg-[#0d0d0f]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 id="preview-title" className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Eye size={18} className="text-blue-600" /> Previsualización
              </h3>
              <button aria-label="Cerrar" onClick={() => setPreview(null)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
            </div>
            {previewBusy && <p className="text-sm text-slate-400 dark:text-white/30">Calculando…</p>}
            {preview && (
              <>
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.06] dark:text-amber-200">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{preview.disclaimer}</span>
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-500 dark:text-white/50">Período</dt><dd className="font-medium text-slate-800 dark:text-white/90">{preview.period.code} · {STATUS_LABEL[preview.period.status] || preview.period.status}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500 dark:text-white/50">Empleados activos</dt><dd className="font-mono text-slate-800 dark:text-white/90">{preview.headcount.active}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500 dark:text-white/50">Conceptos activos (ingresos)</dt><dd className="font-mono text-slate-800 dark:text-white/90">{preview.active_concepts.earnings}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500 dark:text-white/50">Conceptos activos (deducciones)</dt><dd className="font-mono text-slate-800 dark:text-white/90">{preview.active_concepts.deductions}</dd></div>
                </dl>
              </>
            )}
          </div>
        </div>
      )}

      {/* Catálogo de conceptos (versionados). formula_hint es SÓLO DESCRIPTIVO:
          nunca se evalúa; el backend jamás lo interpreta como fórmula. */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">Conceptos (versionados)</h2>
            <p className="text-xs text-slate-400 dark:text-white/30">La “pista de fórmula” es sólo descriptiva; nunca se evalúa ni calcula.</p>
          </div>
          {canWrite && (
            <button onClick={() => { setShowConceptForm(s => !s); setConceptErr(null) }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">
              <Plus size={13} /> Nuevo concepto
            </button>
          )}
        </div>

        {showConceptForm && (
          <div className="p-5 space-y-3 border-b border-slate-100 bg-slate-50/60 dark:border-white/[0.06] dark:bg-white/[0.02]">
            {conceptErr && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/[0.06] dark:text-red-200">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{conceptErr}</span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-white/60">Código *</span>
                <input value={concept.code} maxLength={40} onChange={e => setConcept(c => ({ ...c, code: e.target.value }))}
                  placeholder="ej: BASICO"
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-white/60">Nombre *</span>
                <input value={concept.name} maxLength={200} onChange={e => setConcept(c => ({ ...c, name: e.target.value }))}
                  placeholder="ej: Salario básico"
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-white/60">Tipo *</span>
                <select value={concept.kind} onChange={e => setConcept(c => ({ ...c, kind: e.target.value as 'earning' | 'deduction' }))}
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
                  <option value="earning">Ingreso</option>
                  <option value="deduction">Deducción</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-white/60">Versión</span>
                <input type="number" min="1" step="1" value={concept.version}
                  onChange={e => setConcept(c => ({ ...c, version: e.target.value }))}
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-white/60">Vigente desde *</span>
                <input type="date" value={concept.valid_from} onChange={e => setConcept(c => ({ ...c, valid_from: e.target.value }))}
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600 dark:text-white/60">Vigente hasta</span>
                <input type="date" value={concept.valid_to} min={concept.valid_from || undefined}
                  onChange={e => setConcept(c => ({ ...c, valid_to: e.target.value }))}
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Pista de fórmula (sólo descriptiva, no se evalúa)</span>
              <input value={concept.formula_hint} maxLength={500}
                onChange={e => setConcept(c => ({ ...c, formula_hint: e.target.value }))}
                placeholder="ej: salario_base (referencia informativa)"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowConceptForm(false); setConcept({ ...emptyConcept }); setConceptErr(null) }}
                className="border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={createConcept} disabled={busy}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-60">
                <CheckCircle size={14} /> {busy ? 'Guardando…' : 'Crear concepto'}
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Código</th><th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Tipo</th><th className="px-4 py-3">Ver.</th>
                <th className="px-4 py-3">Vigencia</th><th className="px-4 py-3">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {!loading && concepts.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400 dark:text-white/30">Sin conceptos</td></tr>}
              {concepts.map(c => (
                <tr key={c.id}>
                  <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{c.code}</td>
                  <td className="px-4 py-2 text-slate-600 dark:text-white/60">{c.name}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.kind === 'earning' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'}`}>
                      {c.kind === 'earning' ? 'Ingreso' : 'Deducción'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-500 dark:text-white/50">v{c.version}</td>
                  <td className="px-4 py-2 text-slate-500 dark:text-white/50">{c.valid_from}{c.valid_to ? ` → ${c.valid_to}` : ' →'}</td>
                  <td className="px-4 py-2 text-xs">{Number(c.active) ? 'Activo' : 'Inactivo'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 dark:text-white/70">Integraciones (planificadas — apagadas)</h2>
        <div className="flex flex-wrap gap-2">
          {integrations.length === 0 && <span className="text-slate-400 text-sm dark:text-white/30">—</span>}
          {integrations.map(i => (
            <span key={i.key} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/60">
              <span className={`w-2 h-2 rounded-full ${i.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {i.label} · {i.enabled ? 'activa' : 'apagada'}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
