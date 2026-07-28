'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Clock, Menu, X, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useI18n } from '@/i18n/I18nProvider'
import { apiUrl } from '@/lib/api'
import { useNavPermissions, visibleGroups, locateByPath } from '@/lib/navModules'

interface SidebarSettings {
  system_sidebar_bg?: string
  system_sidebar_text?: string
  system_sidebar_active?: string
  system_name?: string
}

const EXPANDED_KEY = 'sidebar_expanded_group'

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { t } = useI18n()
  const { user, canSee } = useNavPermissions()

  const [open, setOpen] = useState(false)               // drawer móvil
  const [theme, setTheme] = useState<SidebarSettings>({})
  const [expanded, setExpanded] = useState<string | null>(null)   // acordeón: un grupo abierto

  // Tema (no bloquea render)
  useEffect(() => {
    fetch(apiUrl('/api/settings')).then(r => r.ok ? r.json() : null).then(d => { if (d) setTheme(d) }).catch(() => {})
  }, [])

  // Cerrar drawer al navegar (móvil)
  useEffect(() => { setOpen(false) }, [pathname])

  const groups = visibleGroups(canSee)
  const located = locateByPath(pathname)
  const activeGroupId = located?.group.id || null

  // Acordeón: el grupo de la ruta actual se abre solo; si no, el recordado en sesión.
  useEffect(() => {
    if (activeGroupId) { setExpanded(activeGroupId); return }
    try {
      const saved = sessionStorage.getItem(EXPANDED_KEY)
      if (saved) setExpanded(saved)
    } catch {}
  }, [activeGroupId])

  function toggleGroup(id: string) {
    setExpanded(prev => {
      const next = prev === id ? null : id
      try { if (next) sessionStorage.setItem(EXPANDED_KEY, next); else sessionStorage.removeItem(EXPANDED_KEY) } catch {}
      return next
    })
  }

  const bg        = theme.system_sidebar_bg     || '#0f172a'
  const textColor = theme.system_sidebar_text   || '#94a3b8'
  const activeBg  = theme.system_sidebar_active || '#2563eb'

  const roleLabel = user?.role === 'super_admin' ? 'Super Admin'
    : user?.role === 'employee' ? 'Empleado'
    : user?.role ? user.role.replace('_', ' ') : ''

  const Content = (
    <>
      {/* Logo / branding */}
      <div className="px-6 py-5 border-b border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: activeBg }}>
              <Clock size={18} className="text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-white font-bold text-sm truncate">{theme.system_name || 'Asistencia'}</p>
              <p className="text-xs truncate" style={{ color: textColor }}>{roleLabel}</p>
            </div>
          </div>
          <button aria-label="Cerrar menú"
            className="md:hidden text-white/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white rounded-lg p-1"
            onClick={() => setOpen(false)}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Navegación por módulos (acordeón) */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Módulos">
        {groups.map(g => {
          const isOpen = expanded === g.id
          const isActiveGroup = activeGroupId === g.id
          const single = g.visibleItems.length === 1
          const GroupIcon = g.icon
          // Header: navega a la página del módulo (o directo al único submódulo).
          const headerHref = single ? g.visibleItems[0].href : `/m/${g.id}`
          return (
            <div key={g.id}>
              <div className="flex items-center">
                {/* Nombre del módulo → página principal (tarjetas) o único submódulo */}
                <button type="button"
                  onClick={() => { if (!single) setExpanded(g.id); router.push(headerHref) }}
                  className="flex-1 flex items-center gap-3 pl-3 pr-1 py-2.5 rounded-xl text-sm font-medium transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline focus-visible:outline-white text-left"
                  style={isActiveGroup ? { color: '#fff' } : { color: textColor }}>
                  <GroupIcon size={18} aria-hidden="true" />
                  <span className="flex-1 truncate">{g.label}</span>
                </button>
                {/* Chevron: solo despliega/repliega, sin navegar */}
                {!single && (
                  <button type="button" onClick={() => toggleGroup(g.id)} aria-expanded={isOpen}
                    aria-label={isOpen ? `Contraer ${g.label}` : `Expandir ${g.label}`}
                    className="p-2 rounded-lg hover:bg-white/5 focus-visible:outline-2 focus-visible:outline focus-visible:outline-white"
                    style={{ color: textColor }}>
                    <ChevronDown size={15} className={clsx('transition-transform', !isOpen && '-rotate-90')} aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* Submódulos */}
              {!single && isOpen && (
                <div className="mt-0.5 mb-1 ml-4 pl-3 border-l border-white/10 space-y-0.5">
                  {g.visibleItems.map(({ href, icon: Icon, i18nKey }) => {
                    const base = href.split('?')[0]
                    const active = pathname === base || pathname.startsWith(base + '/')
                    return (
                      <Link key={href} href={href} aria-current={active ? 'page' : undefined}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all hover:text-white focus-visible:outline-2 focus-visible:outline focus-visible:outline-white focus-visible:outline-offset-2"
                        style={active ? { backgroundColor: activeBg, color: '#fff' } : { color: textColor }}>
                        <Icon size={15} aria-hidden="true" />
                        <span className="truncate">{t(i18nKey)}</span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Identidad (solo lectura). El menú de cuenta vive en el avatar del TopBar. */}
      {user && (
        <div className="px-4 py-4 border-t border-white/10">
          <p className="text-white font-medium text-sm truncate">{user.fullName || user.username}</p>
          <p className="text-xs truncate capitalize" style={{ color: textColor }}>{roleLabel}</p>
        </div>
      )}
    </>
  )

  // Empleados en móvil: solo MobileBottomNav (el sidebar se oculta). En desktop sí.
  const isEmployee = user?.role === 'employee'

  return (
    <>
      {!isEmployee && (
        <button aria-label="Abrir menú" onClick={() => setOpen(true)}
          className="md:hidden fixed top-3 left-3 z-40 p-2 rounded-xl bg-slate-900 text-white shadow-lg">
          <Menu size={20} />
        </button>
      )}

      {open && !isEmployee && (
        <div role="button" tabIndex={0} aria-label="Cerrar menú"
          onClick={() => setOpen(false)}
          onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') setOpen(false) }}
          className="md:hidden fixed inset-0 bg-black/60 z-40" />
      )}

      <aside
        className={clsx(
          'w-64 min-h-screen flex-col z-50',
          'fixed md:sticky top-0 left-0 transition-transform duration-200',
          isEmployee ? 'hidden md:flex' : clsx('flex', open ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        )}
        style={{ backgroundColor: bg, maxHeight: '100vh' }}>
        {Content}
      </aside>
    </>
  )
}
