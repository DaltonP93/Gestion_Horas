'use client'
import { useEffect, useState } from 'react'
import { FileText, Save, Download, Building2, FileSpreadsheet, ArrowLeft, Upload, AlertTriangle, CheckCircle2, ClipboardCheck } from 'lucide-react'
import Link from 'next/link'
import { api, apiUrl } from '@/lib/api'

// Campos de datos del empleador (para el encabezado de las planillas).
const EMPLOYER_FIELDS: { key: string; label: string; ph?: string }[] = [
  { key: 'employer_razon_social', label: 'Razón social', ph: 'Nombre legal de la empresa' },
  { key: 'employer_ruc',          label: 'RUC' },
  { key: 'employer_ips_patronal', label: 'N° Patronal IPS' },
  { key: 'employer_mtess_registro', label: 'N° Registro MTESS' },
  { key: 'employer_actividad',    label: 'Actividad económica' },
  { key: 'employer_domicilio',    label: 'Domicilio' },
  { key: 'employer_ciudad',       label: 'Ciudad' },
  { key: 'employer_telefono',     label: 'Teléfono' },
  { key: 'employer_representante', label: 'Representante legal' },
  { key: 'ips_rate_obrero',       label: 'Tasa IPS obrero (%)', ph: '9' },
  { key: 'ips_rate_patronal',     label: 'Tasa IPS patronal (%)', ph: '16.5' },
  { key: 'mtess_dias_base_mensual', label: 'MTESS · base días (mensual)', ph: '30' },
  { key: 'mtess_dias_descuento_tipos', label: 'MTESS · tipos que descuentan', ph: 'vacaciones, reposo, injustificada, sin_goce, licencia_especial' },
]

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const gs = (n: number) => new Intl.NumberFormat('es-PY').format(Math.round(n || 0))

interface Dept { id: number; name: string }
interface IpsRow { code: string; name: string; ci: string; ips: string; position: string; dias_trabajados: number; horas_trabajadas: number; horas_extra: number }
interface AporteRow { codigo: string; nombre: string; cedula: string; ips: string; dias_trab: number; salario_base: number; aporte_obrero: number; aporte_patronal: number; total_aporte: number }
interface ComunRow {
  code: string; name: string; pay_type: string; nro_ci: string; forma_de_pago: number
  canti_dias_trabajados: number; base: number; descuentos: number; detalle: Record<string, number>
  horas_ordinarias: number; horas_extraordinarias: number; salario_basico: number; aporte_seg_social: number
}

export default function PlanillasLegalesPage() {
  const now = new Date()
  const [emp, setEmp] = useState<Record<string, string>>({})
  const [depts, setDepts] = useState<Dept[]>([])
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [dept, setDept] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [ips, setIps] = useState<IpsRow[] | null>(null)
  const [loadingIps, setLoadingIps] = useState(false)
  const [aportes, setAportes] = useState<{ data: AporteRow[]; totals: any; rates: any } | null>(null)
  const [loadingAp, setLoadingAp] = useState(false)
  const [comun, setComun] = useState<{ data: ComunRow[]; config: any } | null>(null)
  const [loadingComun, setLoadingComun] = useState(false)
  const [comp, setComp] = useState<{ total: number; complete: number; counts: any; incomplete: any[] } | null>(null)
  const [loadingComp, setLoadingComp] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    api.get('/api/settings').then(r => {
      const s = r.data || {}
      const e: Record<string, string> = {}
      for (const f of EMPLOYER_FIELDS) e[f.key] = s[f.key] || ''
      setEmp(e)
    }).catch(() => {})
    api.get('/api/employees/departments').then(r => setDepts(r.data || [])).catch(() => {})
  }, [])

  async function saveEmployer() {
    setSaving(true); setMsg('')
    try {
      await api.put('/api/settings', emp)
      setMsg('Datos del empleador guardados.')
    } catch (e: any) {
      setMsg(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  function tokenParam() {
    const t = (typeof window !== 'undefined' && (localStorage.getItem('access_token') || localStorage.getItem('token'))) || ''
    return `access_token=${encodeURIComponent(t)}`
  }
  const q = () => `year=${year}&month=${month}${dept ? `&dept=${dept}` : ''}&${tokenParam()}`

  function downloadMtess() { window.open(apiUrl(`/api/legal/planilla-mtess?${q()}`), '_blank') }
  function downloadIpsExcel() { window.open(apiUrl(`/api/legal/ips-jornales?format=xlsx&${q()}`), '_blank') }

  async function previewIps() {
    setLoadingIps(true); setIps(null)
    try {
      const r = await api.get(`/api/legal/ips-jornales`, { params: { year, month, dept: dept || undefined } })
      setIps(r.data?.data || [])
    } catch { setIps([]) } finally { setLoadingIps(false) }
  }

  // Completitud de datos maestros para planillas.
  async function loadCompleteness() {
    setLoadingComp(true)
    try {
      const r = await api.get('/api/legal-data/completeness', { params: { dept: dept || undefined } })
      setComp(r.data)
    } catch { setComp(null) } finally { setLoadingComp(false) }
  }
  function downloadLegalTemplate() { window.open(apiUrl(`/api/legal-data/template?${tokenParam()}`), '_blank') }
  async function handleLegalImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true); setImportMsg('')
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await api.post('/api/legal-data/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      const d = r.data
      setImportMsg(`Actualizados: ${d.updated}. No encontrados: ${d.notFound?.length || 0}${d.errors?.length ? `. Errores: ${d.errors.length}` : ''}.`)
      loadCompleteness()
    } catch (err: any) {
      setImportMsg(err?.response?.data?.error || 'Error al importar')
    } finally { setImporting(false); e.target.value = '' }
  }

  // Planilla de comunicación MTESS (formato de carga oficial).
  function downloadComunicacion() { window.open(apiUrl(`/api/legal/planilla-comunicacion?format=xlsx&${q()}`), '_blank') }
  async function previewComunicacion() {
    setLoadingComun(true); setComun(null)
    try {
      const r = await api.get(`/api/legal/planilla-comunicacion`, { params: { year, month, dept: dept || undefined } })
      setComun({ data: r.data?.data || [], config: r.data?.config || {} })
    } catch { setComun({ data: [], config: {} }) } finally { setLoadingComun(false) }
  }

  // Los aportes IPS se calculan para toda la empresa (planilla patronal completa).
  function downloadAportesExcel() { window.open(apiUrl(`/api/payroll/ips-aportes?format=xlsx&year=${year}&month=${month}&${tokenParam()}`), '_blank') }
  async function previewAportes() {
    setLoadingAp(true); setAportes(null)
    try {
      const r = await api.get(`/api/payroll/ips-aportes`, { params: { year, month } })
      setAportes({ data: r.data?.data || [], totals: r.data?.totals || {}, rates: r.data?.rates || {} })
    } catch { setAportes({ data: [], totals: {}, rates: {} }) } finally { setLoadingAp(false) }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <Link href="/reportes" className="text-slate-500 hover:text-slate-700 flex items-center gap-1 text-sm dark:text-white/40 w-fit">
        <ArrowLeft size={16} /> Volver a reportes
      </Link>

      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(34,211,238,0.5)]">
          <FileText size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Planillas legales</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Control de asistencia (MTESS) y resumen de jornales para IPS.</p>
        </div>
      </div>

      {msg && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400">{msg}</div>}

      {/* Completitud de datos maestros */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <ClipboardCheck size={17} className="text-emerald-500" />
            <h2 className="font-bold text-slate-900 dark:text-white">Completitud de datos</h2>
            <span className="text-xs text-slate-400 dark:text-white/30">C.I., N° IPS, salario base y horario</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadCompleteness} disabled={loadingComp}
              className="px-3 py-2 rounded-xl border border-slate-200 hover:border-emerald-300 text-sm text-slate-600 dark:border-white/[0.08] dark:text-white/70 disabled:opacity-50">
              {loadingComp ? 'Revisando...' : 'Revisar'}
            </button>
            <button onClick={downloadLegalTemplate}
              className="px-3 py-2 rounded-xl border border-slate-200 hover:border-blue-300 text-sm text-slate-600 dark:border-white/[0.08] dark:text-white/70 flex items-center gap-1.5">
              <Download size={14} /> Plantilla
            </button>
            <label className="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm flex items-center gap-1.5 cursor-pointer">
              <Upload size={14} /> {importing ? 'Importando...' : 'Importar'}
              <input type="file" accept=".xlsx" onChange={handleLegalImport} disabled={importing} className="hidden" />
            </label>
          </div>
        </div>

        {importMsg && <div className="mb-3 text-sm rounded-xl px-4 py-2.5 bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-400/[0.08] dark:border-blue-400/30 dark:text-blue-300">{importMsg}</div>}

        {comp ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
              <StatChip label="Completos" value={comp.complete} total={comp.total} good />
              <StatChip label="Sin C.I." value={comp.counts.sin_ci} />
              <StatChip label="Sin N° IPS" value={comp.counts.sin_ips} />
              <StatChip label="Sin salario" value={comp.counts.sin_salario} />
              <StatChip label="Sin horario" value={comp.counts.sin_horario} />
            </div>
            {comp.incomplete.length ? (
              <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-xl border border-slate-100 dark:border-white/[0.06]">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06] sticky top-0">
                    <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                      <th className="px-3 py-2">Empleado</th><th className="px-3 py-2">Depto.</th><th className="px-3 py-2">Falta</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                    {comp.incomplete.map((r: any) => (
                      <tr key={r.id} className="text-slate-700 dark:text-white/70">
                        <td className="px-3 py-2"><span className="font-mono text-xs text-slate-400">{r.code}</span> {r.name}</td>
                        <td className="px-3 py-2 text-slate-400 dark:text-white/40">{r.department || '—'}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.missing.map((m: string) => (
                              <span key={m} className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">{m}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2"><CheckCircle2 size={16} /> Todos los empleados activos tienen sus datos completos.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400 dark:text-white/30 flex items-center gap-2">
            <AlertTriangle size={15} /> Revisá qué empleados no tienen C.I., N° IPS, salario base u horario asignado. Podés cargarlos en masa con la plantilla.
          </p>
        )}
      </section>

      {/* Datos del empleador */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2 mb-4">
          <Building2 size={17} className="text-cyan-500" />
          <h2 className="font-bold text-slate-900 dark:text-white">Datos del empleador</h2>
          <span className="text-xs text-slate-400 dark:text-white/30">Aparecen en el encabezado de las planillas</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {EMPLOYER_FIELDS.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">{f.label}</label>
              <input value={emp[f.key] || ''} onChange={e => setEmp(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.ph || ''}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent" />
            </div>
          ))}
        </div>
        <div className="mt-4">
          <button onClick={saveEmployer} disabled={saving}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm flex items-center gap-2 disabled:opacity-50">
            <Save size={15} /> {saving ? 'Guardando...' : 'Guardar datos del empleador'}
          </button>
        </div>
      </section>

      {/* Período + generación */}
      <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-bold text-slate-900 dark:text-white mb-4">Generar planilla del período</h2>
        <div className="flex flex-wrap gap-3 items-end mb-5">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Mes</label>
            <select value={month} onChange={e => setMonth(+e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
              {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Año</label>
            <input type="number" value={year} onChange={e => setYear(+e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-28 dark:border-white/[0.08] bg-transparent" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1 dark:text-white/40">Departamento</label>
            <select value={dept} onChange={e => setDept(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] bg-transparent">
              <option value="">Todos</option>
              {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onClick={downloadMtess}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-cyan-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-cyan-400/30">
            <div className="w-10 h-10 rounded-xl bg-cyan-50 text-cyan-600 flex items-center justify-center dark:bg-cyan-400/10 dark:text-cyan-400"><Download size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Planilla MTESS (PDF)</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Control de asistencia: entrada/salida diaria</div>
            </div>
          </button>
          <button onClick={downloadIpsExcel}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-emerald-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-emerald-400/30">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center dark:bg-emerald-400/10 dark:text-emerald-400"><FileSpreadsheet size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Jornales IPS (Excel)</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Días y horas por empleado (C.I. y N° IPS)</div>
            </div>
          </button>
          <button onClick={previewIps}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-slate-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-white/[0.16]">
            <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center dark:bg-white/[0.06] dark:text-white/50"><FileText size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Vista previa IPS</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Ver el resumen en pantalla</div>
            </div>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-100 dark:border-white/[0.06]">
          <button onClick={downloadComunicacion}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-blue-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-blue-400/30">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center dark:bg-blue-400/10 dark:text-blue-400"><FileSpreadsheet size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Planilla de comunicación MTESS (Excel)</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Formato de carga oficial · días trabajados por tipo de pago</div>
            </div>
          </button>
          <button onClick={previewComunicacion}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-slate-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-white/[0.16]">
            <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center dark:bg-white/[0.06] dark:text-white/50"><FileText size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Vista previa comunicación</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Verificar días trabajados y descuentos</div>
            </div>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <button onClick={downloadAportesExcel}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-violet-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-violet-400/30">
            <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center dark:bg-violet-400/10 dark:text-violet-400"><FileSpreadsheet size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Aportes IPS con montos (Excel)</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Salario base + obrero 9% + patronal 16,5%</div>
            </div>
          </button>
          <button onClick={previewAportes}
            className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 hover:border-slate-300 hover:-translate-y-0.5 transition-all text-left dark:border-white/[0.08] dark:hover:border-white/[0.16]">
            <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center dark:bg-white/[0.06] dark:text-white/50"><FileText size={18} /></div>
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">Vista previa de aportes</div>
              <div className="text-[11px] text-slate-400 dark:text-white/40">Requiere salario base cargado por empleado</div>
            </div>
          </button>
        </div>
      </section>

      {/* Vista previa planilla de comunicación MTESS */}
      {(loadingComun || comun) && (
        <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-bold text-slate-900 dark:text-white mb-1">Planilla de comunicación — {MESES[month - 1]} {year}</h2>
          {comun?.config && (
            <p className="text-xs text-slate-400 dark:text-white/30 mb-3">
              Mensualizados: base {comun.config.base_mensual ?? 30} días, menos reposo / ausencia injustificada / licencia especial / sin goce / vacaciones ·
              Jornaleros: días efectivamente trabajados. Los francos/libres, feriados y permisos con goce no descuentan.
            </p>
          )}
          {loadingComun ? (
            <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Cargando...</p>
          ) : comun && comun.data.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
                  <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                    <th className="px-3 py-2">Empleado</th><th className="px-3 py-2">C.I.</th>
                    <th className="px-3 py-2">Tipo</th><th className="px-3 py-2 text-right">Base</th>
                    <th className="px-3 py-2 text-right">Descuentos</th><th className="px-3 py-2 text-right">Días a informar</th>
                    <th className="px-3 py-2 text-right">Hs ord.</th><th className="px-3 py-2 text-right">Hs extra</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                  {comun.data.map((r, i) => (
                    <tr key={i} className="text-slate-700 dark:text-white/70">
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2 tabular-nums">{r.nro_ci || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${r.pay_type === 'jornalero' ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300' : 'bg-cyan-100 text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300'}`}>
                          {r.pay_type === 'jornalero' ? 'Jornalero' : 'Mensual'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-400">{r.pay_type === 'jornalero' ? '—' : r.base}</td>
                      <td className="px-3 py-2 text-right tabular-nums" title={Object.entries(r.detalle || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}>
                        {r.descuentos ? <span className="text-rose-600 dark:text-rose-400">−{r.descuentos}</span> : <span className="text-slate-300">0</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-slate-900 dark:text-white">{r.canti_dias_trabajados}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.horas_ordinarias}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.horas_extraordinarias}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-400 dark:text-white/30 mt-3">
                Pasá el cursor sobre &quot;Descuentos&quot; para ver el detalle por tipo. El tipo de pago (mensual/jornalero) se define en cada empleado.
              </p>
            </div>
          ) : (
            <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin datos para el período.</p>
          )}
        </section>
      )}

      {/* Vista previa aportes IPS */}
      {(loadingAp || aportes) && (
        <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-bold text-slate-900 dark:text-white mb-1">Aportes IPS — {MESES[month - 1]} {year}</h2>
          {aportes?.rates && <p className="text-xs text-slate-400 dark:text-white/30 mb-3">Tasas: obrero {aportes.rates.obrero ?? 9}% · patronal {aportes.rates.patronal ?? 16.5}%</p>}
          {loadingAp ? (
            <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Cargando...</p>
          ) : aportes && aportes.data.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
                  <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                    <th className="px-3 py-2">Empleado</th><th className="px-3 py-2">C.I.</th><th className="px-3 py-2">N° IPS</th>
                    <th className="px-3 py-2 text-right">Salario base</th><th className="px-3 py-2 text-right">Obrero</th>
                    <th className="px-3 py-2 text-right">Patronal</th><th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                  {aportes.data.map((r, i) => (
                    <tr key={i} className="text-slate-700 dark:text-white/70">
                      <td className="px-3 py-2">{r.nombre}</td>
                      <td className="px-3 py-2 tabular-nums">{r.cedula || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{r.ips || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₲ {gs(r.salario_base)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₲ {gs(r.aporte_obrero)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₲ {gs(r.aporte_patronal)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">₲ {gs(r.total_aporte)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 dark:border-white/[0.1] font-bold text-slate-900 dark:text-white">
                    <td className="px-3 py-2" colSpan={3}>TOTALES</td>
                    <td className="px-3 py-2 text-right tabular-nums">₲ {gs(aportes.totals.salario_base)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">₲ {gs(aportes.totals.aporte_obrero)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">₲ {gs(aportes.totals.aporte_patronal)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">₲ {gs(aportes.totals.total_aporte)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin datos. Cargá el salario base de los empleados para calcular aportes.</p>
          )}
        </section>
      )}

      {/* Vista previa IPS */}
      {(loadingIps || ips) && (
        <section className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <h2 className="font-bold text-slate-900 dark:text-white mb-3">Resumen IPS — {MESES[month - 1]} {year}</h2>
          {loadingIps ? (
            <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Cargando...</p>
          ) : ips && ips.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
                  <tr className="text-left text-xs uppercase text-slate-500 dark:text-white/40">
                    <th className="px-3 py-2">Código</th><th className="px-3 py-2">Empleado</th>
                    <th className="px-3 py-2">C.I.</th><th className="px-3 py-2">N° IPS</th>
                    <th className="px-3 py-2 text-right">Días</th><th className="px-3 py-2 text-right">Horas</th>
                    <th className="px-3 py-2 text-right">H. extra</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                  {ips.map((r, i) => (
                    <tr key={i} className="text-slate-700 dark:text-white/70">
                      <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2 tabular-nums">{r.ci || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{r.ips || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.dias_trabajados}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.horas_trabajadas}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.horas_extra}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-slate-400 text-sm py-6 text-center dark:text-white/30">Sin datos para el período.</p>
          )}
        </section>
      )}
    </div>
  )
}

function StatChip({ label, value, total, good }: { label: string; value: number; total?: number; good?: boolean }) {
  const alert = !good && value > 0
  return (
    <div className={`rounded-xl px-3 py-2 border ${
      good ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30'
      : alert ? 'bg-amber-50 border-amber-200 dark:bg-amber-400/[0.08] dark:border-amber-400/30'
      : 'bg-slate-50 border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]'}`}>
      <div className={`text-xl font-bold tabular-nums ${good ? 'text-emerald-700 dark:text-emerald-400' : alert ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-white/50'}`}>
        {value}{total != null ? <span className="text-xs font-normal text-slate-400">/{total}</span> : null}
      </div>
      <div className="text-[11px] text-slate-500 dark:text-white/40">{label}</div>
    </div>
  )
}
