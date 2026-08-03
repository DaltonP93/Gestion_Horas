'use client'
import { useEffect, useState, useRef } from 'react'
import { FileText, Upload, Download, Trash2, Eye, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import DocumentPreviewModal, { type PreviewDoc } from './DocumentPreviewModal'
import { previewErrorMessage } from '@/lib/documentPreview'

interface Doc {
  id: number
  category: 'payslip' | 'contract' | 'certificate' | 'other'
  period: string | null
  title: string
  filename: string
  size_bytes: number
  mime: string | null
  uploaded_at: string
  visible_to_employee: 0 | 1
  note: string | null
  uploaded_by_username: string | null
}

const CATEGORY_LABEL: Record<Doc['category'], string> = {
  payslip: 'Recibo de sueldo',
  contract: 'Contrato',
  certificate: 'Certificado',
  other: 'Otro',
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export default function EmployeeDocuments({ employeeId }: { employeeId: number }) {
  const [items, setItems] = useState<Doc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [uploading, setUploading] = useState(false)
  const [category, setCategory] = useState<Doc['category']>('payslip')
  const [period, setPeriod]     = useState('')
  const [title, setTitle]       = useState('')
  const [note, setNote]         = useState('')
  const [visible, setVisible]   = useState(true)
  const [preview, setPreview]   = useState<PreviewDoc | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function load() {
    setError('')
    try {
      const { data } = await api.get<{ items: Doc[] }>(`/api/employees/${employeeId}/documents`)
      setItems(data.items || [])
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { if (employeeId) load() }, [employeeId])

  async function upload(file: File) {
    setError(''); setMsg(''); setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('category', category)
    if (period)  fd.append('period', period)
    if (title)   fd.append('title', title)
    if (note)    fd.append('note', note)
    fd.append('visible_to_employee', visible ? '1' : '0')
    try {
      await api.post(`/api/employees/${employeeId}/documents`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setMsg('Documento publicado.')
      setTitle(''); setNote(''); setPeriod('')
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
    finally { setUploading(false) }
  }

  async function download(d: { id: number; filename: string }) {
    try {
      const res = await api.get(`/api/employees/${employeeId}/documents/${d.id}/download`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = d.filename; a.click()
      URL.revokeObjectURL(url)
    } catch (e: unknown) {
      // Con responseType 'blob' el cuerpo del error también llega como Blob,
      // así que `e.response.data.error` no es texto: era un objeto vacío en
      // pantalla. Se traduce por estado, igual que la vista previa.
      setError(previewErrorMessage(e))
    }
  }

  async function remove(d: Doc) {
    if (!confirm(`Eliminar "${d.title}"? Esta acción no se puede deshacer.`)) return
    setError(''); setMsg('')
    try {
      await api.delete(`/api/employees/${employeeId}/documents/${d.id}`)
      setMsg('Documento eliminado.')
      setItems(prev => prev.filter(x => x.id !== d.id))
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <h2 className="font-semibold text-slate-700 flex items-center gap-2 dark:text-white/80 mb-3">
        <FileText size={16} className="text-fuchsia-500" /> Documentos
        <span className="text-xs text-slate-400 ml-auto">{items.length}</span>
      </h2>

      {error && (
        <div className="text-xs bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 mb-3 flex items-center gap-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {msg && (
        <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 mb-3 flex items-center gap-2">
          <CheckCircle2 size={12} /> {msg}
        </div>
      )}

      {/* Formulario de carga */}
      <div className="rounded-xl border border-dashed border-slate-200 p-3 mb-4 dark:border-white/[0.08]">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
          <div>
            <label className="text-[10px] font-medium text-slate-500 uppercase block mb-1 dark:text-white/40">Categoría</label>
            <select value={category} onChange={e => setCategory(e.target.value as Doc['category'])}
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
              <option value="payslip">Recibo de sueldo</option>
              <option value="contract">Contrato</option>
              <option value="certificate">Certificado</option>
              <option value="other">Otro</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-slate-500 uppercase block mb-1 dark:text-white/40">Período (YYYY-MM)</label>
            <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </div>
          <div className="col-span-2">
            <label className="text-[10px] font-medium text-slate-500 uppercase block mb-1 dark:text-white/40">Título (opcional)</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Auto-generado si vacío"
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
          <div className="col-span-2 md:col-span-3">
            <label className="text-[10px] font-medium text-slate-500 uppercase block mb-1 dark:text-white/40">Nota (opcional)</label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </div>
          <label className="flex items-end gap-2 text-xs text-slate-600 dark:text-white/60 pb-1">
            <input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} />
            Visible al empleado
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" className="hidden"
            accept="application/pdf,image/jpeg,image/png,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-medium disabled:opacity-60">
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Subir documento
          </button>
          <span className="text-[10px] text-slate-400 dark:text-white/30">PDF, imagen, docx, xlsx · máx. 10 MB</span>
        </div>
      </div>

      {loading ? (
        <p className="text-center text-slate-400 text-sm py-4 dark:text-white/30">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="text-center text-slate-400 text-sm py-4 dark:text-white/30">Sin documentos publicados.</p>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-white/[0.05]">
          {items.map(d => (
            <div key={d.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/60 shrink-0">
                {CATEGORY_LABEL[d.category]}
              </span>
              <span className="text-slate-800 dark:text-white truncate flex-1">{d.title}</span>
              {d.period && <span className="text-xs text-slate-400 dark:text-white/30 font-mono">{d.period}</span>}
              <span className="text-[10px] text-slate-400 dark:text-white/30">{fmtSize(d.size_bytes)}</span>
              {/* Estado, no acción: es un badge y no debe leerse como botón.
                  El ojo pasó a ser el botón "Ver documento" de al lado. */}
              <span
                data-testid="doc-visibilidad"
                className={
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ' +
                  (d.visible_to_employee
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/60')
                }
              >
                {d.visible_to_employee ? 'Visible al empleado' : 'Privado'}
              </span>
              <button onClick={() => setPreview(d)} title="Ver documento"
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06]">
                <Eye size={14} className="text-slate-600 dark:text-white/60" />
              </button>
              <button onClick={() => download(d)} title="Descargar"
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06]">
                <Download size={14} className="text-slate-600 dark:text-white/60" />
              </button>
              <button onClick={() => remove(d)} title="Eliminar"
                className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10">
                <Trash2 size={14} className="text-red-500" />
              </button>
            </div>
          ))}
        </div>
      )}

      <DocumentPreviewModal
        open={!!preview}
        employeeId={employeeId}
        doc={preview}
        onClose={() => setPreview(null)}
        onDownload={download}
      />
    </div>
  )
}
