'use client'
import { useState, useEffect, useCallback } from 'react'
import { Star, Plus, ChevronDown, ChevronUp, CheckCircle2, Clock, AlertCircle,
         ClipboardList, X, Save, Award, Users, FileText, BarChart2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer, Tooltip } from 'recharts'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Criteria { id: number; name: string; description: string; weight: number }
interface Template { id: number; name: string; description: string; scale_min: number; scale_max: number; criteria_count: number; active: number }
interface TemplateDetail extends Template { criteria: Criteria[] }
interface Score { criteria_id: number; scorer_role: string; score: number; comment: string }
interface Appraisal {
  id: number; period_label: string; status: string; due_date: string | null
  final_score: number | null; employee_name: string; employee_code: string
  department_name: string; template_name: string; reviewer_name: string | null
  created_at: string; template_id: number; employee_id: number; reviewer_id: number | null
  scale_min: number; scale_max: number; criteria?: Criteria[]; scores?: Score[]
}

const STATUS_LABELS: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  draft:           { label: 'Borrador',          color: 'bg-slate-100 text-slate-600',   icon: <FileText size={12} /> },
  self_pending:    { label: 'Auto-eval. pendiente', color: 'bg-blue-100 text-blue-700',   icon: <Clock size={12} /> },
  manager_pending: { label: 'Manager pendiente', color: 'bg-amber-100 text-amber-700',   icon: <Clock size={12} /> },
  hr_review:       { label: 'Revisión RRHH',     color: 'bg-violet-100 text-violet-700', icon: <ClipboardList size={12} /> },
  closed:          { label: 'Cerrada',           color: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 size={12} /> },
}

const ADMIN_ROLES = ['admin', 'gth', 'hr', 'super_admin']
const MGR_ROLES   = [...ADMIN_ROLES, 'manager', 'coordinator', 'gestor']

// ─── ScoreForm — completar una evaluación ───────────────────────────────────

function ScoreForm({
  appraisal, scorerRole, onDone,
}: { appraisal: Appraisal; scorerRole: 'self' | 'manager' | 'hr'; onDone: () => void }) {
  const [values, setValues] = useState<Record<number, { score: number; comment: string }>>(() =>
    Object.fromEntries((appraisal.criteria || []).map(c => [c.id, { score: appraisal.scale_min, comment: '' }]))
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setSaving(true); setErr(null)
    try {
      const scores = Object.entries(values).map(([criteria_id, v]) => ({
        criteria_id: parseInt(criteria_id), score: v.score, comment: v.comment,
      }))
      await api.post(`/api/appraisals/${appraisal.id}/score`, { scorer_role: scorerRole, scores })
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const scaleOptions = Array.from(
    { length: appraisal.scale_max - appraisal.scale_min + 1 },
    (_, i) => appraisal.scale_min + i
  )
  const scorerLabel = { self: 'Auto-evaluación', manager: 'Evaluación de Manager', hr: 'Evaluación RRHH' }[scorerRole]

  return (
    <div className="space-y-4">
      <div className="bg-violet-50 border border-violet-200 rounded-xl px-4 py-3 text-sm text-violet-700 font-medium">
        {scorerLabel} — escala {appraisal.scale_min}–{appraisal.scale_max}
      </div>
      {(appraisal.criteria || []).map(c => (
        <div key={c.id} className="bg-white rounded-xl border border-slate-200 p-4 space-y-2 dark:bg-white/[0.04] dark:border-white/[0.08]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-slate-800 text-sm dark:text-white/90">{c.name}</p>
              {c.description && <p className="text-xs text-slate-500 dark:text-white/40">{c.description}</p>}
            </div>
            <span className="text-xs text-slate-400 shrink-0 dark:text-white/30">peso {c.weight}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {scaleOptions.map(n => (
              <button key={n} onClick={() => setValues(v => ({ ...v, [c.id]: { ...v[c.id], score: n } }))}
                className={`w-9 h-9 rounded-lg text-sm font-bold transition-colors
                  ${values[c.id]?.score === n
                    ? 'bg-violet-600 text-white shadow'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}>
                {n}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            placeholder="Comentario opcional…"
            value={values[c.id]?.comment || ''}
            onChange={e => setValues(v => ({ ...v, [c.id]: { ...v[c.id], comment: e.target.value } }))}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs resize-none focus:ring-2 focus:ring-violet-300 focus:outline-none dark:border-white/[0.08]"
          />
        </div>
      ))}
      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2 text-sm flex items-center gap-2">
          <AlertCircle size={14} /> {err}
        </div>
      )}
      <button onClick={submit} disabled={saving}
        className="w-full bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-xl py-2.5 font-medium flex items-center justify-center gap-2">
        <Save size={16} /> {saving ? 'Guardando…' : 'Enviar evaluación'}
      </button>
    </div>
  )
}

// ─── AppraisalDetail — drawer de detalle + formulario ───────────────────────

function AppraisalDetail({ id, user, onClose, onUpdated }: {
  id: number; user: ReturnType<typeof useCurrentUser>; onClose: () => void; onUpdated: () => void
}) {
  const [data, setData] = useState<Appraisal | null>(null)
  const [loading, setLoading] = useState(true)
  const [filling, setFilling] = useState<'self' | 'manager' | 'hr' | null>(null)
  const [closing, setClosing] = useState(false)
  const [hrComment, setHrComment] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get(`/api/appraisals/${id}`)
      setData(res.data.data)
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function closeAppraisal() {
    setClosing(true)
    try {
      await api.post(`/api/appraisals/${id}/close`, { hr_comment: hrComment })
      onUpdated(); load()
    } finally { setClosing(false) }
  }

  if (loading || !data) return (
    <div className="flex items-center justify-center h-48 text-slate-400 text-sm dark:text-white/30">Cargando…</div>
  )

  const isAdmin  = ADMIN_ROLES.includes(user?.role || '')
  const isMgr    = MGR_ROLES.includes(user?.role || '')
  const isEmployee = user?.employee_id === data.employee_id
  const isReviewer = user?.id === data.reviewer_id

  // Determinar qué puntajes ya existen
  const scored = (role: string) => (data.scores || []).filter(s => s.scorer_role === role)
  const selfScored    = scored('self').length > 0
  const managerScored = scored('manager').length > 0

  // Calcular promedio para el radar chart
  const criteriaMap = Object.fromEntries((data.criteria || []).map(c => [c.id, c.name]))
  const selfScores = scored('self')
  const managerScores = scored('manager')
  const radarData = (data.criteria || []).map(c => ({
    name: c.name.length > 14 ? c.name.slice(0, 14) + '…' : c.name,
    self:    selfScores.find(s => s.criteria_id === c.id)?.score ?? 0,
    manager: managerScores.find(s => s.criteria_id === c.id)?.score ?? 0,
  })).filter(r => r.self > 0 || r.manager > 0)

  const statusInfo = STATUS_LABELS[data.status] || STATUS_LABELS.draft

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{data.employee_name}</h2>
          <p className="text-sm text-slate-500 dark:text-white/40">{data.template_name} · {data.period_label}</p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg dark:hover:bg-white/[0.06]">
          <X size={18} className="text-slate-400 dark:text-white/30" />
        </button>
      </div>

      {/* Status + score */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
          {statusInfo.icon} {statusInfo.label}
        </span>
        {data.final_score !== null && (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
            <Award size={12} /> Score final: {data.final_score}
          </span>
        )}
        {data.reviewer_name && (
          <span className="text-xs text-slate-500 dark:text-white/40">Manager: {data.reviewer_name}</span>
        )}
      </div>

      {/* Radar chart si hay puntajes */}
      {radarData.length > 0 && (
        <div className="bg-slate-50 rounded-xl p-4 dark:bg-white/[0.03]">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 dark:text-white/40">Resultados por competencia</p>
          <ResponsiveContainer width="100%" height={220}>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="name" tick={{ fontSize: 11 }} />
              <Tooltip />
              {selfScores.length > 0 && (
                <Radar name="Auto-eval." dataKey="self" stroke="#7c3aed" fill="#7c3aed" fillOpacity={0.2} />
              )}
              {managerScores.length > 0 && (
                <Radar name="Manager" dataKey="manager" stroke="#0ea5e9" fill="#0ea5e9" fillOpacity={0.2} />
              )}
            </RadarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 justify-center mt-1 text-xs">
            {selfScores.length > 0 && <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-violet-500 inline-block" /> Auto-evaluación</span>}
            {managerScores.length > 0 && <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-sky-500 inline-block" /> Manager</span>}
          </div>
        </div>
      )}

      {/* Formulario de evaluación si corresponde y no está cerrada */}
      {data.status !== 'closed' && !filling && (
        <div className="flex flex-wrap gap-2">
          {data.status === 'self_pending' && isEmployee && !selfScored && (
            <button onClick={() => setFilling('self')}
              className="flex-1 bg-violet-600 hover:bg-violet-700 text-white rounded-xl px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2">
              <Star size={16} /> Hacer auto-evaluación
            </button>
          )}
          {data.status === 'manager_pending' && (isReviewer || isAdmin) && !managerScored && (
            <button onClick={() => setFilling('manager')}
              className="flex-1 bg-sky-600 hover:bg-sky-700 text-white rounded-xl px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2">
              <Users size={16} /> Evaluar como manager
            </button>
          )}
          {data.status === 'hr_review' && isAdmin && (
            <button onClick={() => setFilling('hr')}
              className="flex-1 bg-amber-600 hover:bg-amber-700 text-white rounded-xl px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2">
              <ClipboardList size={16} /> Evaluación RRHH
            </button>
          )}
        </div>
      )}

      {filling && (
        <div>
          <button onClick={() => setFilling(null)} className="text-xs text-slate-500 hover:text-slate-700 mb-3 dark:text-white/40">← Volver</button>
          <ScoreForm appraisal={data} scorerRole={filling}
            onDone={() => { setFilling(null); load(); onUpdated() }} />
        </div>
      )}

      {/* Cierre (HR) */}
      {(data.status === 'hr_review' || data.status === 'manager_pending') && isAdmin && !filling && (
        <div className="border-t border-slate-200 pt-4 space-y-2 dark:border-white/[0.08]">
          <textarea rows={2} value={hrComment} onChange={e => setHrComment(e.target.value)}
            placeholder="Comentario de cierre (opcional)…"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-emerald-300 focus:outline-none dark:border-white/[0.08]" />
          <button onClick={closeAppraisal} disabled={closing}
            className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl py-2.5 font-medium flex items-center justify-center gap-2 text-sm">
            <CheckCircle2 size={16} /> {closing ? 'Cerrando…' : 'Cerrar evaluación y calcular score'}
          </button>
        </div>
      )}

      {/* Tabla de puntajes */}
      {(selfScores.length > 0 || managerScores.length > 0) && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 dark:text-white/40">Detalle de puntajes</p>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/[0.08]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase dark:bg-white/[0.03] dark:text-white/40">
                <tr>
                  <th className="text-left px-3 py-2">Criterio</th>
                  <th className="text-center px-3 py-2">Auto</th>
                  <th className="text-center px-3 py-2">Manager</th>
                </tr>
              </thead>
              <tbody>
                {(data.criteria || []).map(c => {
                  const s = selfScores.find(x => x.criteria_id === c.id)
                  const m = managerScores.find(x => x.criteria_id === c.id)
                  if (!s && !m) return null
                  return (
                    <tr key={c.id} className="border-t border-slate-100 dark:border-white/[0.06]">
                      <td className="px-3 py-2 font-medium text-slate-700 dark:text-white/80">{c.name}</td>
                      <td className="text-center px-3 py-2">
                        {s ? <span className="font-bold text-violet-600">{s.score}</span> : '—'}
                      </td>
                      <td className="text-center px-3 py-2">
                        {m ? <span className="font-bold text-sky-600">{m.score}</span> : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TemplateModal — crear plantilla ────────────────────────────────────────

function TemplateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', description: '', scale_min: 1, scale_max: 5 })
  const [criteria, setCriteria] = useState([{ name: '', description: '', weight: 1 }])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!form.name) { setErr('El nombre de la plantilla es requerido'); return }
    const valid = criteria.filter(c => c.name.trim())
    if (!valid.length) { setErr('Al menos un criterio es requerido'); return }
    setSaving(true); setErr(null)
    try {
      await api.post('/api/appraisals/templates', { ...form, criteria: valid })
      onCreated(); onClose()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  function addCriteria() { setCriteria(c => [...c, { name: '', description: '', weight: 1 }]) }
  function removeCriteria(i: number) { setCriteria(c => c.filter((_, idx) => idx !== i)) }
  function updateCriteria(i: number, field: string, value: any) {
    setCriteria(c => c.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col dark:bg-white/[0.04]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Nueva plantilla de evaluación</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Nombre *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" placeholder="Ej: Evaluación anual 360°" />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Descripción</label>
              <textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Escala mínima</label>
              <input type="number" min={1} max={10} value={form.scale_min}
                onChange={e => setForm(f => ({ ...f, scale_min: parseInt(e.target.value) }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Escala máxima</label>
              <input type="number" min={2} max={10} value={form.scale_max}
                onChange={e => setForm(f => ({ ...f, scale_max: parseInt(e.target.value) }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide dark:text-white/60">Criterios de evaluación</p>
              <button onClick={addCriteria}
                className="text-xs text-violet-600 hover:text-violet-800 font-medium flex items-center gap-1">
                <Plus size={14} /> Agregar
              </button>
            </div>
            <div className="space-y-2">
              {criteria.map((c, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1">
                    <input value={c.name} onChange={e => updateCriteria(i, 'name', e.target.value)}
                      placeholder={`Criterio ${i + 1} *`}
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm dark:border-white/[0.08]" />
                    <input value={c.description} onChange={e => updateCriteria(i, 'description', e.target.value)}
                      placeholder="Descripción (opcional)"
                      className="w-full border border-slate-100 rounded-lg px-3 py-1.5 text-xs text-slate-500 dark:text-white/40 dark:border-white/[0.06]" />
                  </div>
                  <div className="w-16">
                    <input type="number" min={0.1} step={0.1} value={c.weight}
                      onChange={e => updateCriteria(i, 'weight', parseFloat(e.target.value))}
                      title="Peso"
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-center dark:border-white/[0.08]" />
                  </div>
                  {criteria.length > 1 && (
                    <button onClick={() => removeCriteria(i)} className="p-1.5 hover:bg-red-50 text-red-400 rounded-lg">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2 text-sm flex items-center gap-2">
              <AlertCircle size={14} /> {err}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 dark:border-white/[0.06]">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2">
            <Save size={14} /> {saving ? 'Guardando…' : 'Crear plantilla'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── NewAppraisalModal — crear evaluación ───────────────────────────────────

function NewAppraisalModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [templates, setTemplates]   = useState<Template[]>([])
  const [employees, setEmployees]   = useState<any[]>([])
  const [reviewers, setReviewers]   = useState<any[]>([])
  const [form, setForm] = useState({ template_id: '', employee_id: '', reviewer_id: '', period_label: '', due_date: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.get('/api/appraisals/templates').then(r => setTemplates(r.data.data || []))
    api.get('/api/employees?limit=500').then(r => setEmployees(r.data.data || r.data || []))
    api.get('/api/users/lookup?role=manager,coordinator,gestor,admin,gth,hr').then(r => setReviewers(r.data.data || r.data || []))
      .catch(() => {})
  }, [])

  async function submit() {
    if (!form.template_id || !form.employee_id || !form.period_label) {
      setErr('Plantilla, empleado y período son requeridos'); return
    }
    setSaving(true); setErr(null)
    try {
      await api.post('/api/appraisals', {
        template_id:  parseInt(form.template_id),
        employee_id:  parseInt(form.employee_id),
        reviewer_id:  form.reviewer_id ? parseInt(form.reviewer_id) : undefined,
        period_label: form.period_label,
        due_date:     form.due_date || undefined,
      })
      onCreated(); onClose()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al crear')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md dark:bg-white/[0.04]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Nueva evaluación</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Plantilla *</label>
            <select value={form.template_id} onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">Seleccionar plantilla…</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Empleado *</label>
            <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">Seleccionar empleado…</option>
              {employees.map((e: any) => <option key={e.id} value={e.id}>{e.full_name} ({e.code})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Manager evaluador</label>
            <select value={form.reviewer_id} onChange={e => setForm(f => ({ ...f, reviewer_id: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">Sin asignar</option>
              {reviewers.map((u: any) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Período *</label>
              <input value={form.period_label} onChange={e => setForm(f => ({ ...f, period_label: e.target.value }))}
                placeholder="Ej: 2025-S1"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Fecha límite</label>
              <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
          </div>
          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2 text-sm flex items-center gap-2">
              <AlertCircle size={14} /> {err}
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 dark:border-white/[0.06]">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2">
            <Plus size={14} /> {saving ? 'Creando…' : 'Crear evaluación'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function EvaluacionesPage() {
  const user = useCurrentUser()
  const [tab, setTab] = useState<'list' | 'templates'>('list')
  const [appraisals, setAppraisals] = useState<Appraisal[]>([])
  const [templates, setTemplates]   = useState<Template[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNewAppraisal, setShowNewAppraisal] = useState(false)
  const [showNewTemplate, setShowNewTemplate]   = useState(false)

  const isAdmin = ADMIN_ROLES.includes(user?.role || '')
  const isMgr   = MGR_ROLES.includes(user?.role || '')

  const loadAppraisals = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (statusFilter) params.set('status', statusFilter)
      // Empleados ven solo su historial
      if (!isMgr && user?.employee_id)
        params.set('employee_id', String(user.employee_id))
      const res = await api.get(`/api/appraisals?${params}`)
      setAppraisals(res.data.data || [])
      setTotal(res.data.total || 0)
    } finally { setLoading(false) }
  }, [statusFilter, isMgr, user?.employee_id])

  const loadTemplates = useCallback(async () => {
    const res = await api.get('/api/appraisals/templates?all=1')
    setTemplates(res.data.data || [])
  }, [])

  useEffect(() => { loadAppraisals() }, [loadAppraisals])
  useEffect(() => { if (tab === 'templates') loadTemplates() }, [tab, loadTemplates])

  async function toggleTemplate(id: number, active: number) {
    await api.put(`/api/appraisals/templates/${id}`, { active: active ? 0 : 1 })
    loadTemplates()
  }

  const statusCounts = appraisals.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1; return acc
  }, {})

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2 dark:text-white">
            <Star className="text-violet-500" size={24} /> Evaluaciones de desempeño
          </h1>
          <p className="text-sm text-slate-500 mt-0.5 dark:text-white/40">Ciclos de evaluación 360°, auto-evaluación y feedback de managers.</p>
        </div>
        {isMgr && (
          <div className="flex gap-2">
            <button onClick={() => setShowNewTemplate(true)}
              className="flex items-center gap-1.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl px-4 py-2 text-sm font-medium dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <FileText size={16} /> Nueva plantilla
            </button>
            <button onClick={() => setShowNewAppraisal(true)}
              className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl px-4 py-2 text-sm font-medium">
              <Plus size={16} /> Nueva evaluación
            </button>
          </div>
        )}
      </div>

      {/* KPI strip */}
      {isMgr && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <button key={k} onClick={() => setStatusFilter(statusFilter === k ? '' : k)}
              className={`rounded-xl border p-3 text-left transition-all
                ${statusFilter === k ? 'ring-2 ring-violet-400' : 'hover:shadow-sm'}
                ${v.color.replace('bg-', 'bg-opacity-60 bg-')}`}>
              <p className="text-xl font-bold">{statusCounts[k] || 0}</p>
              <p className="text-xs font-medium opacity-80 flex items-center gap-1">{v.icon} {v.label}</p>
            </button>
          ))}
        </div>
      )}

      {/* Tabs */}
      {isMgr && (
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl w-fit dark:bg-white/[0.06]">
          {(['list', 'templates'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                ${tab === t ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              {t === 'list' ? 'Evaluaciones' : 'Plantillas'}
            </button>
          ))}
        </div>
      )}

      {/* Main content with side panel */}
      <div className={`flex gap-5 ${selectedId ? 'items-start' : ''}`}>
        {/* List */}
        <div className={`flex-1 min-w-0 ${selectedId ? 'hidden lg:block' : ''}`}>
          {tab === 'list' && (
            <div className="bg-white rounded-2xl shadow border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
                <p className="text-sm font-semibold text-slate-700 dark:text-white/80">
                  {total} evaluación{total !== 1 ? 'es' : ''} {statusFilter && `· ${STATUS_LABELS[statusFilter]?.label}`}
                </p>
                {statusFilter && (
                  <button onClick={() => setStatusFilter('')} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 dark:text-white/30">
                    <X size={12} /> Limpiar filtro
                  </button>
                )}
              </div>
              {loading ? (
                <div className="py-12 text-center text-slate-400 text-sm dark:text-white/30">Cargando…</div>
              ) : appraisals.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-sm dark:text-white/30">Sin evaluaciones</div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                  {appraisals.map(a => {
                    const si = STATUS_LABELS[a.status] || STATUS_LABELS.draft
                    return (
                      <button key={a.id} onClick={() => setSelectedId(a.id)}
                        className={`w-full text-left px-4 py-3.5 hover:bg-slate-50 transition-colors flex items-center gap-3
                          ${selectedId === a.id ? 'bg-violet-50' : ''}`}>
                        <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center shrink-0 text-xs font-bold">
                          {a.employee_name?.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-800 text-sm truncate dark:text-white/90">{a.employee_name}</p>
                          <p className="text-xs text-slate-500 truncate dark:text-white/40">{a.template_name} · {a.period_label}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${si.color}`}>
                            {si.icon} {si.label}
                          </span>
                          {a.final_score !== null && (
                            <span className="text-[10px] font-bold text-emerald-600">{a.final_score}</span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'templates' && (
            <div className="bg-white rounded-2xl shadow border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
                <p className="text-sm font-semibold text-slate-700 dark:text-white/80">{templates.length} plantilla{templates.length !== 1 ? 's' : ''}</p>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3.5">
                    <div className="flex-1 min-w-0">
                      <p className={`font-medium text-sm ${t.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{t.name}</p>
                      <p className="text-xs text-slate-500 dark:text-white/40">{t.criteria_count} criterios · escala {t.scale_min}–{t.scale_max}</p>
                    </div>
                    {isAdmin && (
                      <button onClick={() => toggleTemplate(t.id, t.active)}
                        className={`text-xs px-3 py-1 rounded-full font-medium border transition-colors
                          ${t.active
                            ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                            : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                        {t.active ? 'Activa' : 'Inactiva'}
                      </button>
                    )}
                  </div>
                ))}
                {templates.length === 0 && (
                  <p className="text-center py-12 text-sm text-slate-400 dark:text-white/30">Sin plantillas</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Side panel */}
        {selectedId && (
          <div className="w-full lg:w-[480px] shrink-0 bg-white rounded-2xl shadow border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <AppraisalDetail
              id={selectedId}
              user={user}
              onClose={() => setSelectedId(null)}
              onUpdated={loadAppraisals}
            />
          </div>
        )}
      </div>

      {showNewAppraisal && (
        <NewAppraisalModal onClose={() => setShowNewAppraisal(false)} onCreated={loadAppraisals} />
      )}
      {showNewTemplate && (
        <TemplateModal onClose={() => setShowNewTemplate(false)} onCreated={loadTemplates} />
      )}
    </div>
  )
}
