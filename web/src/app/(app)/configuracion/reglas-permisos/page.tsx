'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Save, Trash2, AlertCircle, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Rule {
  id: number
  department_id: number | null
  department_name: string | null
  permission_type: string | null
  requires_coordinator: number
  requires_manager: number
  requires_gth_final: number
  self_approve_max_days: number
  notes: string | null
  active: number
}
interface Dept { id: number; name: string }

const TYPES = ['vacation','sick','personal','maternity','paternity','study','legal','other']
const TYPE_LABEL: Record<string,string> = {
  vacation: 'Vacaciones', sick: 'Enfermedad', personal: 'Personal',
  maternity: 'Maternidad', paternity: 'Paternidad', study: 'Estudio',
  legal: 'Legal', other: 'Otro',
}

export default function ReglasPermisosPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [depts, setDepts] = useState<Dept[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [r, d] = await Promise.all([
        api.get('/api/approval-rules').then(r => r.data as Rule[]),
        api.get('/api/departments').then(r => r.data as Dept[]),
      ])
      setRules(r); setDepts(d)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function remove(id: number) {
    if (!confirm('¿Eliminar esta regla?')) return
    try {
      await api.delete(`/api/approval-rules/${id}`)
      load()
    } catch (e: any) { alert(e.response?.data?.error || e.message) }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/configuracion" className="p-2 rounded-xl hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Reglas de aprobación de permisos</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Configurá qué niveles son requeridos según departamento y tipo de permiso.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium">
          <Plus size={16} /> Nueva regla
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 text-sm">
        <p><b>Prioridad:</b> cuando se crea un permiso, se elige la regla más específica que aplique
        (departamento + tipo &gt; departamento &gt; global). Si no hay ninguna, se exigen los 3 niveles.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900">{error}</div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
            <tr>
              <th className="px-4 py-3">Alcance</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3 text-center">Coord.</th>
              <th className="px-4 py-3 text-center">Gerente</th>
              <th className="px-4 py-3 text-center">GTH final</th>
              <th className="px-4 py-3 text-center">Auto-aprob. (días)</th>
              <th className="px-4 py-3">Notas</th>
              <th className="px-4 py-3 w-32"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {loading && (
              <tr><td colSpan={8} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>
            )}
            {!loading && rules.map(r => (
              <tr key={r.id} className={r.active ? '' : 'opacity-40'}>
                <td className="px-4 py-3">
                  {r.department_name
                    ? <span className="text-slate-900 dark:text-white">{r.department_name}</span>
                    : <span className="text-slate-400 italic dark:text-white/30">Global</span>}
                </td>
                <td className="px-4 py-3">
                  {r.permission_type
                    ? <span className="inline-block px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-700 dark:bg-white/[0.06] dark:text-white/80">{TYPE_LABEL[r.permission_type]}</span>
                    : <span className="text-slate-400 italic dark:text-white/30">Todos</span>}
                </td>
                <td className="px-4 py-3 text-center">{r.requires_coordinator ? '✅' : '—'}</td>
                <td className="px-4 py-3 text-center">{r.requires_manager     ? '✅' : '—'}</td>
                <td className="px-4 py-3 text-center">{r.requires_gth_final   ? '✅' : '—'}</td>
                <td className="px-4 py-3 text-center text-slate-600 dark:text-white/60">{r.self_approve_max_days}</td>
                <td className="px-4 py-3 text-xs text-slate-500 max-w-xs truncate dark:text-white/40">{r.notes || '—'}</td>
                <td className="px-4 py-3 text-right space-x-1">
                  <button onClick={() => setEditing(r)} className="text-blue-600 hover:underline text-sm">Editar</button>
                  <button onClick={() => remove(r.id)} className="text-red-600 hover:underline text-sm">Eliminar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <RuleModal rule={editing} depts={depts} creating={creating}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
        />
      )}
    </div>
  )
}

function RuleModal({ rule, depts, creating, onClose, onSaved }: {
  rule: Rule | null; depts: Dept[]; creating: boolean
  onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    department_id: rule?.department_id?.toString() || '',
    permission_type: rule?.permission_type || '',
    requires_coordinator: rule ? !!rule.requires_coordinator : true,
    requires_manager:     rule ? !!rule.requires_manager     : true,
    requires_gth_final:   rule ? !!rule.requires_gth_final   : true,
    self_approve_max_days: rule?.self_approve_max_days ?? 0,
    notes: rule?.notes || '',
    active: rule ? !!rule.active : true,
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setSaving(true); setErr('')
    try {
      const payload = {
        department_id: form.department_id ? parseInt(form.department_id) : null,
        permission_type: form.permission_type || null,
        requires_coordinator: form.requires_coordinator ? 1 : 0,
        requires_manager:     form.requires_manager     ? 1 : 0,
        requires_gth_final:   form.requires_gth_final   ? 1 : 0,
        self_approve_max_days: parseInt(String(form.self_approve_max_days)) || 0,
        notes: form.notes || null,
        active: form.active ? 1 : 0,
      }
      if (creating) await api.post('/api/approval-rules', payload)
      else          await api.patch(`/api/approval-rules/${rule!.id}`, payload)
      onSaved()
    } catch (e: any) { setErr(e.response?.data?.error || e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {creating ? 'Nueva regla' : `Editar regla #${rule?.id}`}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Departamento</label>
            <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">— Global (cualquier depto) —</option>
              {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Tipo de permiso</label>
            <select value={form.permission_type} onChange={e => setForm({ ...form, permission_type: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">— Todos los tipos —</option>
              {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          {(['requires_coordinator','requires_manager','requires_gth_final'] as const).map(k => (
            <label key={k} className="flex items-center gap-2 text-sm text-slate-700 dark:text-white/80">
              <input type="checkbox" checked={(form as any)[k]}
                onChange={e => setForm({ ...form, [k]: e.target.checked })} />
              {k === 'requires_coordinator' && 'Requiere aprobación de Coordinador (Nivel 1)'}
              {k === 'requires_manager'     && 'Requiere aprobación de Gerente (Nivel 2)'}
              {k === 'requires_gth_final'   && 'Requiere aprobación final de GTH'}
            </label>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Auto-aprobación (días máx)</label>
            <input type="number" min={0} value={form.self_approve_max_days}
              onChange={e => setForm({ ...form, self_approve_max_days: parseInt(e.target.value) || 0 })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <p className="text-xs text-slate-400 mt-1 dark:text-white/30">Si &gt; 0, el empleado puede auto-aprobar pedidos &lt;= N días.</p>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-white/80">
              <input type="checkbox" checked={form.active}
                onChange={e => setForm({ ...form, active: e.target.checked })} />
              Regla activa
            </label>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Notas</label>
          <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" rows={2} />
        </div>

        {err && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}
