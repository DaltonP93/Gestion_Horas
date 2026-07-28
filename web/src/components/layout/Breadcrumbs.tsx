'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { locateByPath } from '@/lib/navModules'

/**
 * Breadcrumbs: Módulo → Submódulo, derivados de la ruta actual y la
 * estructura de navegación. No aparecen en el portal del empleado ni en
 * rutas fuera de los módulos (login, cuenta, etc.).
 */
export default function Breadcrumbs() {
  const pathname = usePathname()
  const { t } = useI18n()
  const located = locateByPath(pathname)
  if (!located) return null

  const { group, item } = located
  const onModuleLanding = pathname === `/m/${group.id}`

  return (
    <nav aria-label="Ruta" className="px-4 md:px-6 pt-3 text-xs text-slate-400 dark:text-white/30">
      <ol className="flex items-center gap-1.5 flex-wrap">
        <li>
          <Link href={`/m/${group.id}`} className="hover:text-slate-600 dark:hover:text-white/60">{group.label}</Link>
        </li>
        {!onModuleLanding && (
          <>
            <ChevronRight size={12} aria-hidden="true" />
            <li className="text-slate-600 font-medium dark:text-white/60" aria-current="page">{t(item.i18nKey)}</li>
          </>
        )}
      </ol>
    </nav>
  )
}
