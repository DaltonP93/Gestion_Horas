/**
 * documentPreview.ts — reglas puras de la vista previa de documentos.
 *
 * Viven fuera del componente porque son la parte con más casos borde: qué
 * formato se puede mostrar, de dónde sale el MIME cuando el backend no lo
 * guardó, y qué decirle al usuario ante cada fallo.
 */

export type PreviewKind = 'pdf' | 'image' | 'unsupported'

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** Extensión → MIME, sólo para los formatos que la aplicación acepta subir. */
const EXT_MIME: Record<string, string> = {
  pdf:  'application/pdf',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * MIME efectivo del documento. Se prefiere el del blob —lo pone el servidor
 * en la respuesta— y se cae al registrado y por último a la extensión del
 * nombre de archivo. Los documentos viejos pueden tener `mime` nulo, y
 * algunos servidores devuelven `application/octet-stream` para todo.
 */
export function resolveMime(
  blobType: string | null | undefined,
  docMime: string | null | undefined,
  filename: string | null | undefined
): string | null {
  const generic = (t?: string | null) =>
    !t || t === 'application/octet-stream' || t === 'binary/octet-stream'

  if (!generic(blobType)) return String(blobType).split(';')[0].trim().toLowerCase()
  if (!generic(docMime))  return String(docMime).split(';')[0].trim().toLowerCase()

  const ext = String(filename || '').split('.').pop()?.toLowerCase()
  return (ext && EXT_MIME[ext]) || null
}

/** Cómo se debe renderizar ese MIME. Lo desconocido nunca se intenta pintar. */
export function previewKind(mime: string | null | undefined): PreviewKind {
  if (!mime) return 'unsupported'
  const m = mime.split(';')[0].trim().toLowerCase()
  if (m === 'application/pdf') return 'pdf'
  if (IMAGE_MIMES.has(m)) return 'image'
  return 'unsupported'
}

/**
 * Mensaje para el usuario a partir del error de Axios. No se filtran rutas
 * del servidor ni detalles internos: sólo el estado y qué puede hacer.
 */
export function previewErrorMessage(err: unknown): string {
  const e = err as { response?: { status?: number }; message?: string; code?: string }
  const status = e?.response?.status

  switch (status) {
    case 401:
      return 'La sesión expiró. Volvé a iniciar sesión para ver el documento.'
    case 403:
      return 'No tenés permiso para ver este documento.'
    case 404:
      return 'El documento ya no existe.'
    case 410:
      return 'El archivo no está disponible en el servidor. Avisá a un administrador.'
    default:
      break
  }
  if (status && status >= 500) return 'El servidor no pudo entregar el documento. Intentá de nuevo.'
  if (e?.code === 'ECONNABORTED') return 'La descarga tardó demasiado. Intentá de nuevo.'
  return 'No se pudo obtener el documento. Verificá la conexión e intentá de nuevo.'
}

/** Un blob vacío es un archivo truncado o mal servido: no se muestra en blanco. */
export function isEmptyBlob(blob: { size?: number } | null | undefined): boolean {
  return !blob || !blob.size
}
