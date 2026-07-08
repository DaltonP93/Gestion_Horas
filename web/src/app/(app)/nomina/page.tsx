'use client'
import { useEffect, useState } from 'react'
import { Download, FileSpreadsheet, FileText, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

export default function NominaPage() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [branchId, setBranchId] = useState<string>('')
  const [branches, setBranches] = useState<any[]>([])
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/api/branches').then(r => setBranches(r.data || [])).catch(() => {})
  }, [])

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/api/payroll/preview', {
        params: { year, month, ...(branchId ? { branch_id: branchId } : {}) },
      })
      setRows(res.data.rows || [])
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al cargar nómina')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [year, month, branchId])

  async function download(format: 'xlsx' | 'csv') {
    try {
      const res = await api.get('/api/payroll/export', {
        params: { year, month, format, ...(branchId ? { branch_id: branchId } : {}) },
        responseType: 'blob',
      })
      const blob = new Blob([res.data])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `nomina_saa_${year}-${String(month).padStart(2, '0')}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al descargar')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Exportar nómina — formato SAA</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Resumen mensual para el sistema contable.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={e => setYear(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={month} onChange={e => setMonth(+e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            {Array.from({ length: 12 }).map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2000, i).toLocaleString('es', { month: 'long' })}
              </option>
            ))}
          </select>
          <select value={branchId} onChange={e => setBranchId(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
            <option value="">Todas las sedes</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button onClick={load} className="bg-slate-100 hover:bg-slate-200 rounded-xl px-3 py-2 text-sm flex items-center gap-1 dark:bg-white/[0.06]">
            <RefreshCw size={14} /> Actualizar
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => download('xlsx')}
          className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl px-4 py-2 text-sm flex items-center gap-2">
          <FileSpreadsheet size={16} /> Excel (.xlsx)
        </button>
        <button onClick={() => download('csv')}
          className="bg-slate-700 hover:bg-slate-800 text-white rounded-xl px-4 py-2 text-sm flex items-center gap-2">
          <FileText size={16} /> CSV
        </button>
      </div>

      {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

      <div className="bg-white rounded-2xl shadow border border-slate-100 overflow-x-auto dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase dark:bg-white/[0.03] dark:text-white/60">
            <tr>
              <th className="px-3 py-2 text-left">Código</th>
              <th className="px-3 py-2 text-left">Nombre</th>
              <th className="px-3 py-2 text-left">Sede</th>
              <th className="px-3 py-2 text-right">Días</th>
              <th className="px-3 py-2 text-right">Hs trab.</th>
              <th className="px-3 py-2 text-right">Hs extra</th>
              <th className="px-3 py-2 text-right">Atrasos (min)</th>
              <th className="px-3 py-2 text-right">Ausencias</th>
              <th className="px-3 py-2 text-right">Permisos</th>
              <th className="px-3 py-2 text-right">Vacac.</th>
              <th className="px-3 py-2 text-right">Enferm.</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={11} className="text-center py-8 text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={11} className="text-center py-8 text-slate-400 dark:text-white/30">Sin datos</td></tr>}
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 hover:bg-slate-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
                <td className="px-3 py-2 font-mono">{r.codigo}</td>
                <td className="px-3 py-2">{r.nombre}</td>
                <td className="px-3 py-2 text-slate-500 dark:text-white/40">{r.sede}</td>
                <td className="px-3 py-2 text-right">{r.dias_trab || 0}</td>
                <td className="px-3 py-2 text-right">{Number(r.hs_trab || 0).toFixed(2)}</td>
                <td className="px-3 py-2 text-right">{Number(r.hs_extra || 0).toFixed(2)}</td>
                <td className="px-3 py-2 text-right">{r.atrasos_min || 0}</td>
                <td className="px-3 py-2 text-right">{r.ausencias || 0}</td>
                <td className="px-3 py-2 text-right">{r.permisos || 0}</td>
                <td className="px-3 py-2 text-right">{r.vacaciones || 0}</td>
                <td className="px-3 py-2 text-right">{r.enfermedad || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
