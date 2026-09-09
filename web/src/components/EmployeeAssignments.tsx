'use client'
/**
 * EmployeeAssignments — Historial organizativo con vigencia efectiva (FASE F2).
 *
 * Superficie de UI para el writer append-only `POST /api/assignments/employee/:id`
 * (ya existente, fail-closed detrás de PEOPLE_WRITE_ENABLED). Muestra la línea de
 * tiempo de asignaciones (sucursal / departamento / centro de costo / cargo /
 * remuneración de referencia + vigencia) y permite crear una nueva vigencia, que
 * cierra automáticamente la anterior (append-only: nunca borra historial).
 *
 * El componente NO fabrica datos ni asume que la escritura está habilitada:
 *   - Si el GET de historial devuelve 403/404 (sin permiso o fuera de alcance),
 *     el panel no se renderiza.
 *   - Los errores del writer se muestran textualmente sin romper la vista:
 *       503 PEOPLE_WRITES_DISABLED → aviso "modo sólo lectura durante el rollout"
 *       409 ASSIGNMENT_OUT_OF_ORDER → fechas fuera de orden
 *       403 OUT_OF_SCOPE          → empleado/referencia fuera de alcance
 *       400 INCOHERENT_SCOPE / INVALID_DATE / *_NOT_FOUND → mensaje del servidor
 */

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Plus, Building2, MapPin, Coins, Briefcase, CheckCircle, AlertCircle, X, Lock } from 'lucide-react'
import { api } from '@/lib/api'
import { formatPYG } from '@/lib/currency'
import { useCurrentUser } from '@/lib/useCurrentUser'

// Roles que gestionan la organización del empleado. El permiso REAL lo impone el
// backend (`requirePermission('asignaciones','create')` + PEOPLE_WRITE_ENABLED);
// esto sólo decide si se ofrece el botón en la UI.
const MANAGE_ROLES = ['super_admin', 'admin', 'gth', 'hr']

type Assignment = {
  id: number
  branch_id: number | null
  department_id: number | null
  cost_center_id: number | null
  job_title: string | null
  reference_salary: number | null
  valid_from: string | null
  valid_to: string | null
  change_reason: string | null
  branch_name: string | null
  department_name: string | null
  cost_center_name: string | null
}

type Ref = { id: number; name: string }

function fmtCivilDate(v: string | null | undefined): string {
  if (!v) return '—'
  const s = String(v).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return '—'
  return `${d}/${m}/${y}`
}

const emptyForm = {
  valid_from: '',
  branch_id: '',
  department_id: '',
  cost_center_id: '',
  job_title: '',
  reference_salary: '',
  change_reason: '',
}

export default function EmployeeAssignments({ employeeId }: { employeeId: number }) {
  const qc = useQueryClient()
  const user = useCurrentUser()
  const canManage = MANAGE_ROLES.includes(String(user?.role || ''))

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [readOnly, setReadOnly] = useState(false)

  const { data, isLoading, isError } = useQuery<{ employee_id: number; data: Assignment[] }>({
    queryKey: ['employee-assignments', employeeId],
    queryFn: () => api.get(`/api/assignments/employee/${employeeId}`).then(r => r.data),
    retry: false,
  })

  // Catálogos para los selectores de referencias. Se cargan sólo si el actor
  // puede gestionar (para no disparar 403 innecesarios). cost-centers requiere
  // su propio permiso: si falla, el selector queda vacío sin romper el form.
  const { data: branches } = useQuery<Ref[]>({
    queryKey: ['ref', 'branches'],
    queryFn: () => api.get('/api/branches').then(r => r.data),
    enabled: canManage, staleTime: 60_000, retry: false,
  })
  const { data: departments } = useQuery<Ref[]>({
    queryKey: ['ref', 'departments'],
    queryFn: () => api.get('/api/departments').then(r => r.data),
    enabled: canManage, staleTime: 60_000, retry: false,
  })
  const { data: costCenters } = useQuery<{ data: Ref[] }>({
    queryKey: ['ref', 'cost-centers'],
    queryFn: () => api.get('/api/cost-centers').then(r => r.data),
    enabled: canManage, staleTime: 60_000, retry: false,
  })
  const { data: jobTitles } = useQuery<{ data: { value: string; label: string }[] }>({
    queryKey: ['ref', 'job-titles'],
    queryFn: () => api.get('/api/catalogs/job-titles').then(r => r.data),
    enabled: canManage, staleTime: 60_000, retry: false,
  })

  const rows = data?.data || []
  const branchList = branches || []
  const deptList = departments || []
  const ccList = costCenters?.data || []
  const titleList = jobTitles?.data || []

  // El backend rechaza una vigencia con fecha ≤ a la vigencia abierta. Sugerimos
  // el mínimo (día siguiente) para orientar sin sustituir la validación del server.
  const minValidFrom = useMemo(() => {
    const open = rows.find(r => !r.valid_to)
    if (!open?.valid_from) return undefined
    const d = new Date(String(open.valid_from).slice(0, 10) + 'T12:00')
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }, [rows])

  function reset() {
    setForm({ ...emptyForm })
    setErr(null)
    setReadOnly(false)
  }

  async function submit() {
    setErr(null)
    setReadOnly(false)
    if (!form.valid_from) { setErr('La fecha de vigencia (desde) es obligatoria.'); return }
    // Al menos una referencia organizativa: evita crear una vigencia vacía.
    if (!form.branch_id && !form.department_id && !form.cost_center_id && !form.job_title.trim()) {
      setErr('Indicá al menos sucursal, departamento, centro de costo o cargo.')
      return
    }
    setBusy(true)
    try {
      await api.post(`/api/assignments/employee/${employeeId}`, {
        valid_from: form.valid_from,
        branch_id: form.branch_id ? Number(form.branch_id) : null,
        department_id: form.department_id ? Number(form.department_id) : null,
        cost_center_id: form.cost_center_id ? Number(form.cost_center_id) : null,
        job_title: form.job_title.trim() || null,
        reference_salary: form.reference_salary !== '' ? Number(form.reference_salary) : null,
        change_reason: form.change_reason.trim() || null,
      })
      qc.invalidateQueries({ queryKey: ['employee-assignments', employeeId] })
      setShowForm(false)
      reset()
    } catch (e: any) {
      const status = e?.response?.status
      const code = e?.response?.data?.code
      const msg = e?.response?.data?.error
      if (status === 503 || code === 'PEOPLE_WRITES_DISABLED') {
        setReadOnly(true)
      } else if (code === 'ASSIGNMENT_OUT_OF_ORDER') {
        setErr('La fecha debe ser posterior a la vigencia actualmente abierta.')
      } else if (code === 'OUT_OF_SCOPE') {
        setErr('El empleado o alguna referencia está fuera de tu alcance.')
      } else {
        setErr(msg || 'No se pudo registrar la asignación.')
      }
    } finally {
      setBusy(false)
    }
  }

  // Sin permiso de lectura (403) o empleado fuera de alcance (404): no mostramos
  // el panel. Mientras carga, tampoco parpadea un panel vacío.
  if (isError) return null
  if (isLoading) return null

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <History size={18} className="text-blue-600" />
          <h3 className="font-semibold text-slate-800 dark:text-white/90">Historial organizativo</h3>
          <span className="text-xs text-slate-400 dark:text-white/30">({rows.length})</span>
        </div>
        {canManage && (
          <button onClick={() => { setShowForm(s => !s); reset() }}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-xs font-medium transition-colors">
            <Plus size={13} /> Nueva asignación
          </button>
        )}
      </div>

      {showForm && (
        <div className="p-5 space-y-3 border-b border-slate-100 bg-blue-50/30 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <p className="text-xs text-slate-500 dark:text-white/40">
            Se registra una nueva vigencia (append-only): la asignación abierta anterior se cierra
            automáticamente el día previo a la nueva fecha. No se borra historial.
          </p>

          {readOnly && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.06] dark:text-amber-200">
              <Lock size={15} className="mt-0.5 shrink-0" />
              <span>La gestión de personas está en <strong>modo sólo lectura</strong> durante el rollout. No se registraron cambios.</span>
            </div>
          )}
          {err && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/[0.06] dark:text-red-200">
              <AlertCircle size={15} className="mt-0.5 shrink-0" /> <span>{err}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Vigente desde *</span>
              <input type="date" value={form.valid_from} min={minValidFrom}
                onChange={e => setForm(f => ({ ...f, valid_from: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Sucursal</span>
              <select value={form.branch_id} onChange={e => setForm(f => ({ ...f, branch_id: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
                <option value="">— Sin cambio —</option>
                {branchList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Departamento</span>
              <select value={form.department_id} onChange={e => setForm(f => ({ ...f, department_id: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
                <option value="">— Sin cambio —</option>
                {deptList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Centro de costo</span>
              <select value={form.cost_center_id} onChange={e => setForm(f => ({ ...f, cost_center_id: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
                <option value="">— Sin cambio —</option>
                {ccList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Cargo</span>
              <input list="assign-job-titles" value={form.job_title}
                onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))}
                placeholder="ej: Analista, Supervisor…"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
              <datalist id="assign-job-titles">
                {titleList.map(t => <option key={t.value} value={t.value} />)}
              </datalist>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-white/60">Remuneración de referencia</span>
              <input type="number" min="0" step="1" value={form.reference_salary}
                onChange={e => setForm(f => ({ ...f, reference_salary: e.target.value }))}
                placeholder="Opcional"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600 dark:text-white/60">Motivo del cambio</span>
            <input value={form.change_reason} maxLength={500}
              onChange={e => setForm(f => ({ ...f, change_reason: e.target.value }))}
              placeholder="Opcional (ej: promoción, traslado)"
              className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </label>

          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); reset() }}
              className="border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
            <button onClick={submit} disabled={busy}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-60">
              <CheckCircle size={14} /> {busy ? 'Guardando…' : 'Registrar vigencia'}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 && (
        <div className="text-center py-10 text-slate-400 dark:text-white/30">
          <History size={28} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">Sin asignaciones registradas</p>
        </div>
      )}

      <ol className="divide-y divide-slate-50 dark:divide-white/[0.05]">
        {rows.map(a => {
          const open = !a.valid_to
          return (
            <li key={a.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 flex flex-col items-center">
                  <span className={`h-2.5 w-2.5 rounded-full ${open ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-white/20'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500 dark:text-white/50">
                      {fmtCivilDate(a.valid_from)} → {a.valid_to ? fmtCivilDate(a.valid_to) : 'Vigente'}
                    </span>
                    {open && (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                        Vigente
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700 dark:text-white/80">
                    {a.branch_name && <span className="inline-flex items-center gap-1"><MapPin size={12} className="text-slate-400" /> {a.branch_name}</span>}
                    {a.department_name && <span className="inline-flex items-center gap-1"><Building2 size={12} className="text-slate-400" /> {a.department_name}</span>}
                    {a.cost_center_name && <span className="inline-flex items-center gap-1"><Coins size={12} className="text-slate-400" /> {a.cost_center_name}</span>}
                    {a.job_title && <span className="inline-flex items-center gap-1"><Briefcase size={12} className="text-slate-400" /> {a.job_title}</span>}
                  </div>
                  {(a.reference_salary != null || a.change_reason) && (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-400 dark:text-white/40">
                      {a.reference_salary != null && <span>Ref.: {formatPYG(a.reference_salary)}</span>}
                      {a.change_reason && <span className="italic">{a.change_reason}</span>}
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
