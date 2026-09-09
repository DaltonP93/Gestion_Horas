'use client'
import { useEffect, useState } from 'react'
import { FileText, Download, AlertCircle, Receipt, FileSignature, BadgeCheck, File } from 'lucide-react'
import { api, apiUrl, downloadUrl } from '@/lib/api'

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

interface Doc {
  id: number
  category: 'payslip' | 'contract' | 'certificate' | 'other'
  period: string | null
  title: string
  filename: string
  size_bytes: number
  mime: string | null
  uploaded_at: string
  note: string | null
}

const CATEGORY_LABEL: Record<Doc['category'], string> = {
  payslip: 'Recibos de sueldo',
  contract: 'Contratos',
  certificate: 'Certificados',
  other: 'Otros',
}
const CATEGORY_ICON: Record<Doc['category'], typeof FileText> = {
  payslip: Receipt, contract: FileSignature, certificate: BadgeCheck, other: File,
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export default function MisDocumentosPage() {
  const [items, setItems] = useState<Doc[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  function descargarRecibo() {
    // Recibo informativo generado al vuelo por la API para el propio empleado.
    // El JWT viaja como ?access_token= (downloadUrl) porque es una descarga GET.
    window.open(downloadUrl('/api/me/payslip/pdf', { year, month }), '_blank')
  }

  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i)

  useEffect(() => {
    api.get<{ items: Doc[] }>('/api/me/documents')
      .then(r => setItems(r.data.items || []))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false))
  }, [])

  async function download(d: Doc) {
    try {
      const res = await api.get(`/api/me/documents/${d.id}/download`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = d.filename; a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
  }

  const groups = items.reduce((acc, d) => {
    (acc[d.category] ||= []).push(d); return acc
  }, {} as Record<Doc['category'], Doc[]>)

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-fuchsia-500 flex items-center justify-center">
          <FileText className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Mis documentos</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Tus recibos de sueldo, contratos y certificados.</p>
        </div>
      </header>

      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2 mb-3">
          <Receipt size={16} className="text-fuchsia-600" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Descargar mi recibo</h2>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500 dark:text-white/40">
            Mes
            <select value={month} onChange={e => setMonth(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/[0.06] px-3 py-1.5 text-sm text-slate-900 dark:text-white">
              {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500 dark:text-white/40">
            Año
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/[0.06] px-3 py-1.5 text-sm text-slate-900 dark:text-white">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <button onClick={descargarRecibo}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
            <Download size={14} /> Descargar recibo
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-400 dark:text-white/30">
          Documento informativo, no constituye liquidación legal certificada.
        </p>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-sm text-red-900">
          <AlertCircle size={16} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-400">Cargando…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 text-center text-slate-500 dark:bg-white/[0.04] dark:border-white/[0.06] dark:text-white/40">
          Aún no tenés documentos publicados.
        </div>
      ) : (
        (['payslip', 'contract', 'certificate', 'other'] as Doc['category'][])
          .filter(c => groups[c]?.length)
          .map(c => {
            const Icon = CATEGORY_ICON[c]
            return (
              <section key={c} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
                <div className="px-5 py-3 border-b border-slate-100 dark:border-white/[0.06] flex items-center gap-2">
                  <Icon size={16} className="text-fuchsia-600" />
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{CATEGORY_LABEL[c]}</h2>
                  <span className="text-xs text-slate-400 ml-auto">{groups[c].length}</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-white/[0.03] text-left text-xs text-slate-500 uppercase tracking-wide dark:text-white/40">
                    <tr>
                      <th className="px-4 py-3">Título</th>
                      <th className="px-4 py-3">Período</th>
                      <th className="px-4 py-3">Publicado</th>
                      <th className="px-4 py-3">Tamaño</th>
                      <th className="px-4 py-3 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                    {groups[c].map(d => (
                      <tr key={d.id}>
                        <td className="px-4 py-2.5 text-slate-900 dark:text-white">{d.title}</td>
                        <td className="px-4 py-2.5 text-slate-600 dark:text-white/60">{d.period || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-500 text-xs dark:text-white/40">
                          {new Date(d.uploaded_at).toLocaleString('es-PY')}
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 text-xs dark:text-white/40">{fmtSize(d.size_bytes)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => download(d)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
                            <Download size={12} /> Descargar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )
          })
      )}
    </div>
  )
}
