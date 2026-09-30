'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'

/**
 * AuthImage — muestra una imagen PRIVATA servida por un endpoint autenticado
 * de la API (fotos personales, firma/sello). El token viaja en el header
 * Authorization del cliente `api` (nunca en la URL); la imagen se muestra desde
 * un object URL local que se revoca al desmontar o cambiar de fuente.
 *
 * `version` fuerza la recarga cuando la imagen cambió (p. ej. tras subir otra).
 * Si no hay fuente o la API responde error, se muestra `fallback`.
 */
export default function AuthImage({
  src, alt = '', className, width, height, style, version, fallback = null,
}: {
  src: string | null | undefined
  alt?: string
  className?: string
  width?: number
  height?: number
  style?: React.CSSProperties
  version?: string | number | null
  fallback?: ReactNode
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)

  useEffect(() => {
    setObjectUrl(null)
    if (!src) return
    let active = true
    let created: string | null = null
    const ctrl = new AbortController()
    api.get(src, { responseType: 'blob', signal: ctrl.signal, params: version != null ? { v: String(version) } : undefined })
      .then((r) => {
        if (!active) return
        created = URL.createObjectURL(r.data as Blob)
        setObjectUrl(created)
      })
      .catch(() => { if (active) setObjectUrl(null) })
    return () => {
      active = false
      ctrl.abort()
      if (created) URL.revokeObjectURL(created)
    }
  }, [src, version])

  if (!objectUrl) return <>{fallback}</>
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={objectUrl} alt={alt} className={className} width={width} height={height} style={style} />
}
