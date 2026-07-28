'use client'
import Link from 'next/link'
import { useI18n } from '@/i18n/I18nProvider'
import { groupById, useNavPermissions } from '@/lib/navModules'
import { normalizeGroupSlug } from '@/lib/navRouting'

/**
 * Página principal de un módulo: tarjetas hacia cada submódulo (referencia
 * visual: /sistema). Solo muestra los submódulos que el usuario puede ver.
 */
export default function ModuleLanding({ groupId }: { groupId: string }) {
  const { t } = useI18n()
  const { canSee } = useNavPermissions()
  // Normaliza el slug (acepta alias como talento-desarrollo → talento) antes de
  // buscar el módulo, para no mostrar "Módulo no encontrado" en rutas alias.
  const group = groupById(normalizeGroupSlug(groupId))

  if (!group) {
    return <div className="p-6 text-slate-400 dark:text-white/30">Módulo no encontrado.</div>
  }

  const items = group.items.filter(canSee)
  const GroupIcon = group.icon

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-slate-900 flex items-center justify-center dark:bg-white/10">
          <GroupIcon className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{group.label}</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">{group.desc}</p>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-white/30">No tenés acceso a los submódulos de este módulo.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {items.map(({ href, icon: Icon, i18nKey, desc, color }) => (
            <Link key={href} href={href}
              className="group bg-white rounded-2xl border border-slate-100 shadow-sm hover:shadow-md hover:border-slate-200 transition-all p-5 flex flex-col dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className={`w-11 h-11 rounded-xl ${color || 'bg-blue-500'} flex items-center justify-center mb-4 group-hover:scale-105 transition-transform`}>
                <Icon className="text-white" size={22} />
              </div>
              <h3 className="font-semibold text-slate-900 mb-1 dark:text-white">{t(i18nKey)}</h3>
              <p className="text-sm text-slate-500 leading-relaxed dark:text-white/40">{desc}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
