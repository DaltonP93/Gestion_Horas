'use client'
import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import ModuleLanding from '@/components/layout/ModuleLanding'
import { normalizeGroupSlug } from '@/lib/navRouting'

// Página principal de cada módulo (tarjetas hacia sus submódulos).
// Si el slug es un alias (p.ej. /m/talento-desarrollo), se redirige a la ruta
// canónica (/m/talento) sin romper el enlace; igual se renderiza el módulo
// resuelto para evitar el parpadeo de "Módulo no encontrado".
export default function ModulePage() {
  const { group } = useParams<{ group: string }>()
  const router = useRouter()
  const raw = String(group)
  const canonical = normalizeGroupSlug(raw)

  useEffect(() => {
    if (canonical !== raw) router.replace(`/m/${canonical}`)
  }, [canonical, raw, router])

  return <ModuleLanding groupId={canonical} />
}
