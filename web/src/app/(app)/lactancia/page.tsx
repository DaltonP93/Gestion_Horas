'use client'
import { useEffect, useState, useCallback } from 'react'
import { Baby, AlertTriangle, Plus, Save, X, Pencil, Trash2, CheckCircle2, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'

interface Period {
  id: number; employee_id: number; employee_name: string; code: string; department: string | null
  child_birth_date: string | null; start_date: string; end_date: string | null
  reduction_minutes: number; status: string; note: string | null; days_left: number | null
}
interface Config { reduction_minutes: number; max_child_age_months: number; alert_days: number }
interface AlertRow { id: number; employee_id: number; employee_name: string; code: string; end_date: string; reduction_minutes: number; days_left: number }

const fmt = (d: string | null | undefined) => d ? String(d).slice(0, 10) : '—'
const hm = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m` }

export default function LactanciaPage() {
  const user = useCurrentUser()
  const canEdit = hasRole(user, 'admin', 'gth', 'hr')
  const [cfg, setCfg] = useState<Config | null>(null)
  const [ending, setEnding] = useState<AlertRow[]>([])
  const [rows, setRows] = useState<Period[]>([])
  const [statusF, setStatusF] = useState<'active' | 'ended' | 'all'>('active')
  const [emps, setEmps] = useState<any[]>([])
  const [edit, setEdit] = useState<Partial<Period> | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [msg, setMsg] = useState('')

  const loadCore = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.get('/api/lactancia/config'), api.get('/api/lactancia/alerts')])
      setCfg(c.data); setEnding(a.data.ending || [])
    } catch { /* sin permiso */ }
  }, [])
  const loadRows = useCallback(async () => {
    try { const r = await api.get('/api/lactancia', { params: { status: statusF } }); setRows(r.data?.data || []) }
    catch { setRows([]) }
  }, [statusF])

  useEffect(() => { loadCore(); api.get('/api/employees?limit=500').then(r => setEmps(r.data?.data || [])).catch(() => {}) }, [loadCore])
  useEffect(() => { loadRows() }, [loadRows])

  async function save() {
    if (!edit) return
    try {
      if (edit.id) await api.put(`/api/lactancia/${edit.id}`, edit)
      else await api.post('/api/lactancia', edit)
      setEdit(null); setMsg('Período guardado.'); loadRows(); loadCore()
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al guardar') }
  }
  async function endPeriod(p: Period) {
    if (!confirm('¿Cerrar este período de lactancia?')) return
    try { await api.post(`/api/lactancia/${p.id}/end`); loadRows(); loadCore() } catch { setMsg('No se pudo cerrar.') }
  }
  async function remove(p: Period) {
    if (!confirm('¿Eliminar este período?')) return
    try { await api.delete(`/api/lactancia/${p.id}`); loadRows(); loadCore() } catch { setMsg('No se pudo eliminar.') }
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(244,114,182,0.5)]">
            <Baby size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Maternidad / Lactancia</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Reducción horaria por lactancia con vigencia y alertas de fin de período.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <button onClick={() => setShowConfig(s => !s)} className="px-3 py-2 rounded-xl border border-slate-200 hover:border-pink-300 text-sm text-slate-600 dark:border-white/[0.08] dark:text-white/70 flex items-center gap-2">
              <Settings2 size={15} /> Configuración
            </button>
          )}
          {canEdit && cfg && (
            <button onClick={() => setEdit({ reduction_minutes: cfg.reduction_minutes, status: 'active', start_date: '' })}
              className="px-4 py-2 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-sm flex items-center gap-2"><Plus size={16} /> Nuevo período</button>
          )}
        </div>
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}

      {showConfig && cfg && canEdit && <ConfigPanel cfg={cfg} onSaved={(c) => { setCfg(c); setShowConfig(false); loadCore() }} />}

      {/* Alerta de fin de período */}
      {ending.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:bg-amber-400/[0.06] dark:border-amber-400/30">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={15} className="text-amber-600" />
            <h3 className="font-bold text-sm text-slate-800 dark:text-white/90">Períodos por finalizar</h3>
            <span className="text-xs text-slate-400 dark:text-white/30">({ending.length})</span>
          </div>
          <ul className="space-y-1">
            {ending.map(r => (
              <li key={r.id} className="text-xs flex items-center justify-between gap-2">
                <span className="text-slate-700 dark:text-white/70 truncate"><span className="font-mono text-slate-400">{r.code}</span> {r.employee_name} · {hm(r.reduction_minutes)}</span>
                <span className="tabular-nums shrink-0 text-slate-500 dark:text-white/50">{fmt(r.end_date)} · <b>{r.days_left}d</b></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filtro */}
      <div className="flex items-center gap-2">
        {(['active', 'ended', 'all'] as const).map(s => (
          <button key={s} onClick={() => setStatusF(s)}
            className={`px-3 py-1.5 rounded-xl text-sm border ${statusF === s ? 'bg-pink-600 text-white border-pink-600' : 'border-slate-200 text-slate-600 dark:border-white/[0.08] dark:text-white/70'}`}>
            {s === 'active' ? 'Vigentes' : s === 'ended' ? 'Finalizados' : 'Todos'}
          </button>
        ))}
      </div>

      {/* Lista */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-x-auto dark:bg-white/[0.04] dark:border-white/[0.06]">
        {rows.length === 0 ? (
          <p className="text-slate-400 text-sm py-10 text-center dark:text-white/30">Sin períodos.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                <th className="px-3 py-2">Empleada</th><th className="px-3 py-2">Nacimiento</th>
                <th className="px-3 py-2">Vigencia</th><th className="px-3 py-2 text-right">Reducción</th>
                <th className="px-3 py-2 text-right">Restan</th><th className="px-3 py-2">Estado</th>
                {canEdit && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {rows.map(p => (
                <tr key={p.id} className="text-slate-700 dark:text-white/70">
                  <td className="px-3 py-2"><span className="font-mono text-xs text-slate-400">{p.code}</span> {p.employee_name}<div className="text-[11px] text-slate-400">{p.department || '—'}</div></td>
                  <td className="px-3 py-2 tabular-nums">{fmt(p.child_birth_date)}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-white/50">{fmt(p.start_date)} → {fmt(p.end_date)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{hm(p.reduction_minutes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.status === 'active' && p.days_left != null ? `${p.days_left}d` : '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${p.status === 'active' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/40'}`}>{p.status === 'active' ? 'Vigente' : 'Finalizado'}</span>
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {p.status === 'active' && <button onClick={() => endPeriod(p)} title="Cerrar período" className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600"><CheckCircle2 size={15} /></button>}
                      <button onClick={() => setEdit(p)} className="p-1.5 rounded-lg text-slate-400 hover:text-pink-600"><Pencil size={15} /></button>
                      <button onClick={() => remove(p)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600"><Trash2 size={15} /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {edit && cfg && <PeriodModal period={edit} emps={emps} cfg={cfg} onClose={() => setEdit(null)} onChange={setEdit} onSave={save} />}
    </div>
  )
}

function ConfigPanel({ cfg, onSaved }: { cfg: Config; onSaved: (c: Config) => void }) {
  const [red, setRed] = useState(String(cfg.reduction_minutes))
  const [months, setMonths] = useState(String(cfg.max_child_age_months))
  const [alert, setAlert] = useState(String(cfg.alert_days))
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    try {
      const r = await api.put('/api/lactancia/config', {
        reduction_minutes: parseInt(red, 10) || 0,
        max_child_age_months: parseInt(months, 10) || 0,
        alert_days: parseInt(alert, 10) || 0,
      })
      onSaved(r.data)
    } catch { /* noop */ } finally { setSaving(false) }
  }
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06] space-y-3">
      <h2 className="font-bold text-slate-900 dark:text-white">Configuración de lactancia</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Reducción por defecto (min/día)</label>
          <input type="number" min={0} value={red} onChange={e => setRed(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Edad máx. del hijo (meses)</label>
          <input type="number" min={0} value={months} onChange={e => setMonths(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Alerta fin de período (días antes)</label>
          <input type="number" min={0} value={alert} onChange={e => setAlert(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        </div>
      </div>
      <p className="text-[11px] text-slate-400 dark:text-white/30">Al crear un período, si cargás la fecha de nacimiento y no indicás fin, se calcula automáticamente como nacimiento + {months} meses.</p>
      <button onClick={save} disabled={saving} className="px-4 py-2 rounded-xl bg-pink-600 hover:bg-pink-700 text-white text-sm flex items-center gap-2 disabled:opacity-50"><Save size={15} /> {saving ? 'Guardando...' : 'Guardar'}</button>
    </div>
  )
}

function PeriodModal({ period, emps, cfg, onClose, onChange, onSave }: {
  period: Partial<Period>; emps: any[]; cfg: Config
  onClose: () => void; onChange: (p: Partial<Period>) => void; onSave: () => void
}) {
  const set = (patch: Partial<Period>) => onChange({ ...period, ...patch })
  const inputCls = 'w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent'
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
          <h3 className="font-bold text-slate-900 dark:text-white">{period.id ? 'Editar período' : 'Nuevo período de lactancia'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-3">
          {!period.id && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Empleada</label>
              <select value={period.employee_id || ''} onChange={e => set({ employee_id: +e.target.value })} className={inputCls}>
                <option value="">Seleccionar…</option>
                {emps.map((e: any) => <option key={e.id} value={e.id}>{e.full_name} ({e.code})</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Nacimiento del hijo</label>
              <input type="date" value={period.child_birth_date || ''} onChange={e => set({ child_birth_date: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Reducción (min/día)</label>
              <input type="number" min={0} value={period.reduction_minutes ?? cfg.reduction_minutes} onChange={e => set({ reduction_minutes: +e.target.value })} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Inicio</label>
              <input type="date" value={period.start_date || ''} onChange={e => set({ start_date: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Fin (auto si vacío)</label>
              <input type="date" value={period.end_date || ''} onChange={e => set({ end_date: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Estado</label>
            <select value={period.status || 'active'} onChange={e => set({ status: e.target.value })} className={inputCls}>
              <option value="active">Vigente</option><option value="ended">Finalizado</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Nota</label>
            <input value={period.note || ''} onChange={e => set({ note: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 dark:border-white/[0.06] flex gap-2">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={onSave} className="flex-1 bg-pink-600 hover:bg-pink-700 text-white rounded-xl py-2.5 text-sm font-medium">Guardar</button>
        </div>
      </div>
    </div>
  )
}
