'use client'
/**
 * Aprobación y firma del reporte mensual de marcadas.
 *
 * Circuito de aprobación por niveles: coordinador → gerente de área → RR.HH.
 * Esta página SÓLO consume endpoints ya existentes de la API (no crea datos):
 *   - POST /api/reports/monthly/approvals            → enviar período a aprobación
 *   - GET  /api/reports/monthly/approvals/inbox      → pendientes que le tocan al usuario
 *   - GET  /api/reports/monthly/approvals/status     → estado del período
 *   - POST /api/reports/monthly/approvals/:id/approve|reject
 *   - GET  /api/reports/monthly/approvals/:id/signed-pdf (sólo cuando está approved)
 *
 * Sigue los patrones visuales de /aprobaciones (bandeja de permisos) y /reportes.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  FileSignature, Send, Check, X, Clock, Calendar, Download,
  AlertCircle, BadgeCheck, Building2, UserCircle2,
} from 'lucide-react'
import { api, downloadUrl } from '@/lib/api'
import { useCurrentUser, hasRole } from '@/lib/useCurrentUser'

type ApprovalState =
  | 'pending' | 'level1_ok' | 'level2_ok' | 'approved' | 'rejected' | 'cancelled'

interface InboxItem {
  id: number
  year: number
  month: number
  department_id: number | null
  department_name?: string | null
  approval_state: ApprovalState
  requested_by_name?: string | null
  created_at?: string | null
}

interface PeriodStatus {
  id?: number
  year: number
  month: number
  department_id?: number | null
  department_name?: string | null
  approval_state?: ApprovalState | null
  signed_by_name?: string | null
  signed_at?: string | null
}

interface Department { id: number; name: string }

const STATE_LABEL: Record<ApprovalState, string> = {
  pending:   'Pendiente — Coordinador',
  level1_ok: 'Coordinador OK — Gerente de área pendiente',
  level2_ok: 'Gerente OK — RR.HH. pendiente',
  approved:  'Aprobado y firmado',
  rejected:  'Rechazado',
  cancelled: 'Cancelado',
}

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

function periodLabel(year: number, month: number) {
  return `${MESES[month - 1] || month} ${year}`
}

// Mensaje amable a partir de un error de axios/red.
function friendlyError(e: any): string {
  return e?.response?.data?.error || e?.message || 'Ocurrió un error inesperado. Intentá de nuevo.'
}

export default function AprobacionReportesPage() {
  const user = useCurrentUser()
  const now = new Date()

  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [deptId, setDeptId] = useState('')

  const [banner, setBanner] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [actioning, setActioning] = useState<number | null>(null)

  // ── Bandeja de pendientes ────────────────────────────────────────
  const inboxQ = useQuery<InboxItem[]>({
    queryKey: ['monthly-approvals-inbox'],
    queryFn: () => api.get('/api/reports/monthly/approvals/inbox').then(r => {
      // La API envuelve la lista en { data: [...] }; toleramos ambas formas.
      const body = r.data
      const rows = (body && typeof body === 'object' && 'data' in body) ? body.data : body
      return (Array.isArray(rows) ? rows : []).map((it: Record<string, unknown>) => ({
        ...it,
        approval_state: (it.approval_state ?? it.status) as ApprovalState,
      })) as InboxItem[]
    }),
  })

  // ── Estado del período seleccionado ──────────────────────────────
  const statusQ = useQuery<PeriodStatus | null>({
    queryKey: ['monthly-approvals-status', year, month, deptId],
    queryFn: () =>
      api.get('/api/reports/monthly/approvals/status', {
        params: { year, month, ...(deptId ? { department_id: deptId } : {}) },
      }).then(r => {
        // La API envuelve el objeto en { data: {...} } (o { data: null }).
        const body = r.data
        const row = (body && typeof body === 'object' && 'data' in body) ? body.data : body
        return row
          ? { ...row, approval_state: (row.approval_state ?? row.status) as ApprovalState } as PeriodStatus
          : null
      }),
  })

  // ── Departamentos (para el selector, si el rol lo permite) ───────
  const canPickDept = hasRole(user, 'admin', 'gth', 'gestor')
  const deptsQ = useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
    enabled: canPickDept,
  })

  async function enviarAprobacion() {
    setBanner(null)
    setSending(true)
    try {
      await api.post('/api/reports/monthly/approvals', {
        year, month,
        ...(deptId ? { department_id: Number(deptId) } : {}),
      })
      setBanner({ kind: 'ok', text: `Reporte de ${periodLabel(year, month)} enviado a aprobación.` })
      await Promise.all([statusQ.refetch(), inboxQ.refetch()])
    } catch (e: any) {
      setBanner({ kind: 'error', text: friendlyError(e) })
    } finally {
      setSending(false)
    }
  }

  async function aprobar(item: InboxItem) {
    const note = (typeof window !== 'undefined' ? window.prompt('Nota de aprobación (opcional):') : '') || undefined
    setBanner(null)
    setActioning(item.id)
    try {
      await api.post(`/api/reports/monthly/approvals/${item.id}/approve`, { note })
      await Promise.all([inboxQ.refetch(), statusQ.refetch()])
    } catch (e: any) {
      setBanner({ kind: 'error', text: friendlyError(e) })
    } finally {
      setActioning(null)
    }
  }

  async function rechazar(item: InboxItem) {
    const reason = typeof window !== 'undefined' ? window.prompt('Motivo del rechazo (requerido):') : null
    if (!reason) return
    setBanner(null)
    setActioning(item.id)
    try {
      await api.post(`/api/reports/monthly/approvals/${item.id}/reject`, { reason })
      await Promise.all([inboxQ.refetch(), statusQ.refetch()])
    } catch (e: any) {
      setBanner({ kind: 'error', text: friendlyError(e) })
    } finally {
      setActioning(null)
    }
  }

  function descargarFirmado(id: number) {
    if (typeof window !== 'undefined') {
      window.open(downloadUrl(`/api/reports/monthly/approvals/${id}/signed-pdf`), '_blank')
    }
  }

  const status = statusQ.data
  const inbox = inboxQ.data ?? []

  const roleLabel = hasRole(user, 'coordinator') && user?.role === 'coordinator' ? 'Coordinador (Nivel 1)'
    : user?.role === 'manager' ? 'Gerente de área (Nivel 2)'
    : hasRole(user, 'gth', 'hr') && (user?.role === 'gth' || user?.role === 'hr') ? 'RR.HH. (firma final)'
    : 'Aprobación de reportes'

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center">
          <FileSignature className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Aprobación de reportes</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">
            {roleLabel}. Circuito de firma del reporte mensual de marcadas: coordinador → gerente de área → RR.HH.
          </p>
        </div>
      </div>

      {banner && (
        <div className={`rounded-xl p-4 flex items-start gap-3 text-sm border ${
          banner.kind === 'error'
            ? 'bg-red-50 border-red-200 text-red-900 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-200'
            : 'bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-200'
        }`}>
          {banner.kind === 'error'
            ? <AlertCircle className="shrink-0 mt-0.5" size={18} />
            : <BadgeCheck className="shrink-0 mt-0.5" size={18} />}
          <div>{banner.text}</div>
        </div>
      )}

      {/* ── Panel: enviar período a aprobación + estado actual ─────── */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <Send size={16} className="text-blue-600" /> Enviar a aprobación
        </h2>

        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Mes</label>
            <select value={month} onChange={e => setMonth(+e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-transparent dark:border-white/[0.08] dark:text-white">
              {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Año</label>
            <select value={year} onChange={e => setYear(+e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-transparent dark:border-white/[0.08] dark:text-white">
              {[now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y =>
                <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          {canPickDept && (
            <div>
              <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Departamento</label>
              <select value={deptId} onChange={e => setDeptId(e.target.value)}
                className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white dark:bg-transparent dark:border-white/[0.08] dark:text-white">
                <option value="">Todos</option>
                {(deptsQ.data || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          <button
            onClick={enviarAprobacion}
            disabled={sending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50">
            <Send size={14} /> {sending ? 'Enviando…' : 'Enviar a aprobación'}
          </button>
        </div>

        {/* Estado del período seleccionado */}
        <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 dark:bg-white/[0.03] dark:border-white/[0.06]">
          {statusQ.isLoading ? (
            <p className="text-sm text-slate-400 dark:text-white/30">Consultando estado…</p>
          ) : statusQ.isError ? (
            <p className="text-sm text-slate-500 dark:text-white/40 flex items-center gap-2">
              <AlertCircle size={14} /> No se pudo consultar el estado del período.
            </p>
          ) : !status || !status.approval_state ? (
            <p className="text-sm text-slate-500 dark:text-white/40 flex items-center gap-2">
              <Calendar size={14} /> {periodLabel(year, month)}: sin circuito de aprobación iniciado.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-slate-700 dark:text-white/80 flex items-center gap-1.5">
                <Calendar size={14} /> {periodLabel(status.year, status.month)}
              </span>
              <StateBadge s={status.approval_state} />
              {status.approval_state === 'approved' && (
                <>
                  {(status.signed_by_name || status.signed_at) && (
                    <span className="text-xs text-slate-500 dark:text-white/40">
                      Firmado{status.signed_by_name ? ` por ${status.signed_by_name}` : ''}
                      {status.signed_at ? ` · ${new Date(status.signed_at).toLocaleString('es-PY')}` : ''}
                    </span>
                  )}
                  {status.id != null && (
                    <button
                      onClick={() => descargarFirmado(status.id!)}
                      className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium">
                      <Download size={12} /> Descargar reporte firmado
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Bandeja de pendientes ──────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-white/[0.06] flex items-center gap-2">
          <Clock size={16} className="text-blue-600" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Pendientes para aprobar</h2>
          {!inboxQ.isLoading && <span className="text-xs text-slate-400 ml-auto">{inbox.length}</span>}
        </div>

        {inboxQ.isLoading ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Cargando…</div>
        ) : inboxQ.isError ? (
          <div className="p-8 text-center text-slate-500 dark:text-white/40 space-y-2">
            <AlertCircle className="mx-auto text-slate-300" size={36} />
            <p>No se pudo cargar la bandeja. Actualizá la página o intentá más tarde.</p>
          </div>
        ) : inbox.length === 0 ? (
          <div className="p-10 text-center text-slate-400 space-y-2 dark:text-white/30">
            <BadgeCheck className="mx-auto text-slate-300" size={40} />
            <p>No hay reportes pendientes para tu aprobación. ¡Al día!</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
                <tr>
                  <th className="px-4 py-3">Período</th>
                  <th className="px-4 py-3">Departamento</th>
                  <th className="px-4 py-3">Solicitado por</th>
                  <th className="px-4 py-3">Estado / Nivel</th>
                  <th className="px-4 py-3 w-40"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {inbox.map(item => (
                  <tr key={item.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Calendar size={16} className="text-slate-400 dark:text-white/30" />
                        <span className="font-medium text-slate-900 dark:text-white">{periodLabel(item.year, item.month)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-white/60">
                      <span className="inline-flex items-center gap-1.5">
                        <Building2 size={14} className="text-slate-400 dark:text-white/30" />
                        {item.department_name || (item.department_id ? `Depto. ${item.department_id}` : 'Todos')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-white/60">
                      <span className="inline-flex items-center gap-1.5">
                        <UserCircle2 size={14} className="text-slate-400 dark:text-white/30" />
                        {item.requested_by_name || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StateBadge s={item.approval_state} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button disabled={actioning === item.id}
                          onClick={() => aprobar(item)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-medium disabled:opacity-50 dark:bg-emerald-500/10 dark:hover:bg-emerald-500/20 dark:text-emerald-300">
                          <Check size={14} /> Aprobar
                        </button>
                        <button disabled={actioning === item.id}
                          onClick={() => rechazar(item)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 text-xs font-medium disabled:opacity-50 dark:bg-red-500/10 dark:hover:bg-red-500/20 dark:text-red-300">
                          <X size={14} /> Rechazar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function StateBadge({ s }: { s: ApprovalState }) {
  const cfg: Record<ApprovalState, { bg: string; text: string; icon: any }> = {
    pending:   { bg: 'bg-amber-100',   text: 'text-amber-800',   icon: Clock },
    level1_ok: { bg: 'bg-blue-100',    text: 'text-blue-800',    icon: Clock },
    level2_ok: { bg: 'bg-indigo-100',  text: 'text-indigo-800',  icon: Clock },
    approved:  { bg: 'bg-emerald-100', text: 'text-emerald-800', icon: BadgeCheck },
    rejected:  { bg: 'bg-red-100',     text: 'text-red-800',     icon: X },
    cancelled: { bg: 'bg-slate-100',   text: 'text-slate-600',   icon: X },
  }
  const { bg, text, icon: Icon } = cfg[s]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${bg} ${text}`}>
      <Icon size={12} /> {STATE_LABEL[s]}
    </span>
  )
}
