'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Clock, BarChart2, User, QrCode } from 'lucide-react'
import { useCurrentUser } from '@/lib/useCurrentUser'

/**
 * Barra de navegación inferior — móvil only, employee only.
 *
 * Reglas de diseño:
 * - Solo visible para usuarios con rol 'employee' en pantallas <md (768px).
 * - Admin/HR/super_admin NO la ven (usan el sidebar).
 * - Oculta en /login, /kiosk.
 * - Respeta safe-area-inset-bottom (notch / home indicator iPhone).
 * - El item Marcar es destacado (botón flotante elevado, color primario).
 */
export default function MobileBottomNav() {
  const pathname = usePathname()
  const user = useCurrentUser()

  // Reglas tempranas de no-render
  if (!user) return null
  if (user.role !== 'employee') return null
  if (pathname.startsWith('/login') || pathname.startsWith('/kiosk')) return null

  const items = [
    { href: '/mi-perfil',     label: 'Perfil',     icon: User      },
    { href: '/mi-asistencia', label: 'Asistencia', icon: Clock     },
    { href: '/marcar',        label: 'Marcar',     icon: QrCode, primary: true },
    { href: '/mis-permisos',  label: 'Permisos',   icon: BarChart2 },
  ]

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.04)] dark:bg-white/[0.04] dark:border-white/[0.08]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Navegación inferior">
      <div className="grid grid-cols-4">
        {items.map(({ href, label, icon: Icon, primary }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          if (primary) {
            // Botón "Marcar" destacado — más grande y con color primario
            return (
              <Link key={href} href={href}
                className="flex flex-col items-center gap-1 py-2 transition-colors"
                aria-current={active ? 'page' : undefined}>
                <span className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg transition-colors
                  ${active ? 'bg-blue-700 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                  <Icon size={22} aria-hidden="true" />
                </span>
                <span className={`text-[10px] font-semibold ${active ? 'text-blue-700' : 'text-blue-600'}`}>
                  {label}
                </span>
              </Link>
            )
          }
          return (
            <Link key={href} href={href}
              className={`flex flex-col items-center gap-1 py-3 transition-colors ${
                active ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
              }`}
              aria-current={active ? 'page' : undefined}>
              <Icon size={20} aria-hidden="true" />
              <span className="text-[10px] font-medium">{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
