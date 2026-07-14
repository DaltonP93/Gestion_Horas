'use client'
import { useEffect, useMemo, useState, useCallback } from 'react'
import { SlidersHorizontal, Plus, Trash2, Save, X, Play, Pencil, CheckCircle2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'

// ─── Tipos del esquema (viene de /api/rules/schema) ──────────────
interface Field { key: string; label: string; type: string; options?: string[] }
interface Module { key: string; label: string; fields: Field[] }
interface Operator { op: string; label: string; arity: number }
interface ActionParam { key: string; label: string; type: string; options?: string[]; default?: string; placeholder?: string }
interface ActionDef { type: string; label: string; params: ActionParam[] }
interface Schema {
  modules: Module[]
  operators: Record<string, Operator[]>
  actions: ActionDef[]
  match_types: { key: string; label: string }[]
}
interface Condition { field: string; op: string; value?: string; value2?: string }
interface Rule {
  id?: number; name: string; module: string; description?: string
  match_type: 'all' | 'any'; conditions: Condition[]
  action_type: string; action_params: Record<string, string>
  priority: number; active: boolean
  created_by_name?: string | null
}

const emptyRule = (module: string): Rule => ({
  name: '', module, description: '', match_type: 'all',
  conditions: [], action_type: '', action_params: {}, priority: 100, active: true,
})

export default function ReglasPage() {
  const user = useCurrentUser()
  const canEdit = hasRole(user, 'admin', 'gth')
  const [schema, setSchema] = useState<Schema | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState<string[]>([])

  const loadRules = useCallback(async () => {
    setLoading(true)
    try { const r = await api.get('/api/rules'); setRules(r.data || []) }
    catch { setRules([]) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    api.get('/api/rules/schema').then(r => setSchema(r.data)).catch(() => setSchema(null))
    loadRules()
  }, [loadRules])

  const moduleLabel = (k: string) => schema?.modules.find(m => m.key === k)?.label || k
  const actionLabel = (k: string) => schema?.actions.find(a => a.type === k)?.label || k

  function startNew() {
    const first = schema?.modules[0]?.key || 'asistencia'
    setEditing(emptyRule(first)); setErr([]); setMsg('')
  }
  function startEdit(r: Rule) {
    setEditing(JSON.parse(JSON.stringify(r))); setErr([]); setMsg('')
  }

  async function save() {
    if (!editing) return
    setErr([]); setMsg('')
    try {
      if (editing.id) await api.put(`/api/rules/${editing.id}`, editing)
      else await api.post('/api/rules', editing)
      setMsg('Regla guardada.'); setEditing(null); loadRules()
    } catch (e: any) {
      const data = e?.response?.data
      if (data?.errors) setErr(data.errors)
      else setErr([data?.error || 'Error al guardar'])
    }
  }

  async function remove(r: Rule) {
    if (!r.id || !confirm(`¿Eliminar la regla "${r.name}"?`)) return
    try { await api.delete(`/api/rules/${r.id}`); loadRules() }
    catch { setMsg('No se pudo eliminar.') }
  }

  const rulesByModule = useMemo(() => {
    const map: Record<string, Rule[]> = {}
    for (const r of rules) (map[r.module] ||= []).push(r)
    return map
  }, [rules])

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-400 to-indigo-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(139,92,246,0.5)]">
            <SlidersHorizontal size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Constructor de condiciones</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Reglas parametrizables &quot;cuando… entonces…&quot; por módulo, sin tocar código.</p>
          </div>
        </div>
        {canEdit && !editing && (
          <button onClick={startNew} className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm flex items-center gap-2">
            <Plus size={16} /> Nueva regla
          </button>
        )}
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}
      {err.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-sm rounded-xl px-4 py-3 dark:bg-rose-400/[0.08] dark:border-rose-400/30 dark:text-rose-300">
          <ul className="list-disc pl-5 space-y-0.5">{err.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {editing && schema
        ? <RuleEditor rule={editing} schema={schema} onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} canEdit={canEdit} />
        : (
          <div className="space-y-5">
            {loading ? (
              <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Cargando...</p>
            ) : rules.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center dark:bg-white/[0.04] dark:border-white/[0.06]">
                <p className="text-slate-400 text-sm dark:text-white/30">Todavía no hay reglas. {canEdit ? 'Creá la primera con “Nueva regla”.' : ''}</p>
              </div>
            ) : (
              schema?.modules.filter(m => rulesByModule[m.key]?.length).map(m => (
                <section key={m.key} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
                  <h2 className="font-bold text-slate-900 dark:text-white mb-3">{m.label}</h2>
                  <div className="space-y-2">
                    {rulesByModule[m.key].map(r => (
                      <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 dark:border-white/[0.06]">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-slate-800 dark:text-white/90">{r.name}</span>
                            {!r.active && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/40">Inactiva</span>}
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{actionLabel(r.action_type)}</span>
                            <span className="text-[10px] text-slate-400 dark:text-white/30">prioridad {r.priority}</span>
                          </div>
                          <p className="text-xs text-slate-400 dark:text-white/40 truncate">
                            {r.conditions.length} condición(es) · {r.match_type === 'any' ? 'alguna (O)' : 'todas (Y)'}{r.description ? ` · ${r.description}` : ''}
                          </p>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => startEdit(r)} className="p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-400/10" title="Editar"><Pencil size={15} /></button>
                            <button onClick={() => remove(r)} className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-400/10" title="Eliminar"><Trash2 size={15} /></button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}
    </div>
  )
}

// ─── Editor de una regla ─────────────────────────────────────────
function RuleEditor({ rule, schema, onChange, onSave, onCancel, canEdit }: {
  rule: Rule; schema: Schema; onChange: (r: Rule) => void
  onSave: () => void; onCancel: () => void; canEdit: boolean
}) {
  const mod = schema.modules.find(m => m.key === rule.module) || schema.modules[0]
  const actionDef = schema.actions.find(a => a.type === rule.action_type)
  const set = (patch: Partial<Rule>) => onChange({ ...rule, ...patch })

  const fieldType = (fieldKey: string) => mod.fields.find(f => f.key === fieldKey)?.type || 'string'
  const opsFor = (fieldKey: string) => schema.operators[fieldType(fieldKey)] || []

  function addCondition() {
    const f = mod.fields[0]
    const op = (schema.operators[f.type] || [])[0]
    set({ conditions: [...rule.conditions, { field: f.key, op: op?.op || 'eq', value: '' }] })
  }
  function updateCond(i: number, patch: Partial<Condition>) {
    const next = rule.conditions.slice()
    next[i] = { ...next[i], ...patch }
    // si cambió el campo, resetear operador al primero válido
    if (patch.field) {
      const op = (schema.operators[fieldType(patch.field)] || [])[0]
      next[i].op = op?.op || 'eq'; next[i].value = ''; next[i].value2 = ''
    }
    set({ conditions: next })
  }
  function removeCond(i: number) { set({ conditions: rule.conditions.filter((_, idx) => idx !== i) }) }

  function changeModule(m: string) {
    onChange({ ...rule, module: m, conditions: [] }) // los campos difieren por módulo
  }
  function changeAction(type: string) {
    const def = schema.actions.find(a => a.type === type)
    const params: Record<string, string> = {}
    for (const p of def?.params || []) if (p.default) params[p.key] = p.default
    set({ action_type: type, action_params: params })
  }

  // Render de un input de valor según el tipo del campo.
  function ValueInput({ i, which }: { i: number; which: 'value' | 'value2' }) {
    const c = rule.conditions[i]
    const type = fieldType(c.field)
    const field = mod.fields.find(f => f.key === c.field)
    const val = (c[which] ?? '') as string
    const onVal = (v: string) => updateCond(i, { [which]: v } as Partial<Condition>)
    const cls = 'border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent'
    if (type === 'enum' && field?.options && c.op !== 'in') {
      return <select disabled={!canEdit} value={val} onChange={e => onVal(e.target.value)} className={cls}>
        <option value="">—</option>
        {field.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    }
    if (type === 'number') return <input disabled={!canEdit} type="number" value={val} onChange={e => onVal(e.target.value)} className={`${cls} w-28`} />
    if (type === 'time') return <input disabled={!canEdit} type="time" value={val} onChange={e => onVal(e.target.value)} className={cls} />
    return <input disabled={!canEdit} value={val} onChange={e => onVal(e.target.value)} placeholder={c.op === 'in' ? 'a, b, c' : ''} className={`${cls} w-40`} />
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06] space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Nombre</label>
            <input disabled={!canEdit} value={rule.name} onChange={e => set({ name: e.target.value })}
              placeholder="Ej. Salida tardía sin autorizar"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Módulo</label>
            <select disabled={!canEdit} value={rule.module} onChange={e => changeModule(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
              {schema.modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Descripción (opcional)</label>
          <input disabled={!canEdit} value={rule.description || ''} onChange={e => set({ description: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        </div>

        {/* Condiciones */}
        <div className="pt-2">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-700 dark:text-white/80">Cuando</span>
              <select disabled={!canEdit} value={rule.match_type} onChange={e => set({ match_type: e.target.value as 'all' | 'any' })}
                className="border border-slate-200 rounded-lg px-2 py-1 text-xs dark:border-white/[0.08] bg-transparent">
                {schema.match_types.map(mt => <option key={mt.key} value={mt.key}>{mt.label}</option>)}
              </select>
            </div>
            {canEdit && <button onClick={addCondition} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 hover:border-violet-300 text-slate-600 dark:border-white/[0.08] dark:text-white/70 flex items-center gap-1"><Plus size={13} /> Condición</button>}
          </div>
          {rule.conditions.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-white/30 py-2">Agregá al menos una condición.</p>
          ) : (
            <div className="space-y-2">
              {rule.conditions.map((c, i) => {
                const op = opsFor(c.field).find(o => o.op === c.op)
                return (
                  <div key={i} className="flex items-center gap-2 flex-wrap p-2 rounded-xl bg-slate-50 dark:bg-white/[0.03]">
                    <select disabled={!canEdit} value={c.field} onChange={e => updateCond(i, { field: e.target.value })}
                      className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent">
                      {mod.fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <select disabled={!canEdit} value={c.op} onChange={e => updateCond(i, { op: e.target.value })}
                      className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent">
                      {opsFor(c.field).map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                    </select>
                    {op && op.arity >= 1 && <ValueInput i={i} which="value" />}
                    {op && op.arity === 2 && <><span className="text-xs text-slate-400">y</span><ValueInput i={i} which="value2" /></>}
                    {canEdit && <button onClick={() => removeCond(i)} className="ml-auto p-1.5 rounded-lg text-slate-400 hover:text-rose-600"><X size={15} /></button>}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Acción */}
        <div className="pt-2 border-t border-slate-100 dark:border-white/[0.06]">
          <span className="text-sm font-bold text-slate-700 dark:text-white/80 block mb-2">Entonces</span>
          <div className="flex items-center gap-2 flex-wrap">
            <select disabled={!canEdit} value={rule.action_type} onChange={e => changeAction(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent">
              <option value="">Elegir acción…</option>
              {schema.actions.map(a => <option key={a.type} value={a.type}>{a.label}</option>)}
            </select>
          </div>
          {actionDef && actionDef.params.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              {actionDef.params.map(p => (
                <div key={p.key}>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1 dark:text-white/30">{p.label}</label>
                  {p.type === 'enum' && p.options ? (
                    <select disabled={!canEdit} value={rule.action_params[p.key] || ''} onChange={e => set({ action_params: { ...rule.action_params, [p.key]: e.target.value } })}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent">
                      <option value="">—</option>
                      {p.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input disabled={!canEdit} type={p.type === 'number' ? 'number' : 'text'} placeholder={p.placeholder || ''}
                      value={rule.action_params[p.key] || ''} onChange={e => set({ action_params: { ...rule.action_params, [p.key]: e.target.value } })}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Metadatos */}
        <div className="flex items-center gap-4 flex-wrap pt-2 border-t border-slate-100 dark:border-white/[0.06]">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-500 dark:text-white/40">Prioridad</label>
            <input disabled={!canEdit} type="number" value={rule.priority} onChange={e => set({ priority: +e.target.value })}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-24 dark:border-white/[0.08] bg-transparent" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-white/70 cursor-pointer">
            <input disabled={!canEdit} type="checkbox" checked={rule.active} onChange={e => set({ active: e.target.checked })} className="h-4 w-4 accent-violet-600" />
            Activa
          </label>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2 pt-2">
            <button onClick={onSave} className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm flex items-center gap-2"><Save size={15} /> Guardar</button>
            <button onClick={onCancel} className="px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 text-sm dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">Cancelar</button>
          </div>
        )}
      </div>

      {/* Probador (dry-run) */}
      <RuleTester rule={rule} mod={mod} />
    </div>
  )
}

// ─── Probador de reglas (dry-run contra un contexto de ejemplo) ──
function RuleTester({ rule, mod }: { rule: Rule; mod: Module }) {
  const [ctx, setCtx] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ matched: boolean; action_type: string | null } | null>(null)
  const [testing, setTesting] = useState(false)
  // Sólo campos usados en las condiciones (para no pedir todo).
  const usedFields = useMemo(() => {
    const keys = new Set(rule.conditions.map(c => c.field))
    return mod.fields.filter(f => keys.has(f.key))
  }, [rule.conditions, mod.fields])

  async function run() {
    setTesting(true); setResult(null)
    try {
      const context: Record<string, any> = {}
      for (const [k, v] of Object.entries(ctx)) context[k] = v
      const r = await api.post('/api/rules/evaluate', { rule, context })
      setResult({ matched: r.data.matched, action_type: r.data.action_type })
    } catch { setResult(null) } finally { setTesting(false) }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="flex items-center gap-2 mb-3">
        <Play size={16} className="text-violet-500" />
        <h3 className="font-bold text-slate-900 dark:text-white">Probar regla</h3>
        <span className="text-xs text-slate-400 dark:text-white/30">Cargá valores de ejemplo y verificá si dispara.</span>
      </div>
      {usedFields.length === 0 ? (
        <p className="text-xs text-slate-400 dark:text-white/30">Agregá condiciones para poder probar.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            {usedFields.map(f => (
              <div key={f.key}>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1 dark:text-white/30">{f.label}</label>
                {f.type === 'enum' && f.options ? (
                  <select value={ctx[f.key] || ''} onChange={e => setCtx(c => ({ ...c, [f.key]: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent">
                    <option value="">—</option>
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type === 'boolean' ? (
                  <select value={ctx[f.key] || ''} onChange={e => setCtx(c => ({ ...c, [f.key]: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent">
                    <option value="">—</option><option value="true">Sí</option><option value="false">No</option>
                  </select>
                ) : (
                  <input type={f.type === 'number' ? 'number' : f.type === 'time' ? 'time' : 'text'}
                    value={ctx[f.key] || ''} onChange={e => setCtx(c => ({ ...c, [f.key]: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm dark:border-white/[0.08] bg-transparent" />
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={run} disabled={testing} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-sm flex items-center gap-2 disabled:opacity-50 dark:bg-white/[0.1] dark:hover:bg-white/[0.16]">
              <Play size={14} /> {testing ? 'Evaluando...' : 'Evaluar'}
            </button>
            {result && (
              result.matched
                ? <span className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 size={16} /> Dispara → {result.action_type}</span>
                : <span className="text-sm text-slate-400 dark:text-white/40 flex items-center gap-1.5"><XCircle size={16} /> No dispara</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
