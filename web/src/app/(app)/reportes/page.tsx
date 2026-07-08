'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { BarChart2, RefreshCw, Plus, Trash2, Mail, Clock, Download, CheckCircle, XCircle, Calendar } from 'lucide-react'
import { api, downloadUrl } from '@/lib/api'
import { useI18n } from '@/i18n/I18nProvider'

// ─── Helpers ─────────────────────────────────────────────────────
function minsToHM(mins: number | null) {
  if (!mins || mins <= 0) return '0:00'
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

function exportMarcadasCSV(employees: any[], from: string, to: string) {
  const rows: string[] = [`Reporte de marcadas ${from} al ${to}`, '']
  for (const emp of employees) {
    rows.push(`${emp.employee_name} [${emp.code}] — ${emp.department || 'Sin depto'}`)
    rows.push(`Fecha,Entrada(s),Salida(s),Total`)
    for (const row of emp.rows) {
      const entradas = row.pairs.map((p: any) => p.entrada || '').join(' / ')
      const salidas  = row.pairs.map((p: any) => p.salida  || '').join(' / ')
      rows.push(`${row.date},"${entradas}","${salidas}",${row.total}`)
    }
    rows.push(`Total período,,, ${emp.total_hm}`)
    rows.push('')
  }
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `marcadas_${from}_${to}.csv`; a.click(); URL.revokeObjectURL(url)
}

// ─── Tab: Reporte Marcadas ────────────────────────────────────────
function TabMarcadas() {
  const today        = format(new Date(), 'yyyy-MM-dd')
  const firstOfMonth = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd')

  const [from, setFrom]       = useState(firstOfMonth)
  const [to, setTo]           = useState(today)
  const [empId, setEmpId]     = useState('')
  const [deptId, setDeptId]   = useState('')
  const [emailTo, setEmailTo] = useState('')
  const [sending, setSending] = useState(false)
  const [queried, setQueried] = useState(false)

  const { data: empsData } = useQuery({
    queryKey: ['employees-select'],
    queryFn: () => api.get('/api/employees', { params: { limit: 500, status: 'active' } }).then(r => r.data),
    staleTime: 60_000,
  })

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['marcadas', from, to, empId, deptId],
    queryFn: () => api.get('/api/reports/marcadas', {
      params: { from, to, employeeId: empId || undefined, departmentId: deptId || undefined }
    }).then(r => r.data),
    enabled: queried,
  })

  function handleGenerar() { setQueried(true); refetch() }

  async function sendByEmail() {
    if (!emailTo.trim()) return alert('Ingresa un email destino')
    setSending(true)
    try {
      await api.post('/api/reports/marcadas/email', {
        from, to,
        employeeId: empId || undefined,
        recipients: emailTo.split(',').map((e: string) => e.trim()),
      })
      alert('Reporte enviado por email ✅')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al enviar')
    } finally { setSending(false) }
  }

  const employees: any[] = data?.data || []
  const maxPairs = employees.length
    ? Math.max(...employees.flatMap((e: any) => e.rows).map((r: any) => r.pairs.length), 1)
    : 1

  return (
    <div className="space-y-5">
      {/* Filtros */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Desde</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Hasta</label>
            <input type="date" value={to} max={today} onChange={e => setTo(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Departamento</label>
            <select value={deptId} onChange={e => { setDeptId(e.target.value); setEmpId('') }}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
              <option value="">Todos los departamentos</option>
              {(deptsData || []).map((d: any) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[200px]">
            <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Empleado</label>
            <select value={empId} onChange={e => setEmpId(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
              <option value="">Todos</option>
              {(empsData?.data || []).map((e: any) => (
                <option key={e.id} value={e.id}>[{e.code}] {e.full_name}</option>
              ))}
            </select>
          </div>
          <button onClick={handleGenerar}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
            <RefreshCw size={14} /> Generar reporte
          </button>
          {employees.length > 0 && (
            <>
              <button onClick={() => exportMarcadasCSV(employees, from, to)}
                className="flex items-center gap-2 border border-slate-200 text-slate-600 px-4 py-2 rounded-xl text-sm font-medium hover:bg-slate-50 transition-colors dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                <Download size={14} /> Exportar CSV
              </button>
              <button
                onClick={() => {
                  window.open(downloadUrl('/api/reports/marcadas/pdf', {
                    from, to,
                    ...(empId  ? { employeeId: empId }  : {}),
                    ...(deptId ? { deptId }             : {}),
                  }), '_blank')
                }}
                className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
                <Download size={14} /> PDF para imprimir
              </button>
            </>
          )}
        </div>

        {employees.length > 0 && (
          <div className="flex gap-2 mt-4 pt-4 border-t border-slate-100 items-center dark:border-white/[0.06]">
            <Mail size={16} className="text-slate-400 shrink-0 dark:text-white/30" />
            <input value={emailTo} onChange={e => setEmailTo(e.target.value)}
              placeholder="email@destino.com  (varios separados por coma)"
              className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 dark:border-white/[0.08]" />
            <button onClick={sendByEmail} disabled={sending}
              className="bg-green-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-60 whitespace-nowrap transition-colors">
              {sending ? 'Enviando...' : 'Enviar por email'}
            </button>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="text-center py-12 text-slate-400 dark:text-white/30">
          <RefreshCw size={24} className="mx-auto mb-3 animate-spin opacity-40" />
          Generando reporte...
        </div>
      )}
      {!isLoading && queried && employees.length === 0 && (
        <div className="text-center py-12 text-slate-400 dark:text-white/30">Sin marcaciones en este período</div>
      )}

      {employees.map((emp: any) => (
        <div key={emp.employee_id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="bg-slate-50 border-b border-slate-100 px-5 py-4 flex items-center justify-between dark:bg-white/[0.03] dark:border-white/[0.06]">
            <div>
              <p className="font-bold text-slate-900 dark:text-white">{emp.employee_name}</p>
              <p className="text-xs text-slate-500 dark:text-white/40">Cód. {emp.code} · {emp.department || 'Sin depto'}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400 mb-0.5 dark:text-white/30">Total período</p>
              <p className="text-2xl font-bold text-blue-700">{emp.total_hm}</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="border-b border-slate-100 dark:border-white/[0.06]">
                <tr>
                  <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs w-40 dark:text-white/40">Fecha</th>
                  {Array.from({ length: maxPairs }).flatMap((_, i) => [
                    <th key={`e${i}`} className="text-center px-3 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Entrada</th>,
                    <th key={`s${i}`} className="text-center px-3 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Salida</th>,
                  ])}
                  <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                {emp.rows.map((row: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                    <td className="px-4 py-2 text-xs">
                      <span className="font-semibold text-slate-700 dark:text-white/80">{row.dayName}</span>{' '}
                      <span className="font-mono text-slate-500 dark:text-white/40">{row.date}</span>
                    </td>
                    {Array.from({ length: maxPairs }).flatMap((_, pi) => {
                      const p = row.pairs[pi] || { entrada: '', salida: '' }
                      return [
                        <td key={`e${pi}`} className="px-3 py-2 text-center font-mono text-xs text-slate-700 dark:text-white/80">{p.entrada}</td>,
                        <td key={`s${pi}`} className="px-3 py-2 text-center font-mono text-xs text-slate-700 dark:text-white/80">{p.salida}</td>,
                      ]
                    })}
                    <td className={`px-4 py-2 text-right font-bold font-mono text-sm ${
                      row.total === '0:00' ? 'text-red-400' : 'text-blue-700'
                    }`}>{row.total}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-blue-50 border-t border-blue-100">
                  <td colSpan={1 + maxPairs * 2} className="px-4 py-3 text-sm font-semibold text-slate-600 dark:text-white/60">Total período</td>
                  <td className="px-4 py-3 text-right font-bold text-blue-700 text-lg">{emp.total_hm}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Tab: Resumen mensual (vista PDFs por mes) ─────────────────────
function TabMensual() {
  const now = new Date()
  const [year, setYear]     = useState(now.getFullYear())
  const [deptId, setDeptId] = useState('')

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  const currentYear  = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  function openMonthly(month: number, format: 'pdf' | 'xlsx') {
    window.open(downloadUrl('/api/reports/monthly/export', {
      year, month, format,
      ...(deptId ? { dept: deptId } : {}),
    }), '_blank')
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex flex-wrap gap-3 items-end dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div>
          <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Año</label>
          <select value={year} onChange={e => setYear(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Departamento</label>
          <select value={deptId} onChange={e => setDeptId(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            <option value="">Todos</option>
            {(deptsData || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <p className="text-xs text-slate-400 ml-auto flex items-center gap-1 dark:text-white/30">
          <Calendar size={13} /> Click en un mes para generar la planilla en PDF o Excel.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {MESES.map((name, idx) => {
          const month = idx + 1
          const isFuture = year > currentYear || (year === currentYear && month > currentMonth)
          const isCurrent = year === currentYear && month === currentMonth
          return (
            <div key={month}
              className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${
                isFuture ? 'border-slate-100 opacity-50' :
                isCurrent ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-100 hover:shadow-md'
              }`}>
              <div className={`px-5 py-4 flex items-center justify-between ${
                isCurrent ? 'bg-gradient-to-br from-blue-50 to-blue-100' : 'bg-slate-50'
              }`}>
                <div>
                  <p className={`text-xs uppercase tracking-wide font-medium ${isCurrent ? 'text-blue-600' : 'text-slate-400'}`}>
                    {String(month).padStart(2,'0')} / {year}
                  </p>
                  <p className="text-lg font-bold text-slate-800 dark:text-white/90">{name}</p>
                </div>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  isCurrent ? 'bg-blue-500 text-white' : 'bg-white text-slate-400 border border-slate-200'
                }`}>
                  <Calendar size={18} />
                </div>
              </div>
              <div className="p-3 flex gap-2">
                <button
                  disabled={isFuture}
                  onClick={() => openMonthly(month, 'pdf')}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-2 rounded-xl text-xs font-medium transition-colors">
                  <Download size={12} /> PDF
                </button>
                <button
                  disabled={isFuture}
                  onClick={() => openMonthly(month, 'xlsx')}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-2 rounded-xl text-xs font-medium transition-colors">
                  <Download size={12} /> Excel
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Convertir UI amigable → cron expression ──────────────────────
function buildCron(freq: string, dayOfWeek: string, dayOfMonth: string, hour: string, minute: string) {
  const h = parseInt(hour) || 8
  const m = parseInt(minute) || 0
  if (freq === 'daily')   return `${m} ${h} * * 1-5`
  if (freq === 'weekly')  return `${m} ${h} * * ${dayOfWeek}`
  if (freq === 'monthly') return `${m} ${h} ${dayOfMonth} * *`
  return `${m} ${h} 1 * *`
}

function describeCron(freq: string, dayOfWeek: string, dayOfMonth: string, hour: string, minute: string) {
  const h = hour.padStart(2,'0'), m = minute.padStart(2,'0')
  const DAYS = ['','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']
  if (freq === 'daily')   return `Lunes a Viernes a las ${h}:${m}`
  if (freq === 'weekly')  return `Cada ${DAYS[+dayOfWeek] || 'Lunes'} a las ${h}:${m}`
  if (freq === 'monthly') return `El día ${dayOfMonth} de cada mes a las ${h}:${m}`
  return ''
}

// ─── Tab: Reportes programados ───────────────────────────────────
function TabScheduled() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  // Estado amigable en vez de cron crudo
  const [form, setForm] = useState({
    name: '',
    recipients: '',
    period_type: 'monthly' as 'daily' | 'weekly' | 'monthly',
    freq: 'monthly' as 'daily' | 'weekly' | 'monthly',
    dayOfWeek: '1',
    dayOfMonth: '1',
    hour: '8',
    minute: '0',
    report_type: 'marcadas',
  })

  const { data, isLoading } = useQuery<any[]>({
    queryKey: ['report-schedules'],
    queryFn: () => api.get('/api/notifications/schedules').then(r => r.data),
  })

  function setF(key: string, val: string) { setForm(p => ({ ...p, [key]: val })) }

  const cronExpr = buildCron(form.freq, form.dayOfWeek, form.dayOfMonth, form.hour, form.minute)
  const cronDesc = describeCron(form.freq, form.dayOfWeek, form.dayOfMonth, form.hour, form.minute)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.post('/api/notifications/schedules', {
        name: form.name,
        recipients: form.recipients,
        period_type: form.period_type,
        report_type: form.report_type,
        cron_expression: cronExpr,
      })
      qc.invalidateQueries({ queryKey: ['report-schedules'] })
      setShowForm(false)
      setForm({ name:'', recipients:'', period_type:'monthly', freq:'monthly', dayOfWeek:'1', dayOfMonth:'1', hour:'8', minute:'0', report_type:'marcadas' })
    } catch (err: any) { alert(err?.response?.data?.error || 'Error') }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500 dark:text-white/40">Los reportes se generan y envían por email automáticamente según el horario configurado.</p>
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
          <Plus size={15} /> Nuevo reporte programado
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-blue-100 shadow-sm overflow-hidden dark:bg-white/[0.04]">
          <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-4">
            <h3 className="text-white font-bold">Nuevo reporte automático</h3>
            <p className="text-blue-200 text-xs mt-0.5">Configure cuándo y cómo enviar el reporte</p>
          </div>

          <form onSubmit={create} className="p-6 space-y-5">
            {/* Nombre y tipo */}
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Nombre del reporte <span className="text-red-500">*</span></label>
                <input required value={form.name} onChange={e => setF('name', e.target.value)}
                  placeholder="Ej: Reporte mensual Recursos Humanos"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Tipo de reporte</label>
                <select value={form.report_type} onChange={e => setF('report_type', e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
                  <option value="marcadas">Marcadas por empleado</option>
                  <option value="monthly">Resumen mensual</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Período del reporte</label>
                <select value={form.period_type} onChange={e => setF('period_type', e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
                  <option value="daily">Día anterior</option>
                  <option value="weekly">Semana anterior</option>
                  <option value="monthly">Mes anterior</option>
                </select>
              </div>
            </div>

            {/* Frecuencia — UI amigable en vez de cron */}
            <div className="border border-slate-100 rounded-2xl p-4 bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <h4 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2 dark:text-white/80">
                <Clock size={15} className="text-blue-500" /> Horario de envío
              </h4>

              {/* Frecuencia */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { val: 'daily',   label: '📅 Diario', sub: 'Lun – Vie' },
                  { val: 'weekly',  label: '📆 Semanal', sub: 'Un día por semana' },
                  { val: 'monthly', label: '🗓️ Mensual', sub: 'Un día por mes' },
                ].map(opt => (
                  <button key={opt.val} type="button"
                    onClick={() => setF('freq', opt.val)}
                    className={`p-3 rounded-xl border-2 text-center transition-all ${
                      form.freq === opt.val
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <p className={`text-sm font-semibold ${form.freq === opt.val ? 'text-blue-700' : 'text-slate-700'}`}>
                      {opt.label}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5 dark:text-white/30">{opt.sub}</p>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-3">
                {/* Día de la semana (si weekly) */}
                {form.freq === 'weekly' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-white/60">Día de la semana</label>
                    <select value={form.dayOfWeek} onChange={e => setF('dayOfWeek', e.target.value)}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-white/[0.04] dark:border-white/[0.08]">
                      {['1','2','3','4','5','6','0'].map((d, i) => (
                        <option key={d} value={d}>{['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'][i]}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Día del mes (si monthly) */}
                {form.freq === 'monthly' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-white/60">Día del mes</label>
                    <select value={form.dayOfMonth} onChange={e => setF('dayOfMonth', e.target.value)}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-white/[0.04] dark:border-white/[0.08]">
                      {Array.from({length: 28}, (_, i) => i + 1).map(d => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Hora */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-white/60">Hora de envío</label>
                  <select value={form.hour} onChange={e => setF('hour', e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-white/[0.04] dark:border-white/[0.08]">
                    {Array.from({length: 24}, (_, i) => i).map(h => (
                      <option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>
                    ))}
                  </select>
                </div>

                {/* Minutos */}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-white/60">Minutos</label>
                  <select value={form.minute} onChange={e => setF('minute', e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-white/[0.04] dark:border-white/[0.08]">
                    {['0','15','30','45'].map(m => (
                      <option key={m} value={m}>:{m.padStart(2,'0')}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Vista previa del horario */}
              <div className="mt-3 bg-blue-50 rounded-xl px-4 py-2.5 flex items-center gap-2">
                <CheckCircle size={14} className="text-blue-500 shrink-0" />
                <span className="text-sm text-blue-700 font-medium">{cronDesc}</span>
                <span className="ml-auto font-mono text-xs text-blue-400 bg-blue-100 px-2 py-0.5 rounded">{cronExpr}</span>
              </div>
            </div>

            {/* Destinatarios */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">
                Destinatarios <span className="text-red-500">*</span>
                <span className="text-slate-400 font-normal ml-1 dark:text-white/30">(separados por coma)</span>
              </label>
              <input required value={form.recipients} onChange={e => setF('recipients', e.target.value)}
                placeholder="rh@empresa.com, gerencia@empresa.com"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>

            <div className="flex gap-3">
              <button type="button" onClick={() => setShowForm(false)}
                className="flex-1 border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                Cancelar
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors">
                {saving ? 'Guardando...' : 'Crear reporte programado'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-3">
        {isLoading && <div className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</div>}
        {(data || []).map((s: any) => (
          <div key={s.id} className={`bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex items-center gap-4 transition-opacity ${!s.active ? 'opacity-60' : ''}`}>
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${s.active ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>
              <Clock size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-900 dark:text-white">{s.name}</p>
              <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-slate-500 dark:text-white/40">
                <span className="font-mono bg-slate-100 px-2.5 py-1 rounded-lg dark:bg-white/[0.06]">{s.cron_expression}</span>
                <span className="bg-blue-50 text-blue-700 px-2.5 py-1 rounded-lg font-medium">{s.period_type}</span>
                <span className="flex items-center gap-1"><Mail size={11} /> {s.recipients}</span>
                {s.last_run && <span>Último envío: {new Date(s.last_run).toLocaleDateString('es')}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={async () => {
                  await api.put(`/api/notifications/schedules/${s.id}`, { active: s.active ? 0 : 1 })
                  qc.invalidateQueries({ queryKey: ['report-schedules'] })
                }}
                className={`text-xs px-3 py-1.5 rounded-xl font-medium border transition-colors ${
                  s.active
                    ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                    : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                }`}>
                {s.active ? '● Activo' : '○ Inactivo'}
              </button>
              <button
                onClick={async () => {
                  if (confirm('¿Eliminar este reporte programado?')) {
                    await api.delete(`/api/notifications/schedules/${s.id}`)
                    qc.invalidateQueries({ queryKey: ['report-schedules'] })
                  }
                }}
                className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
        {!isLoading && !(data?.length) && (
          <div className="text-center py-12 text-slate-400 dark:text-white/30">
            <Calendar size={36} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Sin reportes programados</p>
            <p className="text-xs mt-1">Cree uno con el botón de arriba</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab: SMTP ───────────────────────────────────────────────────
function TabSMTP() {
  const [form, setForm] = useState({ host: '', port: '587', secure: false, user: '', password: '', from: '' })
  const [testEmail, setTestEmail] = useState('')
  const [saving, setSaving]   = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<null | { sent: boolean; reason?: string }>(null)

  useQuery({
    queryKey: ['smtp-config'],
    queryFn: () => api.get('/api/notifications/smtp').then(r => r.data),
    staleTime: Infinity,
    onSuccess: (d: any) => {
      if (d.configured) setForm(p => ({
        ...p, host: d.host || '', port: String(d.port || 587),
        secure: !!d.secure, user: d.user || '', from: d.from || ''
      }))
    },
  } as any)

  // Al cambiar puerto, auto-sugerir el modo SSL
  function handlePortChange(port: string) {
    setForm(p => ({ ...p, port, secure: port === '465' }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true)
    try { await api.put('/api/notifications/smtp', form); alert('Configuración SMTP guardada ✅') }
    catch (err: any) { alert(err?.response?.data?.error || 'Error') }
    finally { setSaving(false) }
  }

  async function testSMTP() {
    if (!testEmail) return; setTesting(true); setTestResult(null)
    try { const r = await api.post('/api/notifications/smtp/test', { to: testEmail }); setTestResult(r.data) }
    catch (err: any) { setTestResult({ sent: false, reason: err?.response?.data?.reason || 'Error de conexión' }) }
    finally { setTesting(false) }
  }

  // Presets de proveedores comunes
  const PRESETS = [
    { label: 'Gmail',       host: 'smtp.gmail.com',        port: '587', secure: false },
    { label: 'Outlook',     host: 'smtp.office365.com',    port: '587', secure: false },
    { label: 'Yahoo',       host: 'smtp.mail.yahoo.com',   port: '587', secure: false },
    { label: 'Webmail cPanel', host: '', port: '587',      secure: false },
  ]

  return (
    <div className="max-w-2xl space-y-5">
      {/* Info boxes */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-blue-700">
          <p className="font-semibold mb-1">Puerto 587 — STARTTLS (recomendado)</p>
          <p>Para webmail corporativo, Gmail, Outlook. Conexión cifrada con negociación TLS. <strong>No</strong> marque SSL/TLS.</p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-600 dark:bg-white/[0.03] dark:text-white/60 dark:border-white/[0.08]">
          <p className="font-semibold mb-1">Puerto 465 — SSL/TLS directo</p>
          <p>Conexión cifrada desde el inicio. Marque "Usar SSL/TLS". Para Gmail use una <strong>App Password</strong>, no la contraseña normal.</p>
        </div>
      </div>

      {/* Presets rápidos */}
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(p => (
          <button key={p.label} type="button"
            onClick={() => setForm(f => ({ ...f, host: p.host || f.host, port: p.port, secure: p.secure }))}
            className="text-xs px-3 py-1.5 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 text-slate-600 transition-colors dark:bg-white/[0.04] dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            {p.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Servidor SMTP</label>
              <input value={form.host} onChange={e => setForm(p => ({ ...p, host: e.target.value }))}
                placeholder="smtp.gmail.com  /  webmail.miempresa.com"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Puerto</label>
              <select value={form.port} onChange={e => handlePortChange(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
                <option value="587">587 — STARTTLS</option>
                <option value="465">465 — SSL/TLS</option>
                <option value="25">25 — Sin cifrado</option>
                <option value="2525">2525 — Alternativo</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Usuario / Email</label>
              <input value={form.user} onChange={e => setForm(p => ({ ...p, user: e.target.value }))}
                placeholder="usuario@miempresa.com"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Contraseña / App Password</label>
              <input type="password" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Remitente (From)</label>
            <input value={form.from} onChange={e => setForm(p => ({ ...p, from: e.target.value }))}
              placeholder="Sistema RH <rh@empresa.com>"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.secure}
              onChange={e => { setForm(p => ({ ...p, secure: e.target.checked, port: e.target.checked ? '465' : '587' })) }}
              className="accent-blue-600 w-4 h-4" />
            <span className="text-sm text-slate-700 dark:text-white/80">
              Usar SSL/TLS directo (puerto 465)
              <span className="text-slate-400 text-xs ml-1 dark:text-white/30">— solo si el servidor lo requiere explícitamente</span>
            </span>
          </label>
          <button type="submit" disabled={saving}
            className="w-full bg-blue-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {saving ? 'Guardando...' : 'Guardar configuración SMTP'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h3 className="font-semibold text-slate-700 mb-3 text-sm dark:text-white/80">Probar configuración</h3>
        <div className="flex gap-2">
          <input value={testEmail} onChange={e => setTestEmail(e.target.value)} type="email"
            placeholder="test@email.com"
            className="flex-1 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          <button onClick={testSMTP} disabled={testing || !testEmail}
            className="bg-slate-800 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-700 disabled:opacity-60 transition-colors">
            {testing ? 'Enviando...' : 'Probar'}
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm font-medium ${testResult.sent ? 'text-green-600' : 'text-red-600'}`}>
            {testResult.sent ? <CheckCircle size={16} /> : <XCircle size={16} />}
            {testResult.sent ? 'Email enviado correctamente' : `Error: ${testResult.reason}`}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────
export default function ReportesPage() {
  const { t } = useI18n()
  const [tab, setTab] = useState<'marcadas' | 'mensual' | 'programados' | 'smtp'>('marcadas')

  const TABS = [
    { id: 'marcadas'    as const, label: '📋 ' + t('reports.marcadas') },
    { id: 'mensual'     as const, label: '📊 ' + t('reports.monthly')  },
    { id: 'programados' as const, label: '🕐 ' + t('reports.scheduled') },
    { id: 'smtp'        as const, label: '📧 ' + t('reports.smtp')     },
  ]

  const linkToCustom = (
    <a href="/reportes/personalizado"
      className="ml-auto flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-xl text-sm font-medium transition-colors">
      🔧 Constructor a medida
    </a>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
          <BarChart2 className="text-blue-600" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('nav.reports')}</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">{t('reports.marcadas')} · {t('reports.monthly')} · {t('reports.scheduled')}</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200 items-center dark:border-white/[0.08]">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-xl transition-colors ${
              tab === t.id
                ? 'bg-white border border-b-white border-slate-200 text-blue-600 -mb-px shadow-sm'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}>
            {t.label}
          </button>
        ))}
        {linkToCustom}
      </div>

      {tab === 'marcadas'    && <TabMarcadas />}
      {tab === 'mensual'     && <TabMensual />}
      {tab === 'programados' && <TabScheduled />}
      {tab === 'smtp'        && <TabSMTP />}
    </div>
  )
}
