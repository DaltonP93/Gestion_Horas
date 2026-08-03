'use client'
/**
 * DocumentPreviewModal — vista previa del documento dentro de SisHoras.
 *
 * El binario se pide con el cliente `api` autenticado y `responseType: 'blob'`.
 * No se arma un enlace directo al endpoint: sería una navegación del navegador
 * sin el Bearer token, y el servidor respondería 401. Nada se hace público.
 *
 * El componente es dueño del object URL: lo crea al recibir el blob y lo
 * revoca al cerrar, al cambiar de documento y al desmontarse. Si no, cada
 * apertura dejaría el blob retenido en memoria hasta recargar la página.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, Loader2, AlertCircle, FileText } from 'lucide-react'
import { api } from '@/lib/api'
import {
  resolveMime, previewKind, previewErrorMessage, isEmptyBlob, type PreviewKind,
} from '@/lib/documentPreview'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface PreviewDoc {
  id: number
  title: string
  filename: string
  mime: string | null
}

export default function DocumentPreviewModal({
  open, employeeId, doc, onClose, onDownload,
}: {
  open: boolean
  employeeId: number
  doc: PreviewDoc | null
  onClose: () => void
  onDownload: (doc: PreviewDoc) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [url, setUrl]         = useState<string | null>(null)
  const [kind, setKind]       = useState<PreviewKind>('unsupported')

  const panelRef  = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  // El object URL vivo, para poder revocarlo desde la limpieza sin
  // depender del estado (que ya podría haberse reemplazado).
  const urlRef = useRef<string | null>(null)

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const docId = doc?.id

  useEffect(() => {
    if (!open || !docId || !doc) return
    let cancelled = false

    // Cada apertura o cambio de documento suelta el anterior antes de pedir.
    revoke()
    setUrl(null)
    setError(null)
    setLoading(true)

    api.get(`/api/employees/${employeeId}/documents/${docId}/download`, { responseType: 'blob' })
      .then(res => {
        if (cancelled) return
        const blob = res.data as Blob
        if (isEmptyBlob(blob)) {
          setError('El documento llegó vacío. Puede estar dañado en el servidor.')
          return
        }
        const mime = resolveMime(blob?.type, doc.mime, doc.filename)
        const k = previewKind(mime)
        setKind(k)
        // Sólo se materializa la URL de lo que se va a mostrar. Para un
        // formato sin vista previa no hace falta retener el blob.
        if (k === 'unsupported') return
        const objectUrl = URL.createObjectURL(blob)
        urlRef.current = objectUrl
        setUrl(objectUrl)
      })
      .catch(err => { if (!cancelled) setError(previewErrorMessage(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [open, employeeId, docId, doc, revoke])

  // Revocar al cerrar y al desmontar.
  useEffect(() => {
    if (!open) revoke()
  }, [open, revoke])
  useEffect(() => revoke, [revoke])

  // Foco inicial y restauración al cerrar.
  useLayoutEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => {
      const opener = openerRef.current as HTMLElement | null
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [open])

  // El único contenedor scrolleable debe ser el cuerpo del modal.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const root = panelRef.current
    if (!root || !root.contains(e.target as Node)) return

    if (e.key === 'Escape') { onClose(); return }
    if (e.key !== 'Tab') return

    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (!nodes.length) return
    const first = nodes[0]
    const last  = nodes[nodes.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus()
    }
  }, [onClose])

  if (!open || !doc || typeof document === 'undefined') return null

  const overlay = (
    <div
      className="fixed inset-0 z-[100] h-[100dvh] overflow-hidden bg-black/60 sm:p-4"
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-preview-title"
        className="mx-auto flex h-full max-h-full w-full min-w-0 max-w-4xl flex-col overflow-hidden bg-white shadow-2xl sm:max-h-[90dvh] sm:rounded-2xl dark:bg-[#0d0d0f]"
      >
        {/* Encabezado fijo, fuera del contenedor scrolleable */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-6 dark:border-white/[0.06]">
          <div className="min-w-0">
            <h2 id="doc-preview-title" className="truncate text-base font-bold text-slate-900 dark:text-white">
              {doc.title}
            </h2>
            <p className="truncate text-xs text-slate-500 dark:text-white/50">{doc.filename}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onDownload(doc)}
              title="Descargar"
              className="rounded-lg p-1.5 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
            >
              <Download size={16} className="text-slate-600 dark:text-white/60" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar vista previa"
              className="rounded-lg p-1.5 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
            >
              <X size={18} className="text-slate-600 dark:text-white/60" />
            </button>
          </div>
        </div>

        {/* Cuerpo: único contenedor con scroll, y sólo vertical */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50 p-4 dark:bg-white/[0.02]">
          {loading && (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500 dark:text-white/50">
              <Loader2 size={16} className="animate-spin" /> Cargando documento…
            </p>
          )}

          {!loading && error && (
            <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
              <AlertCircle size={28} className="text-red-500" />
              <p className="text-sm text-slate-700 dark:text-white/80">{error}</p>
            </div>
          )}

          {!loading && !error && kind === 'unsupported' && (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
              <FileText size={28} className="text-slate-400" />
              <p className="text-sm text-slate-700 dark:text-white/80">
                Vista previa no disponible para este formato.
              </p>
              <button
                type="button"
                onClick={() => onDownload(doc)}
                className="inline-flex items-center gap-2 rounded-xl bg-fuchsia-600 px-4 py-2 text-xs font-medium text-white hover:bg-fuchsia-700"
              >
                <Download size={13} /> Descargar
              </button>
            </div>
          )}

          {!loading && !error && kind === 'pdf' && url && (
            <object
              data={url}
              type="application/pdf"
              aria-label={`Vista previa de ${doc.title}`}
              className="h-[70dvh] w-full min-w-0 rounded-xl border border-slate-200 bg-white dark:border-white/[0.08]"
            >
              {/* Si el navegador no trae visor de PDF embebido. */}
              <p className="p-4 text-sm text-slate-700 dark:text-white/80">
                Este navegador no puede mostrar el PDF.
              </p>
            </object>
          )}

          {!loading && !error && kind === 'image' && url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={url}
              alt={`Vista previa de ${doc.title}`}
              className="mx-auto h-auto max-w-full rounded-xl border border-slate-200 dark:border-white/[0.08]"
            />
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
