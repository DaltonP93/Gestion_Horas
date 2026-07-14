'use client'
import { useEffect, useState, useCallback } from 'react'
import { FileSignature, AlertTriangle, Plus, Save, X, Pencil, Trash2, LogOut, Settings2, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'

interface Emp { id: number; code: string; full_name: string; department: string | null; hire_date: string | null; status: string; position: string | null }
interface Contract {
  id: number; employee_id: number; type: string; start_date: string; end_date: string | null
  probation_end_date: string | null; salary: number | null; status: string; note: string | null
  created_by_name?: string | null
}
interface Config { contract_types: string[]; expiry_alert_days: number; probation_alert_days: number }
interface AlertRow { id: number; employee_id: number; employee_name: string; code: string; type: string; end_date?: string; probation_end_date?: string; days_left: number }

const fmt = (d: string | null | undefined) => d ? String(d).slice(0, 10) : '—'
const gs = (n: number | null) => n == null ? '—' : new Intl.NumberFormat('es-PY').format(Math.round(n))

export default function IngresosPage() {
  const user = useCurrentUser()
  const canEdit = hasRole(user, 'admin', 'gth', 'hr')
  const [cfg, setCfg] = useState<Config | null>(null)
  const [alerts, setAlerts] = useState<{ expiring: AlertRow[]; probation: AlertRow[] }>({ expiring: [], probation: [] })
  const [emps, setEmps] = useState<Emp[]>([])
  const [dept, setDept] = useState('')
  const [depts, setDepts] = useState<any[]>([])
  const [statusF, setStatusF] = useState<'active' | 'inactive' | 'all'>('active')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Emp | null>(null)
  const [contracts, setContracts] = useState<Contract[]>([])
  const [editContract, setEditContract] = useState<Partial<Contract> | null>(null)
  const [egreso, setEgreso] = useState<Emp | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [msg, setMsg] = useState('')

  const loadCore = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.get('/api/contracts/config'), api.get('/api/contracts/alerts')])
      setCfg(c.data); setAlerts({ expiring: a.data.expiring || [], probation: a.data.probation || [] })
    } catch { /* sin permiso */ }
  }, [])

  const loadEmps = useCallback(async () => {
    try {
      const r = await api.get('/api/employees', { params: { status: statusF === 'all' ? 'all' : statusF, dept: dept || undefined, limit: 500, search: search || undefined } })
      setEmps(r.data?.data || [])
    } catch { setEmps([]) }
  }, [statusF, dept, search])

  useEffect(() => { loadCore(); api.get('/api/employees/departments').then(r => setDepts(r.data || [])).catch(() => {}) }, [loadCore])
  useEffect(() => { loadEmps() }, [loadEmps])

  const loadContracts = useCallback(async (emp: Emp) => {
    setSelected(emp)
    try { const r = await api.get(`/api/contracts/employee/${emp.id}`); setContracts(r.data?.data || []) }
    catch { setContracts([]) }
  }, [])

  async function saveContract() {
    if (!editContract) return
    try {
      const payload = { ...editContract, employee_id: editContract.employee_id ?? selected?.id }
      if (editContract.id) await api.put(`/api/contracts/${editContract.id}`, payload)
      else await api.post('/api/contracts', payload)
      setEditContract(null); setMsg('Contrato guardado.')
      if (selected) loadContracts(selected)
      loadCore()
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al guardar contrato') }
  }

  async function removeContract(c: Contract) {
    if (!confirm('¿Eliminar este contrato?')) return
    try { await api.delete(`/api/contracts/${c.id}`); if (selected) loadContracts(selected); loadCore() }
    catch { setMsg('No se pudo eliminar.') }
  }

  async function doEgreso(termination_date: string, reason: string) {
    if (!egreso) return
    try {
      await api.post('/api/contracts/egreso', { employee_id: egreso.id, termination_date, reason })
      setEgreso(null); setMsg('Egreso registrado.'); loadEmps(); loadCore()
      if (selected?.id === egreso.id) setSelected(null)
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Error al registrar egreso') }
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-teal-400 to-emerald-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(20,184,166,0.5)]">
            <FileSignature size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Ingresos / Egresos</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Contratos, período de prueba, alertas de vencimiento y baja de personal.</p>
          </div>
        </div>
        {canEdit && (
          <button onClick={() => setShowConfig(s => !s)} className="px-3 py-2 rounded-xl border border-slate-200 hover:border-teal-300 text-sm text-slate-600 dark:border-white/[0.08] dark:text-white/70 flex items-center gap-2">
            <Settings2 size={15} /> Configuración
          </button>
        )}
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}

      {showConfig && cfg && canEdit && <ConfigPanel cfg={cfg} onSaved={(c) => { setCfg(c); setShowConfig(false); loadCore() }} />}

      {/* Alertas */}
      {(alerts.expiring.length > 0 || alerts.probation.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <AlertCard title="Contratos por vencer" rows={alerts.expiring} dateKey="end_date" color="amber" />
          <AlertCard title="Fin de período de prueba" rows={alerts.probation} dateKey="probation_end_date" color="violet" />
        </div>
      )}

      {/* Filtros */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 flex-wrap dark:bg-white/[0.04] dark:border-white/[0.06]">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar empleado…"
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        <select value={dept} onChange={e => setDept(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
          <option value="">Todos los departamentos</option>
          {depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={statusF} onChange={e => setStatusF(e.target.value as any)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
          <option value="active">Activos</option><option value="inactive">Inactivos (egresados)</option><option value="all">Todos</option>
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Lista de empleados */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06] sticky top-0">
                <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                  <th className="px-3 py-2">Empleado</th><th className="px-3 py-2">Ingreso</th><th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                {emps.map(e => (
                  <tr key={e.id} className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.04] ${selected?.id === e.id ? 'bg-teal-50 dark:bg-teal-400/[0.06]' : ''}`} onClick={() => loadContracts(e)}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800 dark:text-white/90">{e.full_name}
                        {e.status !== 'active' && <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/40">egresado</span>}
                      </div>
                      <div className="text-[11px] text-slate-400 dark:text-white/30"><span className="font-mono">{e.code}</span> · {e.department || '—'}</div>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-white/50">{fmt(e.hire_date)}</td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && e.status === 'active' && (
                        <button onClick={ev => { ev.stopPropagation(); setEgreso(e) }} title="Registrar egreso"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-400/10"><LogOut size={15} /></button>
                      )}
                    </td>
                  </tr>
                ))}
                {emps.length === 0 && <tr><td colSpan={3} className="px-3 py-8 text-center text-slate-400 dark:text-white/30 text-sm">Sin empleados.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Contratos del empleado seleccionado */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          {!selected ? (
            <p className="text-slate-400 text-sm py-10 text-center dark:text-white/30">Elegí un empleado para ver y gestionar sus contratos.</p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="font-bold text-slate-900 dark:text-white">{selected.full_name}</h2>
                  <p className="text-xs text-slate-400 dark:text-white/30">Contratos e historial</p>
                </div>
                {canEdit && (
                  <button onClick={() => setEditContract({ employee_id: selected.id, type: cfg?.contract_types[0] || '', start_date: '', status: 'active' })}
                    className="px-3 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm flex items-center gap-1.5"><Plus size={14} /> Contrato</button>
                )}
              </div>
              {contracts.length === 0 ? (
                <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin contratos registrados.</p>
              ) : (
                <div className="space-y-2">
                  {contracts.map(c => (
                    <div key={c.id} className="p-3 rounded-xl border border-slate-100 dark:border-white/[0.06]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-slate-800 dark:text-white/90">{c.type}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${c.status === 'active' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-white/40'}`}>{c.status === 'active' ? 'Vigente' : 'Finalizado'}</span>
                        {canEdit && (
                          <span className="ml-auto flex items-center gap-1">
                            <button onClick={() => setEditContract(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-teal-600"><Pencil size={14} /></button>
                            <button onClick={() => removeContract(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-white/50 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                        <span>Inicio: <b>{fmt(c.start_date)}</b></span>
                        <span>Fin: <b>{fmt(c.end_date)}</b></span>
                        {c.probation_end_date && <span className="inline-flex items-center gap-1"><Clock size={11} /> Prueba hasta {fmt(c.probation_end_date)}</span>}
                        {c.salary != null && <span>Salario: ₲ {gs(c.salary)}</span>}
                      </div>
                      {c.note && <p className="text-[11px] text-slate-400 dark:text-white/30 mt-1">{c.note}</p>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {editContract && cfg && (
        <ContractModal contract={editContract} types={cfg.contract_types} onClose={() => setEditContract(null)} onChange={setEditContract} onSave={saveContract} />
      )}
      {egreso && <EgresoModal emp={egreso} onClose={() => setEgreso(null)} onSubmit={doEgreso} />}
    </div>
  )
}

function AlertCard({ title, rows, dateKey, color }: { title: string; rows: AlertRow[]; dateKey: 'end_date' | 'probation_end_date'; color: 'amber' | 'violet' }) {
  const cls = color === 'amber'
    ? 'bg-amber-50 border-amber-200 dark:bg-amber-400/[0.06] dark:border-amber-400/30'
    : 'bg-violet-50 border-violet-200 dark:bg-violet-400/[0.06] dark:border-violet-400/30'
  return (
    <div className={`rounded-2xl border p-4 ${cls}`}>
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={15} className={color === 'amber' ? 'text-amber-600' : 'text-violet-600'} />
        <h3 className="font-bold text-sm text-slate-800 dark:text-white/90">{title}</h3>
        <span className="text-xs text-slate-400 dark:text-white/30">({rows.length})</span>
      </div>
      {rows.length === 0 ? <p className="text-xs text-slate-400 dark:text-white/30">Sin alertas.</p> : (
        <ul className="space-y-1">
          {rows.map(r => (
            <li key={r.id} className="text-xs flex items-center justify-between gap-2">
              <span className="text-slate-700 dark:text-white/70 truncate"><span className="font-mono text-slate-400">{r.code}</span> {r.employee_name} · {r.type}</span>
              <span className="tabular-nums shrink-0 text-slate-500 dark:text-white/50">{fmt((r as any)[dateKey])} · <b>{r.days_left}d</b></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ConfigPanel({ cfg, onSaved }: { cfg: Config; onSaved: (c: Config) => void }) {
  const [types, setTypes] = useState(cfg.contract_types.join(', '))
  const [expiry, setExpiry] = useState(String(cfg.expiry_alert_days))
  const [prob, setProb] = useState(String(cfg.probation_alert_days))
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    try {
      const r = await api.put('/api/contracts/config', {
        contract_types: types.split(',').map(s => s.trim()).filter(Boolean),
        expiry_alert_days: parseInt(expiry, 10) || 0,
        probation_alert_days: parseInt(prob, 10) || 0,
      })
      onSaved(r.data)
    } catch { /* noop */ } finally { setSaving(false) }
  }
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06] space-y-3">
      <h2 className="font-bold text-slate-900 dark:text-white">Configuración de contratos</h2>
      <div>
        <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Tipos de contrato (separados por comas)</label>
        <input value={types} onChange={e => setTypes(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Alerta de vencimiento (días antes)</label>
          <input type="number" min={0} value={expiry} onChange={e => setExpiry(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Alerta fin de prueba (días antes)</label>
          <input type="number" min={0} value={prob} onChange={e => setProb(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
        </div>
      </div>
      <button onClick={save} disabled={saving} className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm flex items-center gap-2 disabled:opacity-50"><Save size={15} /> {saving ? 'Guardando...' : 'Guardar'}</button>
    </div>
  )
}

function ContractModal({ contract, types, onClose, onChange, onSave }: {
  contract: Partial<Contract>; types: string[]
  onClose: () => void; onChange: (c: Partial<Contract>) => void; onSave: () => void
}) {
  const set = (patch: Partial<Contract>) => onChange({ ...contract, ...patch })
  const inputCls = 'w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent'
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between">
          <h3 className="font-bold text-slate-900 dark:text-white">{contract.id ? 'Editar contrato' : 'Nuevo contrato'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Tipo</label>
            <select value={contract.type || ''} onChange={e => set({ type: e.target.value })} className={inputCls}>
              <option value="">—</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Inicio</label>
              <input type="date" value={contract.start_date || ''} onChange={e => set({ start_date: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Fin (opcional)</label>
              <input type="date" value={contract.end_date || ''} onChange={e => set({ end_date: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Fin de prueba (opcional)</label>
              <input type="date" value={contract.probation_end_date || ''} onChange={e => set({ probation_end_date: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Salario (opcional)</label>
              <input type="number" value={contract.salary ?? ''} onChange={e => set({ salary: e.target.value === '' ? null : +e.target.value })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Estado</label>
            <select value={contract.status || 'active'} onChange={e => set({ status: e.target.value })} className={inputCls}>
              <option value="active">Vigente</option><option value="ended">Finalizado</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Nota</label>
            <input value={contract.note || ''} onChange={e => set({ note: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 dark:border-white/[0.06] flex gap-2">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={onSave} className="flex-1 bg-teal-600 hover:bg-teal-700 text-white rounded-xl py-2.5 text-sm font-medium">Guardar</button>
        </div>
      </div>
    </div>
  )
}

function EgresoModal({ emp, onClose, onSubmit }: { emp: Emp; onClose: () => void; onSubmit: (date: string, reason: string) => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
          <h3 className="font-bold text-slate-900 dark:text-white">Registrar egreso</h3>
          <p className="text-xs text-slate-400 dark:text-white/30 mt-0.5">{emp.full_name} · da de baja al empleado y cierra sus contratos vigentes.</p>
        </div>
        <div className="p-6 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Fecha de egreso</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Motivo</label>
            <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Renuncia, despido, fin de contrato…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none dark:border-white/[0.08] bg-transparent" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 dark:border-white/[0.06] flex gap-2">
          <button onClick={onClose} className="flex-1 border border-slate-200 rounded-xl py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
          <button onClick={() => date && onSubmit(date, reason)} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white rounded-xl py-2.5 text-sm font-medium">Confirmar egreso</button>
        </div>
      </div>
    </div>
  )
}
