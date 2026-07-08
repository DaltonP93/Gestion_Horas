'use client'
import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Wrench, RefreshCw, Download, FileSpreadsheet, Layers, Filter, Sliders } from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

const SOURCES_LABELS: Record<string, string> = {
  attendance:    'Marcadas (attendance_logs)',
  daily_summary: 'Resumen diario (daily_summary)',
  permissions:   'Permisos / vacaciones',
  employees:     'Empleados',
}

export default function ReportePersonalizadoPage() {
  const today = format(new Date(), 'yyyy-MM-dd')
  const firstOfMonth = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd')

  const [source, setSource]   = useState('daily_summary')
  const [fields, setFields]   = useState<Record<string, string[]>>({})
  const [groupBy, setGroupBy] = useState('')
  const [orderBy, setOrderBy] = useState('')
  const [filters, setFilters] = useState<any>({ date_from: firstOfMonth, date_to: today })
  const [previewData, setPreviewData] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  const { data: catalog } = useQuery<any>({
    queryKey: ['reports-builder-sources'],
    queryFn: () => api.get('/api/reports-builder/sources').then(r => r.data),
    staleTime: Infinity,
  })

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const sourceFields = catalog?.sources?.[source]?.fields || {}
  const selectedFields = fields[source] || Object.keys(sourceFields).slice(0, 6)

  const requestBody = useMemo(() => ({
    source,
    fields: selectedFields,
    filters,
    groupBy: groupBy || undefined,
    orderBy: orderBy || undefined,
  }), [source, selectedFields, filters, groupBy, orderBy])

  function toggleField(f: string) {
    setFields(prev => {
      const cur = prev[source] || Object.keys(sourceFields).slice(0, 6)
      const next = cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f]
      return { ...prev, [source]: next }
    })
  }

  async function runPreview() {
    setLoading(true)
    setPreviewData(null)
    try {
      const r = await api.post('/api/reports-builder/preview', requestBody)
      setPreviewData(r.data)
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al ejecutar reporte')
    } finally {
      setLoading(false)
    }
  }

  async function exportFile(fmt: 'xlsx' | 'csv') {
    try {
      const res = await api.post(`/api/reports-builder/export?format=${fmt}`, requestBody, {
        responseType: 'blob',
      })
      const blob = new Blob([res.data])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `reporte_${source}_${today}.${fmt}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert('Error al exportar: ' + (err?.message || ''))
    }
  }

  return (
    <div className="p-6 space-y-5">
      <BackButton href="/reportes" label="Reportes" />
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
          <Wrench className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Constructor de reportes</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Combina campos, filtros y agrupaciones para generar reportes a medida</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Panel de configuración */}
        <div className="lg:col-span-1 space-y-4">
          {/* Fuente */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <h3 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 text-sm dark:text-white/80">
              <Layers size={15} /> Fuente de datos
            </h3>
            <select value={source} onChange={e => { setSource(e.target.value); setGroupBy(''); setOrderBy('') }}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              {Object.entries(SOURCES_LABELS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </div>

          {/* Campos */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <h3 className="font-semibold text-slate-700 mb-3 flex items-center gap-2 text-sm dark:text-white/80">
              <Sliders size={15} /> Campos a mostrar
            </h3>
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {Object.entries(sourceFields).map(([key, label]: any) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 px-2 py-1 rounded dark:hover:bg-white/[0.04]">
                  <input type="checkbox" checked={selectedFields.includes(key)} onChange={() => toggleField(key)}
                    className="accent-blue-600 w-4 h-4" />
                  <span className="text-sm text-slate-700 flex-1 dark:text-white/80">{label}</span>
                  <span className="text-xs text-slate-400 font-mono dark:text-white/30">{key}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Filtros */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <h3 className="font-semibold text-slate-700 mb-1 flex items-center gap-2 text-sm dark:text-white/80">
              <Filter size={15} /> Filtros
            </h3>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Desde</label>
                <input type="date" value={filters.date_from || ''}
                  onChange={e => setFilters((f: any) => ({ ...f, date_from: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Hasta</label>
                <input type="date" value={filters.date_to || ''}
                  onChange={e => setFilters((f: any) => ({ ...f, date_to: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Departamento</label>
              <select value={filters.dept_id || ''}
                onChange={e => setFilters((f: any) => ({ ...f, dept_id: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]">
                <option value="">Todos</option>
                {(deptsData || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>

            {Object.keys(sourceFields).includes('status') && (
              <div>
                <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Estado</label>
                <input type="text" value={filters.status || ''} placeholder="present, late, absent..."
                  onChange={e => setFilters((f: any) => ({ ...f, status: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]" />
              </div>
            )}

            {Object.keys(sourceFields).includes('type') && (
              <div>
                <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Tipo</label>
                <input type="text" value={filters.type || ''} placeholder="in, out, vacation..."
                  onChange={e => setFilters((f: any) => ({ ...f, type: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]" />
              </div>
            )}
          </div>

          {/* Agrupación / orden */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-white/60">Agrupar por</label>
              <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]">
                <option value="">(sin agrupación)</option>
                {selectedFields.map(f => (
                  <option key={f} value={f}>{sourceFields[f]}</option>
                ))}
              </select>
              <p className="text-[11px] text-slate-400 mt-0.5 dark:text-white/30">
                Si se agrupa: campos numéricos se suman, otros toman el último valor.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1 dark:text-white/60">Ordenar por</label>
              <select value={orderBy} onChange={e => setOrderBy(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs dark:border-white/[0.08]">
                <option value="">(default)</option>
                {selectedFields.map(f => (
                  <option key={f} value={f}>{sourceFields[f]}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Resultado */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center gap-2">
            <button onClick={runPreview} disabled={loading || !selectedFields.length}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
              {loading ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {loading ? 'Generando...' : 'Generar reporte'}
            </button>
            {previewData && (
              <>
                <button onClick={() => exportFile('xlsx')}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
                  <FileSpreadsheet size={14} /> Excel
                </button>
                <button onClick={() => exportFile('csv')}
                  className="flex items-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                  <Download size={14} /> CSV
                </button>
                <span className="ml-auto text-xs text-slate-500 dark:text-white/40">
                  {previewData.count} fila{previewData.count !== 1 ? 's' : ''}
                </span>
              </>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
            {!previewData && !loading && (
              <div className="text-center py-16 text-slate-400 dark:text-white/30">
                <Wrench size={36} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">Configurá los campos y filtros, luego "Generar reporte"</p>
              </div>
            )}
            {loading && (
              <div className="text-center py-16 text-slate-400 dark:text-white/30">
                <RefreshCw size={24} className="mx-auto mb-3 animate-spin opacity-40" />
                Ejecutando consulta...
              </div>
            )}
            {previewData && previewData.count === 0 && (
              <div className="text-center py-16 text-slate-400 dark:text-white/30">Sin resultados con esos filtros</div>
            )}
            {previewData && previewData.count > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs whitespace-nowrap">
                  <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
                    <tr>
                      {previewData.headers.map((h: string) => (
                        <th key={h} className="text-left px-3 py-2.5 text-slate-500 font-medium dark:text-white/40">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                    {previewData.rows.slice(0, 200).map((row: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                        {previewData.fields.map((f: string) => (
                          <td key={f} className="px-3 py-2 text-slate-700 dark:text-white/80">
                            {row[f] != null && typeof row[f] === 'object' ? JSON.stringify(row[f]) : String(row[f] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {previewData.count > 200 && (
                  <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
                    Vista previa limitada a 200 filas. Exportá para ver todas las {previewData.count}.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
