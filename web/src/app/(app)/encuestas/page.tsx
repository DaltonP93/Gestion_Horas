'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  ClipboardList, Plus, Send, BarChart3, X, CheckCircle2, Lock, Users,
  Trash2, Star, Download,
} from 'lucide-react'
import { api } from '@/lib/api'
import { downloadCsv } from '@/lib/csvExport'
import { useCurrentUser } from '@/lib/useCurrentUser'

const QTYPE_LABELS: Record<string, string> = {
  scale:  'Escala 1-5',
  yesno:  'Sí / No',
  text:   'Texto libre',
  choice: 'Opción múltiple',
}

export default function EncuestasPage() {
  const qc = useQueryClient()
  const user = useCurrentUser()
  const isAdmin = ['admin', 'gth', 'hr', 'manager', 'super_admin'].includes(user?.role || '')

  const [showForm, setShowForm] = useState(false)
  const [showResults, setShowResults] = useState<any>(null)
  const [activeRespond, setActiveRespond] = useState<any>(null)
  const [answers, setAnswers] = useState<Record<number, any>>({})

  const [form, setForm] = useState<any>({
    title: '', description: '', anonymous: 1, audience: 'all',
    audience_dept: '', audience_role: '', expires_at: '',
    questions: [{ type: 'scale', prompt: '', scale_min: 1, scale_max: 5, required: 1 }],
  })

  const { data: list } = useQuery<any>({
    queryKey: ['surveys'],
    queryFn: () => api.get('/api/surveys').then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data: detail } = useQuery<any>({
    queryKey: ['survey-detail', activeRespond?.id],
    queryFn: () => api.get(`/api/surveys/${activeRespond.id}`).then(r => r.data),
    enabled: !!activeRespond,
  })

  const { data: results } = useQuery<any>({
    queryKey: ['survey-results', showResults?.id],
    queryFn: () => api.get(`/api/surveys/${showResults.id}/results`).then(r => r.data),
    enabled: !!showResults,
  })

  const { data: depts } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  function addQuestion() {
    setForm((f: any) => ({
      ...f,
      questions: [...f.questions, { type: 'scale', prompt: '', scale_min: 1, scale_max: 5, required: 1 }],
    }))
  }
  function updateQuestion(idx: number, patch: any) {
    setForm((f: any) => ({
      ...f,
      questions: f.questions.map((q: any, i: number) => i === idx ? { ...q, ...patch } : q),
    }))
  }
  function removeQuestion(idx: number) {
    setForm((f: any) => ({ ...f, questions: f.questions.filter((_: any, i: number) => i !== idx) }))
  }

  async function createSurvey() {
    if (!form.title || form.questions.length === 0 || form.questions.some((q: any) => !q.prompt)) {
      return alert('Título y todas las preguntas con texto son requeridos')
    }
    try {
      await api.post('/api/surveys', form)
      qc.invalidateQueries({ queryKey: ['surveys'] })
      setShowForm(false)
      setForm({
        title: '', description: '', anonymous: 1, audience: 'all',
        audience_dept: '', audience_role: '', expires_at: '',
        questions: [{ type: 'scale', prompt: '', scale_min: 1, scale_max: 5, required: 1 }],
      })
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    }
  }

  async function submitAnswers() {
    if (!detail?.questions) return
    const payload = detail.questions.map((q: any) => {
      const val = answers[q.id]
      if (q.type === 'scale' || q.type === 'yesno') {
        return { question_id: q.id, value_int: val == null ? null : Number(val) }
      }
      return { question_id: q.id, value_text: val || null }
    })
    // Validar requeridas
    const missing = detail.questions.filter((q: any) =>
      q.required && (answers[q.id] === undefined || answers[q.id] === null || answers[q.id] === '')
    )
    if (missing.length) return alert('Hay preguntas requeridas sin responder')

    try {
      await api.post(`/api/surveys/${activeRespond.id}/respond`, { answers: payload })
      alert('✅ Respuesta enviada. Gracias por tu participación.')
      qc.invalidateQueries({ queryKey: ['surveys'] })
      setActiveRespond(null)
      setAnswers({})
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    }
  }

  // Exporta el AGREGADO de resultados (distribuciones + estadísticas). NUNCA
  // exporta los comentarios de texto libre (posible PII / respuesta identificable):
  // sólo su conteo.
  function exportResults() {
    if (!results) return
    const rows: (string | number)[][] = []
    for (const r of results.results as any[]) {
      const p = r.question.prompt
      const t = r.question.type
      if ((t === 'scale' || t === 'yesno') && r.distribution) {
        for (const d of r.distribution) {
          const label = t === 'yesno' ? (d.value === 1 ? 'Sí' : 'No') : d.value
          rows.push([p, t, label, d.count, r.stat?.avg_value ?? '', r.stat?.n ?? ''])
        }
      } else if (t === 'choice' && r.distribution) {
        for (const d of r.distribution) rows.push([p, t, d.value, d.count, '', ''])
      } else if (t === 'text') {
        rows.push([p, t, 'comentarios (no exportados)', (r.comments?.length ?? 0), '', ''])
      }
    }
    downloadCsv(
      `encuesta-resultados_${showResults?.id ?? 'x'}.csv`,
      ['Pregunta', 'Tipo', 'Valor/Opción', 'Conteo', 'Promedio', 'N'],
      rows,
    )
  }

  async function deleteSurvey(id: number) {
    if (!confirm('¿Desactivar esta encuesta?')) return
    await api.delete(`/api/surveys/${id}`)
    qc.invalidateQueries({ queryKey: ['surveys'] })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-500 flex items-center justify-center">
            <ClipboardList className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Encuestas pulse</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Encuestas rápidas anónimas para captar feedback del equipo</p>
          </div>
        </div>
        {isAdmin && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-xl text-sm font-medium">
            <Plus size={14} /> Nueva encuesta
          </button>
        )}
      </div>

      {/* Lista */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(list?.data || []).map((s: any) => (
          <div key={s.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex flex-col dark:bg-white/[0.04] dark:border-white/[0.06]">
            <div className="flex items-start justify-between mb-2">
              {s.anonymous ? (
                <span className="text-xs flex items-center gap-1 bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full font-medium">
                  <Lock size={11} /> Anónima
                </span>
              ) : (
                <span className="text-xs flex items-center gap-1 bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium dark:bg-white/[0.06] dark:text-white/60">
                  <Users size={11} /> Identificada
                </span>
              )}
              {s.has_responded ? (
                <span className="text-xs flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                  <CheckCircle2 size={11} /> Respondida
                </span>
              ) : null}
            </div>
            <h3 className="font-bold text-slate-900 mb-1 dark:text-white">{s.title}</h3>
            <p className="text-sm text-slate-500 mb-3 line-clamp-2 flex-1 dark:text-white/40">{s.description || '—'}</p>
            <div className="flex items-center justify-between text-xs text-slate-400 mb-3 dark:text-white/30">
              <span>{s.question_count} pregunta{s.question_count !== 1 ? 's' : ''}</span>
              <span>{s.response_count} respuesta{s.response_count !== 1 ? 's' : ''}</span>
            </div>
            <div className="flex gap-2">
              {!s.has_responded && (
                <button onClick={() => setActiveRespond(s)}
                  className="flex-1 flex items-center justify-center gap-1 bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-2 rounded-lg text-xs font-medium">
                  <Send size={12} /> Responder
                </button>
              )}
              {isAdmin && (
                <>
                  <button onClick={() => setShowResults(s)}
                    className="flex-1 flex items-center justify-center gap-1 border border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-lg text-xs font-medium dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                    <BarChart3 size={12} /> Resultados
                  </button>
                  <button onClick={() => deleteSurvey(s.id)}
                    className="text-rose-500 hover:bg-rose-50 p-2 rounded-lg">
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {(list?.data || []).length === 0 && (
          <div className="col-span-full text-center py-12 text-slate-400 bg-white rounded-2xl border border-slate-100 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
            <ClipboardList size={36} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Sin encuestas activas</p>
          </div>
        )}
      </div>

      {/* Modal responder */}
      {activeRespond && detail && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => { setActiveRespond(null); setAnswers({}) }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <div>
                <h3 className="font-bold text-slate-900 dark:text-white">{detail.survey.title}</h3>
                {detail.survey.anonymous ? (
                  <p className="text-xs text-emerald-700 flex items-center gap-1 mt-0.5"><Lock size={11} /> Tus respuestas son anónimas</p>
                ) : null}
              </div>
              <button onClick={() => { setActiveRespond(null); setAnswers({}) }} className="text-slate-400 hover:text-slate-600 dark:text-white/30">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {detail.survey.description && (
                <p className="text-sm text-slate-600 dark:text-white/60">{detail.survey.description}</p>
              )}
              {detail.questions.map((q: any, idx: number) => (
                <div key={q.id} className="space-y-2">
                  <p className="text-sm font-medium text-slate-800 dark:text-white/90">
                    {idx + 1}. {q.prompt}
                    {q.required ? <span className="text-rose-500 ml-1">*</span> : null}
                  </p>
                  {q.type === 'scale' && (
                    <div className="flex gap-2">
                      {Array.from({ length: (q.scale_max || 5) - (q.scale_min || 1) + 1 }).map((_, i) => {
                        const v = (q.scale_min || 1) + i
                        const selected = answers[q.id] === v
                        return (
                          <button key={v} type="button"
                            onClick={() => setAnswers(a => ({ ...a, [q.id]: v }))}
                            className={`flex-1 py-3 rounded-xl border-2 transition-all ${
                              selected ? 'border-cyan-500 bg-cyan-50 text-cyan-700 font-bold' : 'border-slate-200 hover:border-slate-300 text-slate-600'
                            }`}>
                            <div className="text-lg">{v}</div>
                            {v === q.scale_min && <div className="text-[10px]">😞</div>}
                            {v === q.scale_max && <div className="text-[10px]">😊</div>}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {q.type === 'yesno' && (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setAnswers(a => ({ ...a, [q.id]: 1 }))}
                        className={`flex-1 py-3 rounded-xl border-2 transition-colors ${
                          answers[q.id] === 1 ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                        }`}>Sí</button>
                      <button type="button" onClick={() => setAnswers(a => ({ ...a, [q.id]: 0 }))}
                        className={`flex-1 py-3 rounded-xl border-2 transition-colors ${
                          answers[q.id] === 0 ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                        }`}>No</button>
                    </div>
                  )}
                  {q.type === 'text' && (
                    <textarea rows={3} value={answers[q.id] || ''}
                      onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                  )}
                  {q.type === 'choice' && q.options_json && (
                    <div className="space-y-1.5">
                      {(JSON.parse(q.options_json) as string[]).map(opt => (
                        <label key={opt} className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                          <input type="radio" name={`q${q.id}`} value={opt} checked={answers[q.id] === opt}
                            onChange={() => setAnswers(a => ({ ...a, [q.id]: opt }))} className="accent-cyan-600" />
                          <span className="text-sm">{opt}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 dark:border-white/[0.06]">
              <button onClick={() => { setActiveRespond(null); setAnswers({}) }} className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={submitAnswers} className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-xl text-sm font-medium">
                <Send size={14} /> Enviar respuesta
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal resultados */}
      {showResults && results && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowResults(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <div>
                <h3 className="font-bold flex items-center gap-2"><BarChart3 size={18} /> {results.survey.title}</h3>
                <p className="text-xs text-slate-500 dark:text-white/40">{results.total_responses} respuesta{results.total_responses !== 1 ? 's' : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={exportResults}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">
                  <Download size={13} /> CSV
                </button>
                <button onClick={() => setShowResults(null)} className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={18} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {results.results.map((r: any, idx: number) => (
                <div key={r.question.id}>
                  <p className="font-medium text-slate-800 mb-2 dark:text-white/90">{idx + 1}. {r.question.prompt}</p>
                  {(r.question.type === 'scale' || r.question.type === 'yesno') && r.stat && (
                    <div className="bg-slate-50 rounded-xl p-4 space-y-2 dark:bg-white/[0.03]">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-slate-500 dark:text-white/40">Promedio</p>
                          <p className="text-3xl font-bold text-cyan-600 flex items-center gap-1">
                            {r.stat.avg_value || 0}
                            <Star size={20} className="fill-amber-400 text-amber-400" />
                          </p>
                        </div>
                        <div className="text-xs text-slate-500 text-right dark:text-white/40">
                          <p>{r.stat.n} respuesta{r.stat.n !== 1 ? 's' : ''}</p>
                          <p>min: {r.stat.min_value} / max: {r.stat.max_value}</p>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {(r.distribution || []).map((d: any) => {
                          const pct = r.stat.n > 0 ? (d.count / r.stat.n) * 100 : 0
                          return (
                            <div key={d.value} className="flex items-center gap-2 text-xs">
                              <span className="w-6 text-slate-600 font-mono dark:text-white/60">{r.question.type === 'yesno' ? (d.value === 1 ? 'Sí' : 'No') : d.value}</span>
                              <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                                <div className="h-full bg-cyan-500 transition-all" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-12 text-right text-slate-600 dark:text-white/60">{d.count} ({Math.round(pct)}%)</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {r.question.type === 'choice' && r.distribution && (
                    <div className="space-y-1.5">
                      {r.distribution.map((d: any) => (
                        <div key={d.value} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-lg dark:bg-white/[0.03]">
                          <span className="text-sm text-slate-700 dark:text-white/80">{d.value}</span>
                          <span className="text-sm font-bold text-slate-600 dark:text-white/60">{d.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {r.question.type === 'text' && r.comments && (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {r.comments.length === 0 && <p className="text-slate-400 text-sm italic dark:text-white/30">Sin comentarios</p>}
                      {r.comments.map((c: any, i: number) => (
                        <div key={i} className="bg-slate-50 px-3 py-2 rounded-lg text-sm text-slate-700 italic dark:bg-white/[0.03] dark:text-white/80">
                          "{c.value_text}"
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modal nueva encuesta */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <h3 className="font-bold flex items-center gap-2"><ClipboardList size={18} /> Nueva encuesta</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <input placeholder="Título *" value={form.title}
                onChange={e => setForm((f: any) => ({ ...f, title: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
              <textarea placeholder="Descripción" value={form.description} rows={2}
                onChange={e => setForm((f: any) => ({ ...f, description: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />

              <div className="grid grid-cols-2 gap-3">
                <select value={form.audience} onChange={e => setForm((f: any) => ({ ...f, audience: e.target.value }))}
                  className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                  <option value="all">Todos</option>
                  <option value="department">Departamento</option>
                  <option value="role">Por rol</option>
                </select>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!form.anonymous}
                    onChange={e => setForm((f: any) => ({ ...f, anonymous: e.target.checked ? 1 : 0 }))}
                    className="accent-emerald-600 w-4 h-4" />
                  <span className="text-sm">Anónima</span>
                </label>
              </div>
              {form.audience === 'department' && (
                <select value={form.audience_dept} onChange={e => setForm((f: any) => ({ ...f, audience_dept: e.target.value }))}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                  <option value="">Seleccionar departamento...</option>
                  {(depts || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              )}

              <div className="border-t border-slate-100 pt-4 space-y-3 dark:border-white/[0.06]">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-slate-700 text-sm dark:text-white/80">Preguntas</h4>
                  <button type="button" onClick={addQuestion}
                    className="flex items-center gap-1 text-cyan-600 hover:bg-cyan-50 px-2 py-1 rounded-lg text-xs font-medium">
                    <Plus size={12} /> Agregar
                  </button>
                </div>
                {form.questions.map((q: any, idx: number) => (
                  <div key={idx} className="bg-slate-50 rounded-xl p-3 space-y-2 dark:bg-white/[0.03]">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-500 dark:text-white/40">#{idx + 1}</span>
                      <select value={q.type} onChange={e => updateQuestion(idx, { type: e.target.value })}
                        className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white flex-1 dark:bg-white/[0.04] dark:border-white/[0.08]">
                        {Object.entries(QTYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <button type="button" onClick={() => removeQuestion(idx)}
                        className="text-rose-500 hover:bg-rose-50 p-1 rounded">
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <input placeholder="Texto de la pregunta" value={q.prompt}
                      onChange={e => updateQuestion(idx, { prompt: e.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]" />
                  </div>
                ))}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 dark:border-white/[0.06]">
              <button onClick={() => setShowForm(false)} className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={createSurvey} className="bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-xl text-sm font-medium">Publicar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
