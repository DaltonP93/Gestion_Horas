'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  UserCircle2, SlidersHorizontal, ShieldCheck, LogOut,
} from 'lucide-react'
import { useCurrentUser, type Role } from '@/lib/useCurrentUser'
import { apiUrl } from '@/lib/api'
import { PopoverSurface, popoverItemClass, popoverDividerClass } from '@/components/ui/Popover'

// Etiqueta legible del rol (evita mostrar el enum crudo).
const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin:       'Administrador',
  gth:         'Gestión del Talento',
  hr:          'Recursos Humanos',
  gestor:      'Gestor',
  coordinator: 'Coordinador',
  manager:     'Jefe / Gerente',
  supervisor:  'Supervisor',
  employee:    'Empleado',
}

function initialsOf(name?: string, username?: string) {
  const src = (name || username || '?').trim()
  const parts = src.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

type MenuItem = { href: string; label: string; icon: typeof UserCircle2 }
// Un único punto de entrada a la seguridad — la página tiene pestañas
// internas Contraseña / Sesiones / 2FA. La antigua entrada "Cambiar
// contraseña" con hash `#password` producía URLs duplicadas al navegar
// entre pantallas (`#password#password`). Ver PR 2.
const ITEMS: MenuItem[] = [
  { href: '/cuenta/perfil',            label: 'Mi perfil',              icon: UserCircle2 },
  { href: '/cuenta/preferencias',      label: 'Preferencias',           icon: SlidersHorizontal },
  { href: '/cuenta/seguridad',         label: 'Seguridad de mi cuenta', icon: ShieldCheck },
]

/**
 * Menú de cuenta ÚNICO. Vive sólo en el avatar del TopBar (arriba a la derecha),
 * accesible tanto en escritorio como en móvil. No se duplica en el sidebar.
 *
 * Accesible: botón con aria-haspopup, menú con roles ARIA, navegación por teclado
 * (Escape / flechas), cierra al hacer clic fuera.
 */
export default function AccountMenu() {
  const user = useCurrentUser()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const btnRef  = useRef<HTMLButtonElement>(null)

  const roleLabel = user ? (ROLE_LABEL[user.role] || user.role.replace('_', ' ')) : ''
  const displayName = user?.fullName || user?.username || 'Usuario'
  const initials = useMemo(() => initialsOf(user?.fullName, user?.username), [user?.fullName, user?.username])

  // Foto de perfil (best-effort, no bloquea).
  useEffect(() => {
    if (!user) return
    const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
    if (!token) return
    fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const u = d?.employee?.photo_url || d?.user?.photo_url
        if (u) setPhoto(u.startsWith('http') ? u : apiUrl(u))
      })
      .catch(() => {})
  }, [user?.id])

  // Cerrar al hacer clic fuera.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Foco al primer item al abrir.
  useEffect(() => {
    if (open) {
      const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
      first?.focus()
    }
  }, [open])

  const go = useCallback((href: string) => {
    setOpen(false)
    router.push(href)
  }, [router])

  function handleLogout() {
    setOpen(false)
    try {
      const refresh = localStorage.getItem('refresh_token')
      if (refresh) {
        const token = localStorage.getItem('access_token')
        fetch(apiUrl('/api/auth/logout'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ refreshToken: refresh }),
        }).catch(() => {})
      }
    } finally {
      localStorage.clear()
      window.location.href = '/login'
    }
  }

  // Navegación por teclado dentro del menú.
  function onMenuKeyDown(e: React.KeyboardEvent) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btnRef.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus() }
  }

  if (!user) return null

  const Avatar = ({ size }: { size: number }) => (
    photo
      ? <img src={photo} alt="" width={size} height={size}
             className="rounded-full object-cover" style={{ width: size, height: size }} />
      : <span
          className="rounded-full flex items-center justify-center bg-blue-600 text-white font-semibold"
          style={{ width: size, height: size, fontSize: size * 0.4 }}
          aria-hidden="true">
          {initials}
        </span>
  )

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menú de cuenta"
        className="w-9 h-9 rounded-full flex items-center justify-center hover:ring-2 hover:ring-blue-400/50
          focus-visible:outline-2 focus-visible:outline focus-visible:outline-blue-500 transition"
      >
        <Avatar size={32} />
      </button>

      {open && (
        <PopoverSurface
          ref={menuRef}
          role="menu"
          aria-label="Cuenta del usuario"
          onKeyDown={onMenuKeyDown}
          className="w-64 right-0 mt-2 top-full"
        >
          {/* Cabecera con identidad */}
          <div className="flex items-center gap-3 p-4 border-b border-slate-100 dark:border-white/10">
            <Avatar size={40} />
            <div className="min-w-0">
              <p className="font-semibold text-slate-900 dark:text-white truncate">{displayName}</p>
              <p className="text-xs text-slate-500 dark:text-white/60 truncate">{roleLabel}</p>
              {user.email && <p className="text-xs text-slate-400 dark:text-white/50 truncate">{user.email}</p>}
            </div>
          </div>

          <div className="py-1">
            {ITEMS.map(({ href, label, icon: Icon }) => (
              <button
                key={href}
                role="menuitem"
                type="button"
                onClick={() => go(href)}
                className={popoverItemClass('py-2.5 px-4')}
              >
                <Icon size={16} className="text-slate-400 dark:text-white/60" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          <div className={`py-1 ${popoverDividerClass()}`}>
            <button
              role="menuitem"
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-300
                hover:bg-red-50 dark:hover:bg-red-500/15 focus-visible:bg-red-50 dark:focus-visible:bg-red-500/15
                focus:outline-none text-left"
            >
              <LogOut size={16} aria-hidden="true" />
              Cerrar sesión
            </button>
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}
