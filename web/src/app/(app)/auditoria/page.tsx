'use client'
import { useEffect, useState } from 'react'
import {
  FileText, Filter, User as UserIcon, Globe, Clock, Search, Download,
  CheckCircle, XCircle, AlertCircle, Settings as SettingsIcon, LogIn, Shield,
  Eye, ChevronLeft, ChevronRight, X
} from 'lucide-react'
import { api } from '@/lib/api'

interface Event {
  id: number; user_id: number | null; username: string | null
  action: string; entity: string | null; entity_id: string | null
  ip: string | null; user_agent: string | null
  details: string | null; created_at: string
  actor_name: string | null; actor_role: string | null
}
interface ActionCount { action: string; total: number }
interface EntityCount { entity: string; total: number }

const ACTION_META: Record<string, { color: string; icon: any; label: string }> = {
  login_ok:           { color: 'bg-emerald-100 text-emerald-800', icon: LogIn,        label: 'Login OK' },
  login_fail:         { color: 'bg-red-100 text-red-800',         icon: XCircle,      label: 'Login falló' },
  logout:             { color: 'bg-slate-100 text-slate-700',     icon: LogIn,        label: 'Logout' },
  settings_update:    { color: 'bg-blue-100 text-blue-800',       icon: SettingsIcon, label: 'Config actualizada' },
  permission_create:  { color: 'bg-purple-100 text-purple-800',   icon: FileText,     label: 'Permiso creado' },
  permission_approve: { color: 'bg-emerald-100 text-emerald-800', icon: CheckCircle,  label: 'Permiso aprobado' },
  permission_reject:  { color: 'bg-red-100 text-red-800',         icon: XCircle,      label: 'Permiso rechazado' },
  employee_create:    { color: 'bg-indigo-100 text-indigo-800',   icon: UserIcon,     label: 'Empleado creado' },
  employee_update:    { color: 'bg-blue-100 text-blue-800',       icon: UserIcon,     label: 'Empleado modificado' },
  employee_delete:    { color: 'bg-red-100 text-red-800',         icon: XCircle,      label: 'Empleado eliminado' },
  user_create:        { color: 'bg-indigo-100 text-indigo-800',   icon: Shield,       label: 'Usuario creado' },
  user_update:        { color: 'bg-blue-100 text-blue-800',       icon: Shield,       label: 'Usuario modificado' },
  checkin_self:       { color: 'bg-emerald-100 text-emerald-800', icon: Clock,        label: 'Auto-marcación' },
  export:             { color: 'bg-slate-100 text-slate-700',     icon: Download,     label: 'Export' },
}

function todayISO()     { return new Date().toISOString().slice(0,10) }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10)
}

const PAGE_SIZE = 50

export default function AuditoriaPage() {
  const [events, setEvents] = useState<Event[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [actions, setActions] = useState<ActionCount[]>([])
  const [entities, setEntities] = useState<EntityCount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Event | null>(null)
  const [filter, setFilter] = useState({
    action: '', entity: '', q: '', fulltext: '',
    from: daysAgoISO(7), to: todayISO(),
  })

  async function load() {
    setLoading(true); setError('')
    try {
      const params = { ...filter, limit: PAGE_SIZE, offset: page * PAGE_SIZE }
      const [{ data: ev }, { data: ac }, { data: en }] = await Promise.all([
        api.get('/api/audit', { params }),
        api.get('/api/audit/actions'),
        api.get('/api/audit/entities'),
      ])
      setEvents(ev.rows || []); setTotal(ev.total || 0)
      setActions(ac); setEntities(en)
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [filter.action, filter.entity, filter.from, filter.to, page])

  async function exportCsv() {
    try {
      const res = await api.get('/api/audit/export.csv', { params: filter, responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url; a.download = `auditoria_${todayISO()}.csv`; a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) { setError(e.response?.data?.error || 'Error al exportar') }
  }

  async function exportPdf() {
    try {
      const { downloadUrl } = await import('@/lib/api')
      const params = new URLSearchParams()
      Object.entries(filter).forEach(([k, v]) => { if (v) params.set(k, v) })
      window.open(downloadUrl('/api/audit/export.pdf') + '&' + params.toString(), '_blank')
    } catch (e: any) { setError('Error al generar PDF') }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-slate-800 flex items-center justify-center">
            <FileText className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Auditoría</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Registro de eventos del sistema. {total.toLocaleString()} evento(s) en el filtro actual.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={exportCsv}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm">
            <Download size={14} /> CSV
          </button>
          <button onClick={exportPdf}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm">
            <FileText size={14} /> PDF firmado
          </button>
        </div>
      </div>

      {/* KPIs por acción */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {actions.slice(0, 6).map(a => {
          const meta = ACTION_META[a.action] || { color: 'bg-slate-100 text-slate-700', icon: Shield, label: a.action }
          return (
            <button
              key={a.action}
              onClick={() => { setFilter(f => ({ ...f, action: f.action === a.action ? '' : a.action })); setPage(0) }}
              className={`p-3 rounded-xl border text-left transition-all ${filter.action === a.action ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200 hover:border-slate-300'} bg-white`}
            >
              <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${meta.color}`}>
                <meta.icon size={12} /> {meta.label}
              </div>
              <p className="text-2xl font-bold text-slate-900 mt-2 dark:text-white">{a.total.toLocaleString()}</p>
            </button>
          )
        })}
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex flex-wrap items-end gap-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2 text-slate-500 text-sm dark:text-white/40">
          <Filter size={16} /> Filtros
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Acción</label>
          <select value={filter.action} onChange={e => { setFilter(f => ({ ...f, action: e.target.value })); setPage(0) }}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm min-w-[180px] dark:border-white/[0.08]">
            <option value="">— Todas —</option>
            {actions.map(a => <option key={a.action} value={a.action}>{a.action} ({a.total})</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Entidad</label>
          <select value={filter.entity} onChange={e => { setFilter(f => ({ ...f, entity: e.target.value })); setPage(0) }}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm min-w-[160px] dark:border-white/[0.08]">
            <option value="">— Todas —</option>
            {entities.map(a => <option key={a.entity} value={a.entity}>{a.entity} ({a.total})</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Buscar (LIKE)</label>
          <input value={filter.q} onChange={e => setFilter(f => ({ ...f, q: e.target.value, fulltext: '' }))}
            onKeyDown={e => { if (e.key === 'Enter') { setPage(0); load() } }}
            placeholder="admin, error, 192.168..."
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 flex items-center gap-1 dark:text-white/60">
            <Search size={10} /> Búsqueda FULLTEXT
          </label>
          <input value={filter.fulltext} onChange={e => setFilter(f => ({ ...f, fulltext: e.target.value, q: '' }))}
            onKeyDown={e => { if (e.key === 'Enter') { setPage(0); load() } }}
            placeholder='+login -fail  (boolean mode)'
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Desde</label>
          <input type="date" value={filter.from} onChange={e => { setFilter(f => ({ ...f, from: e.target.value })); setPage(0) }}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Hasta</label>
          <input type="date" value={filter.to} onChange={e => { setFilter(f => ({ ...f, to: e.target.value })); setPage(0) }}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </div>
        <button onClick={() => { setPage(0); load() }}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm">
          <Search size={14} /> Buscar
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-red-900">{error}</div>
        </div>
      )}

      {/* Tabla */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {loading ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center text-slate-400 space-y-2 dark:text-white/30">
            <FileText className="mx-auto text-slate-300" size={40} />
            <p>Sin eventos en el rango.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Cuándo</th>
                <th className="px-4 py-3">Usuario</th>
                <th className="px-4 py-3">Acción</th>
                <th className="px-4 py-3">Entidad</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Detalles</th>
                <th className="px-4 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {events.map(e => {
                const meta = ACTION_META[e.action] || { color: 'bg-slate-100 text-slate-700', icon: Shield, label: e.action }
                const Icon = meta.icon
                return (
                  <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                    <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap dark:text-white/40">
                      <div className="flex items-center gap-1"><Clock size={12} /> {new Date(e.created_at).toLocaleString()}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <UserIcon size={14} className="text-slate-400 dark:text-white/30" />
                        <div>
                          <p className="text-slate-900 font-medium text-xs dark:text-white">{e.actor_name || e.username || '—'}</p>
                          {e.actor_role && <p className="text-[10px] text-slate-400 capitalize dark:text-white/30">{e.actor_role.replace('_',' ')}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${meta.color}`}>
                        <Icon size={12} /> {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600 dark:text-white/60">
                      {e.entity ? <span>{e.entity}{e.entity_id ? ` #${e.entity_id}` : ''}</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 font-mono dark:text-white/40">
                      <div className="flex items-center gap-1">
                        <Globe size={12} /> {e.ip || '—'}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 max-w-xs dark:text-white/40">
                      {e.details ? <pre className="truncate text-[10px] font-mono">{e.details}</pre> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <button onClick={() => setDetail(e)} className="p-1 rounded hover:bg-slate-100 text-slate-500 dark:text-white/40 dark:hover:bg-white/[0.06]">
                        <Eye size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {/* Paginación */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm text-slate-500 dark:text-white/40 dark:border-white/[0.06]">
            <span>Página {page + 1} de {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-3 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                <ChevronLeft size={14} /> Anterior
              </button>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                Siguiente <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modal detalle */}
      {detail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setDetail(null)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-auto dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/[0.06]">
              <h3 className="font-semibold text-slate-900 dark:text-white">Evento #{detail.id}</h3>
              <button onClick={() => setDetail(null)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-3 text-sm">
              <Row k="Fecha" v={new Date(detail.created_at).toLocaleString()} />
              <Row k="Acción" v={detail.action} />
              <Row k="Usuario" v={`${detail.actor_name || detail.username || '—'} (${detail.actor_role || 'sin rol'})`} />
              <Row k="Entidad" v={detail.entity ? `${detail.entity}${detail.entity_id ? ` #${detail.entity_id}` : ''}` : '—'} />
              <Row k="IP" v={detail.ip || '—'} />
              <Row k="User-Agent" v={detail.user_agent || '—'} />
              <div>
                <div className="text-xs text-slate-500 mb-1 dark:text-white/40">Detalles (JSON)</div>
                <pre className="bg-slate-50 rounded-lg p-3 text-xs overflow-auto max-h-72 font-mono dark:bg-white/[0.03]">
                  {(() => { try { return JSON.stringify(JSON.parse(detail.details || '{}'), null, 2) } catch { return detail.details || '—' } })()}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <div className="text-slate-500 text-xs dark:text-white/40">{k}</div>
      <div className="text-slate-900 text-sm break-all dark:text-white">{v}</div>
    </div>
  )
}
