'use client'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import { Clock, Search, Plus, Download, RefreshCw, ChevronLeft, ChevronRight, Users, CheckCircle, AlertTriangle, XCircle } from 'lucide-react'
import { attendanceApi, employeesApi, api } from '@/lib/api'
import { getSocket } from '@/lib/socket'
import { fmtTimePy } from '@/lib/datetime'

// ─── Tipos ────────────────────────────────────────────────────────
interface AttendanceRow {
  id: number
  employee_id: number
  employee_name: string
  code: string
  department: string
  first_in: string | null
  last_out: string | null
  worked_minutes: number
  late_minutes: number
  overtime_minutes: number
  status: 'present' | 'absent' | 'late' | 'permission' | 'holiday' | 'weekend' | 'non_working' | 'unconfigured'
  scheduled_in: string
  scheduled_out: string
}

interface LiveLog {
  employeeId: number
  employeeName: string
  timestamp: string
  type: 'in' | 'out' | 'unknown'
  source: 'device' | 'mobile' | 'manual'
}

// ─── Helpers ──────────────────────────────────────────────────────
function minsToHM(mins: number | null) {
  if (!mins || mins <= 0) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

// Hora de la marcación SIEMPRE en zona de Paraguay (no la del navegador).
function fmtTime(dt: string | null) {
  return fmtTimePy(dt)
}

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  present:    { label: 'Presente',     cls: 'bg-green-50  text-green-700  border border-green-200'  },
  late:       { label: 'Retardo',      cls: 'bg-amber-50  text-amber-700  border border-amber-200'  },
  absent:     { label: 'Ausente',      cls: 'bg-red-50    text-red-700    border border-red-200'    },
  permission: { label: 'Permiso',      cls: 'bg-purple-50 text-purple-700 border border-purple-200' },
  holiday:    { label: 'Festivo',      cls: 'bg-blue-50   text-blue-700   border border-blue-200'   },
  weekend:    { label: 'Fin semana',   cls: 'bg-slate-50  text-slate-500  border border-slate-200'  },
  // Estados de la migración 074: un día NO laborable por configuración (puede
  // caer un martes) y un día del que no hay configuración suficiente. NO son
  // ausencias y no deben pintarse de rojo.
  non_working:  { label: 'No laborable',  cls: 'bg-slate-50  text-slate-500  border border-slate-200'  },
  unconfigured: { label: 'Sin configurar', cls: 'bg-slate-50 text-slate-400  border border-slate-200'  },
}

// Fallback NEUTRO para un estado no reconocido: nunca 'Ausente', que pintaría de
// rojo una fila que el estado nuevo afirma que NO es ausencia.
const STATUS_FALLBACK = { label: '—', cls: 'bg-slate-50 text-slate-400 border border-slate-200' }

const SOURCE_ICON: Record<string, string> = {
  device: '🖐️', mobile: '📱', manual: '✏️',
}

// ─── Exportar a CSV ───────────────────────────────────────────────
function exportCSV(rows: AttendanceRow[], date: string) {
  const header = ['Código','Nombre','Departamento','Estado','Entrada','Salida','Trabajado','Retardo (min)','Horas Extra','Horario']
  const lines = rows.map(r => [
    r.code, `"${r.employee_name}"`, `"${r.department || ''}"`,
    r.status, fmtTime(r.first_in), fmtTime(r.last_out),
    minsToHM(r.worked_minutes), r.late_minutes || 0,
    minsToHM(r.overtime_minutes),
    r.scheduled_in && r.scheduled_out
      ? `${r.scheduled_in?.slice(0,5)}-${r.scheduled_out?.slice(0,5)}`
      : ''
  ].join(','))
  const csv = [header.join(','), ...lines].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `asistencia_${date}.csv`; a.click(); URL.revokeObjectURL(url)
}

// ─── Modal marcaje manual ─────────────────────────────────────────
function ManualCheckinModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [employeeId, setEmployeeId] = useState('')
  const [timestamp, setTimestamp]   = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"))
  const [type, setType]             = useState<'in' | 'out'>('in')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')

  const { data } = useQuery({
    queryKey: ['employees-select'],
    queryFn: () => employeesApi.list({ limit: 500, status: 'active' }),
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await attendanceApi.registerManual({ employeeId: +employeeId, timestamp, type })
      onSaved(); onClose()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Error al registrar marcaje')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md dark:bg-white/[0.04]">
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-t-2xl px-6 py-4">
          <h2 className="text-lg font-bold text-white">Marcaje Manual</h2>
          <p className="text-blue-200 text-xs mt-0.5">Registrar entrada o salida manualmente</p>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Empleado <span className="text-red-500">*</span></label>
            <select required value={employeeId} onChange={e => setEmployeeId(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
              <option value="">Seleccionar...</option>
              {(data?.data || []).map((emp: any) => (
                <option key={emp.id} value={emp.id}>[{emp.code}] {emp.full_name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Tipo</label>
              <div className="flex gap-3 mt-2">
                {(['in', 'out'] as const).map(t => (
                  <label key={t} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 cursor-pointer transition-all ${
                    type === t ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600'
                  }`}>
                    <input type="radio" name="type" value={t} checked={type === t}
                      onChange={() => setType(t)} className="hidden" />
                    <span className="text-sm font-medium">{t === 'in' ? '→ Entrada' : '← Salida'}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Fecha y hora</label>
              <input type="datetime-local" required value={timestamp}
                onChange={e => setTimestamp(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
          </div>
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
          )}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors">
              {saving ? 'Guardando...' : 'Registrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────
export default function AsistenciaPage() {
  const today = format(new Date(), 'yyyy-MM-dd')

  const [date, setDate]       = useState(today)
  const [search, setSearch]   = useState('')
  const [dept, setDept]       = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [showModal, setModal] = useState(false)
  const [liveTop, setLiveTop] = useState<LiveLog[]>([])

  // Departamentos
  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => ({ data: r.data })),
    staleTime: 300_000,
  })

  // Datos del día
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['attendance-by-date', date, dept],
    queryFn: () => attendanceApi.byDate({ date, dept: dept || undefined, limit: 500 }),
    staleTime: 30_000,
  })

  // Socket.io — tiempo real
  useEffect(() => {
    const socket = getSocket()
    socket.on('attendance:new', (event: LiveLog) => {
      setLiveTop(prev => [event, ...prev].slice(0, 8))
      if (date === today) refetch()
    })
    return () => { socket.off('attendance:new') }
  }, [date, today, refetch])

  const rows: AttendanceRow[] = (data || [])
  const filtered = rows.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false
    if (!search) return true
    const q = search.toLowerCase()
    return (r.employee_name || '').toLowerCase().includes(q) || (r.code || '').toLowerCase().includes(q)
  })

  // Stats
  const present  = rows.filter(r => r.status === 'present').length
  const late     = rows.filter(r => r.status === 'late').length
  const absent   = rows.filter(r => r.status === 'absent').length
  const perm     = rows.filter(r => r.status === 'permission').length
  const total    = rows.filter(r => r.status !== 'weekend' && r.status !== 'holiday').length
  const totalWorked = rows.reduce((a, r) => a + (r.worked_minutes || 0), 0)

  // Navegación de fecha
  function changeDate(days: number) {
    const d = new Date(date + 'T12:00')
    d.setDate(d.getDate() + days)
    const nd = format(d, 'yyyy-MM-dd')
    if (nd <= today) setDate(nd)
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(34,211,238,0.5)]">
            <Clock size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Asistencia</h1>
            <p className="text-sm text-slate-500 capitalize dark:text-white/40">
              {format(new Date(date + 'T12:00'), "EEEE d 'de' MMMM yyyy", { locale: es })}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()}
            className="p-2.5 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-colors dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]" title="Actualizar">
            <RefreshCw size={15} />
          </button>
          <button onClick={() => exportCSV(filtered, date)}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 disabled:opacity-40 transition-colors dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            <Download size={15} /> Exportar CSV
          </button>
          <button onClick={() => setModal(true)}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors">
            <Plus size={15} /> Marcaje manual
          </button>
        </div>
      </div>

      {/* Feed en vivo */}
      {liveTop.length > 0 && (
        <div className="bg-blue-50 border border-blue-100 rounded-2xl px-5 py-3 flex gap-4 items-center overflow-x-auto">
          <span className="text-blue-600 font-semibold text-xs whitespace-nowrap flex items-center gap-1.5">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse inline-block" />
            En vivo:
          </span>
          {liveTop.map((log, i) => (
            <div key={i} className="flex items-center gap-2 text-sm whitespace-nowrap">
              <span>{SOURCE_ICON[log.source] || '🖐️'}</span>
              <span className="text-slate-700 font-medium dark:text-white/80">{log.employeeName}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                log.type === 'in' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
              }`}>
                {log.type === 'in' ? 'Entrada' : 'Salida'}
              </span>
              <span className="text-slate-400 text-xs dark:text-white/30">{fmtTime(log.timestamp)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-green-50 border border-green-100 rounded-2xl px-4 py-3 cursor-pointer hover:shadow-sm transition-all"
          onClick={() => setStatusFilter(statusFilter === 'present' ? '' : 'present')}>
          <p className="text-xs font-medium text-green-600 uppercase tracking-wide">Presentes</p>
          <p className="text-2xl font-bold text-green-700">{present}</p>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3 cursor-pointer hover:shadow-sm transition-all"
          onClick={() => setStatusFilter(statusFilter === 'late' ? '' : 'late')}>
          <p className="text-xs font-medium text-amber-600 uppercase tracking-wide">Retardos</p>
          <p className="text-2xl font-bold text-amber-700">{late}</p>
        </div>
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 cursor-pointer hover:shadow-sm transition-all"
          onClick={() => setStatusFilter(statusFilter === 'absent' ? '' : 'absent')}>
          <p className="text-xs font-medium text-red-600 uppercase tracking-wide">Ausentes</p>
          <p className="text-2xl font-bold text-red-700">{absent}</p>
        </div>
        <div className="bg-purple-50 border border-purple-100 rounded-2xl px-4 py-3 cursor-pointer hover:shadow-sm transition-all"
          onClick={() => setStatusFilter(statusFilter === 'permission' ? '' : 'permission')}>
          <p className="text-xs font-medium text-purple-600 uppercase tracking-wide">Permisos</p>
          <p className="text-2xl font-bold text-purple-700">{perm}</p>
        </div>
        <div className="bg-white border border-slate-100 rounded-2xl px-4 py-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide dark:text-white/40">Horas totales</p>
          <p className="text-2xl font-bold text-slate-700 dark:text-white/80">{minsToHM(totalWorked)}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 items-center bg-white border border-slate-100 shadow-sm rounded-2xl px-5 py-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {/* Navegación de fecha */}
        <div className="flex items-center gap-1">
          <button onClick={() => changeDate(-1)}
            className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors dark:hover:bg-white/[0.06]">
            <ChevronLeft size={16} className="text-slate-500 dark:text-white/40" />
          </button>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} max={today}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          <button onClick={() => changeDate(1)} disabled={date >= today}
            className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-30 dark:hover:bg-white/[0.06]">
            <ChevronRight size={16} className="text-slate-500 dark:text-white/40" />
          </button>
          {date !== today && (
            <button onClick={() => setDate(today)}
              className="text-xs text-blue-600 font-medium px-3 py-1.5 rounded-xl hover:bg-blue-50 transition-colors">
              Hoy
            </button>
          )}
        </div>

        <select value={dept} onChange={e => setDept(e.target.value)}
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
          <option value="">Todos los departamentos</option>
          {(deptsData?.data || []).map((d: any) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Nombre o código..."
            className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
        </div>

        {statusFilter && (
          <button onClick={() => setStatusFilter('')}
            className="text-xs text-slate-500 px-3 py-1.5 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors dark:bg-white/[0.06] dark:text-white/40">
            ✕ Limpiar filtro
          </button>
        )}

        <p className="ml-auto text-xs text-slate-400 dark:text-white/30">{filtered.length} empleados</p>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-x-auto dark:bg-white/[0.04] dark:border-white/[0.06]">
        {isLoading ? (
          <div className="text-center py-16 text-slate-400 dark:text-white/30">
            <RefreshCw size={28} className="mx-auto mb-3 animate-spin opacity-40" />
            Cargando marcaciones...
          </div>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Empleado</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Depto.</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Estado</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Entrada</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Salida</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Trabajado</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Retardo</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">H. Extra</th>
                <th className="text-center px-4 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide dark:text-white/40">Horario</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {filtered.map((row, i) => {
                const cfg = STATUS_CFG[row.status] || STATUS_FALLBACK
                return (
                  <tr key={i} className="hover:bg-slate-50 transition-colors dark:hover:bg-white/[0.04]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-blue-600 font-bold text-xs shrink-0">
                          {(row.employee_name || row.code || '?').split(' ').slice(0,2).map(n => n[0] || '').join('') || '?'}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900 text-sm dark:text-white">{row.employee_name}</p>
                          <p className="text-xs text-slate-400 font-mono dark:text-white/30">{row.code}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs dark:text-white/40">{row.department || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.cls}`}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-sm text-slate-700 font-semibold dark:text-white/80">
                      {fmtTime(row.first_in)}
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-sm text-slate-700 font-semibold dark:text-white/80">
                      {fmtTime(row.last_out)}
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-sm font-semibold text-blue-700">
                      {minsToHM(row.worked_minutes)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {row.late_minutes > 0 ? (
                        <span className="text-amber-600 font-semibold text-xs bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                          {row.late_minutes} min
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {row.overtime_minutes > 0 ? (
                        <span className="text-green-600 font-semibold text-xs bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
                          {minsToHM(row.overtime_minutes)}
                        </span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center text-slate-400 font-mono text-xs dark:text-white/30">
                      {row.scheduled_in?.slice(0,5) && row.scheduled_out?.slice(0,5)
                        ? `${row.scheduled_in.slice(0,5)} – ${row.scheduled_out.slice(0,5)}`
                        : '—'}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-14 text-slate-400 dark:text-white/30">
                    <Clock size={36} className="mx-auto mb-3 opacity-30" />
                    <p className="font-medium">Sin registros para este día</p>
                    {dept && <p className="text-xs mt-1">Pruebe cambiando el departamento o la fecha</p>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <ManualCheckinModal onClose={() => setModal(false)} onSaved={() => refetch()} />
      )}
    </div>
  )
}
