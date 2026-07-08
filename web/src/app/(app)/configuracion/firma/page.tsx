'use client'
import { useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PenLine, Upload, Stamp, Save, Trash2, Pencil, Image as ImageIcon } from 'lucide-react'
import { api, apiUrl } from '@/lib/api'
import SignaturePad, { type SignaturePadHandle } from '@/components/SignaturePad'
import BackButton from '@/components/BackButton'

export default function FirmaDigitalPage() {
  const qc = useQueryClient()
  const [signerName, setSignerName] = useState('')
  const [signerPosition, setSignerPosition] = useState('')
  const [signerDocId, setSignerDocId] = useState('')
  const [signatureUrl, setSignatureUrl] = useState('')
  const [sealUrl, setSealUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings').then(r => r.data),
  })

  useEffect(() => {
    if (!data) return
    setSignerName(data.system_signer_name || '')
    setSignerPosition(data.system_signer_position || '')
    setSignerDocId(data.system_signer_doc_id || '')
    setSignatureUrl(data.system_signature_url || '')
    setSealUrl(data.system_seal_url || '')
  }, [data])

  const sigInputRef  = useRef<HTMLInputElement>(null)
  const sealInputRef = useRef<HTMLInputElement>(null)
  const padRef       = useRef<SignaturePadHandle>(null)
  const [sigMode, setSigMode] = useState<'upload' | 'draw'>('upload')

  async function saveDrawnSignature() {
    const dataUrl = padRef.current?.toDataUrl()
    if (!dataUrl) return alert('Dibujá la firma antes de guardar')
    try {
      const r = await api.post('/api/settings/signature-canvas', { dataUrl, kind: 'signature' })
      setSignatureUrl(r.data.url)
      qc.invalidateQueries({ queryKey: ['settings'] })
      alert('Firma guardada ✅')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al guardar firma')
    }
  }

  async function uploadFile(file: File, kind: 'signature' | 'seal') {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const r = await api.post(`/api/settings/upload?kind=${kind}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      if (kind === 'signature') setSignatureUrl(r.data.url)
      else setSealUrl(r.data.url)
      qc.invalidateQueries({ queryKey: ['settings'] })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al subir archivo')
    }
  }

  async function saveText() {
    setSaving(true)
    try {
      await api.put('/api/settings', {
        system_signer_name: signerName,
        system_signer_position: signerPosition,
        system_signer_doc_id: signerDocId,
      })
      qc.invalidateQueries({ queryKey: ['settings'] })
      alert('Datos del firmante guardados ✅')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  async function clearSignature() {
    if (!confirm('¿Quitar la imagen de firma actual?')) return
    try {
      await api.put('/api/settings', { system_signature_url: '' })
      setSignatureUrl('')
      qc.invalidateQueries({ queryKey: ['settings'] })
    } catch {}
  }

  async function clearSeal() {
    if (!confirm('¿Quitar la imagen de sello actual?')) return
    try {
      await api.put('/api/settings', { system_seal_url: '' })
      setSealUrl('')
      qc.invalidateQueries({ queryKey: ['settings'] })
    } catch {}
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <BackButton href="/configuracion" label="Configuración" />
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
          <PenLine className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Firma digital de planillas</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">
            Esta firma e información se inserta automáticamente en los PDFs de planilla mensual.
          </p>
        </div>
      </div>

      {/* Datos del firmante */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h3 className="font-semibold text-slate-700 dark:text-white/80">Datos del firmante</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Nombre completo</label>
            <input value={signerName} onChange={e => setSignerName(e.target.value)}
              placeholder="Ej: Juan Pérez"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Cargo</label>
            <input value={signerPosition} onChange={e => setSignerPosition(e.target.value)}
              placeholder="Ej: Gerente de RRHH"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Documento (opcional)</label>
            <input value={signerDocId} onChange={e => setSignerDocId(e.target.value)}
              placeholder="C.I. 1234567"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
          </div>
        </div>
        <button onClick={saveText} disabled={saving}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
          <Save size={14} /> {saving ? 'Guardando...' : 'Guardar datos'}
        </button>
      </div>

      {/* Firma */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h3 className="font-semibold text-slate-700 flex items-center gap-2 dark:text-white/80">
          <PenLine size={16} className="text-amber-600" /> Imagen de firma
        </h3>
        <p className="text-xs text-slate-500 dark:text-white/40">
          PNG con fondo transparente recomendado. Tamaño sugerido: 400×150 px.
        </p>

        {signatureUrl ? (
          <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl border border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
            <img src={apiUrl(signatureUrl)} alt="Firma" className="h-20 max-w-[300px] object-contain bg-white p-2 rounded dark:bg-white/[0.04]" />
            <div className="flex-1">
              <p className="text-sm text-slate-700 font-medium dark:text-white/80">Firma actual</p>
              <p className="text-xs text-slate-400 font-mono dark:text-white/30">{signatureUrl}</p>
            </div>
            <button onClick={clearSignature} className="text-rose-600 hover:bg-rose-50 px-3 py-2 rounded-lg text-sm">
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 dark:text-white/30 dark:border-white/[0.08]">
            <PenLine size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">Sin firma cargada</p>
          </div>
        )}

        {/* Tabs subir / dibujar */}
        <div className="flex bg-slate-100 rounded-xl p-1 w-fit dark:bg-white/[0.06]">
          <button onClick={() => setSigMode('upload')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              sigMode === 'upload' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500'
            }`}>
            <ImageIcon size={14} /> Subir imagen
          </button>
          <button onClick={() => setSigMode('draw')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              sigMode === 'draw' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500'
            }`}>
            <Pencil size={14} /> Dibujar firma
          </button>
        </div>

        {sigMode === 'upload' ? (
          <>
            <input ref={sigInputRef} type="file" accept="image/png,image/jpeg" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, 'signature') }} />
            <button onClick={() => sigInputRef.current?.click()}
              className="flex items-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <Upload size={14} /> Subir imagen de firma
            </button>
          </>
        ) : (
          <div className="space-y-3">
            <SignaturePad ref={padRef} width={500} height={180} />
            <button onClick={saveDrawnSignature}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
              <Save size={14} /> Guardar firma dibujada
            </button>
          </div>
        )}
      </div>

      {/* Sello */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h3 className="font-semibold text-slate-700 flex items-center gap-2 dark:text-white/80">
          <Stamp size={16} className="text-rose-600" /> Sello (opcional)
        </h3>
        <p className="text-xs text-slate-500 dark:text-white/40">
          PNG circular con fondo transparente. Tamaño sugerido: 300×300 px.
        </p>

        {sealUrl ? (
          <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl border border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
            <img src={apiUrl(sealUrl)} alt="Sello" className="h-20 w-20 object-contain bg-white p-2 rounded dark:bg-white/[0.04]" />
            <div className="flex-1">
              <p className="text-sm text-slate-700 font-medium dark:text-white/80">Sello actual</p>
              <p className="text-xs text-slate-400 font-mono dark:text-white/30">{sealUrl}</p>
            </div>
            <button onClick={clearSeal} className="text-rose-600 hover:bg-rose-50 px-3 py-2 rounded-lg text-sm">
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 dark:text-white/30 dark:border-white/[0.08]">
            <Stamp size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">Sin sello cargado</p>
          </div>
        )}

        <input ref={sealInputRef} type="file" accept="image/png,image/jpeg" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, 'seal') }} />
        <button onClick={() => sealInputRef.current?.click()}
          className="flex items-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
          <Upload size={14} /> Subir imagen de sello
        </button>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700">
        <strong>Nota:</strong> La firma y los datos del firmante se aplicarán automáticamente en los PDFs de planilla mensual generados desde el módulo de Reportes → Resumen mensual.
      </div>
    </div>
  )
}
