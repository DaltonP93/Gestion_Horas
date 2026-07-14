'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Users, BarChart2, Settings, Clock, Calendar,
  LogOut, Shield, Server, Building2, CheckSquare, UserCircle2,
  Menu, X, FileText, TrendingUp, QrCode, DollarSign, ChevronDown, Activity,
  Cake, Plane, PiggyBank, Megaphone, GraduationCap, ClipboardList, Star, UserCheck, CalendarRange, AlertTriangle,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react'
import clsx from 'clsx'
import { useCurrentUser, hasRole, isSuperAdmin, type Role } from '@/lib/useCurrentUser'
import { useI18n } from '@/i18n/I18nProvider'
import { apiUrl } from '@/lib/api'

type NavItem = {
  href: string
  icon: LucideIcon
  i18nKey: string  // clave en el dictionary (nav.*)
  roles?: Role[]
  superOnly?: boolean
  section?: 'portal' | 'gestion' | 'admin'
  module?: string   // clave de user_permissions (si se define, la flag can_view manda)
}

const NAV: NavItem[] = [
  // Portal del empleado — solo roles de empleado; admin/gth/hr no lo ven
  { href: '/mi-perfil',     icon: UserCircle2,     i18nKey: 'nav.my_profile',    section: 'portal', roles: ['employee'], module: 'mi_perfil' },
  { href: '/mi-asistencia', icon: Clock,           i18nKey: 'nav.my_attendance', section: 'portal', roles: ['employee'], module: 'mi_asistencia' },
  { href: '/marcar',        icon: QrCode,          i18nKey: 'nav.punch_qr_gps',  section: 'portal', roles: ['employee'], module: 'marcar' },
  { href: '/mis-permisos',  icon: Calendar,        i18nKey: 'nav.my_permissions',section: 'portal', roles: ['employee'], module: 'mis_permisos' },
  { href: '/seguridad',     icon: Shield,          i18nKey: 'nav.security',      section: 'portal' },

  // Gestión
  { href: '/dashboard',     icon: LayoutDashboard, i18nKey: 'nav.dashboard',    section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'dashboard' },
  { href: '/empleados',     icon: Users,           i18nKey: 'nav.employees',    section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'empleados' },
  { href: '/asistencia',    icon: Clock,           i18nKey: 'nav.attendance',   section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'asistencia' },
  { href: '/permisos',      icon: Calendar,        i18nKey: 'nav.permissions',  section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'permisos' },
  { href: '/aprobaciones',  icon: CheckSquare,     i18nKey: 'nav.approvals',    section: 'gestion', roles: ['admin','gth','hr','coordinator','manager'], module: 'aprobaciones' },
  { href: '/horas-extra',   icon: Clock,           i18nKey: 'nav.overtime',     section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'aprobaciones' },
  { href: '/marcaciones-fuera-rango', icon: AlertTriangle, i18nKey: 'nav.out_of_range', section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'asistencia' },
  { href: '/supervisor',    icon: Users,           i18nKey: 'nav.my_team',      section: 'gestion', roles: ['coordinator','manager','supervisor','gestor'], module: 'supervisor' },
  { href: '/turnera',       icon: CalendarRange,   i18nKey: 'nav.shifts',       section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'turnera' },
  { href: '/reportes',      icon: BarChart2,       i18nKey: 'nav.reports',      section: 'gestion', roles: ['admin','gth','hr','manager','gestor'], module: 'reportes' },
  { href: '/reportes/planillas-legales', icon: FileText, i18nKey: 'nav.legal_sheets', section: 'gestion', roles: ['admin','gth','hr'], module: 'reportes' },
  { href: '/ejecutivo',     icon: TrendingUp,      i18nKey: 'nav.executive',    section: 'gestion', roles: ['admin','gth','hr','manager'], module: 'ejecutivo' },
  { href: '/nomina',        icon: DollarSign,      i18nKey: 'nav.payroll',      section: 'gestion', roles: ['admin','gth','hr'], module: 'nomina' },
  { href: '/calendario',    icon: Cake,            i18nKey: 'nav.calendar',     section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'calendario' },
  { href: '/vacaciones',    icon: Plane,           i18nKey: 'nav.vacations',    section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'vacaciones' },
  { href: '/banco-horas',   icon: PiggyBank,       i18nKey: 'nav.overtime_bank',section: 'gestion', roles: ['admin','gth','hr','manager','gestor','supervisor'], module: 'banco_horas' },
  { href: '/comunicados',   icon: Megaphone,       i18nKey: 'nav.announcements',section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'comunicados' },
  { href: '/capacitaciones',icon: GraduationCap,   i18nKey: 'nav.training',     section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'capacitaciones' },
  { href: '/encuestas',     icon: ClipboardList,   i18nKey: 'nav.surveys',      section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'encuestas' },
  { href: '/evaluaciones',  icon: Star,            i18nKey: 'nav.appraisals',   section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'evaluaciones' },
  { href: '/onboarding',    icon: UserCheck,       i18nKey: 'nav.onboarding',   section: 'gestion', roles: ['admin','gth','hr','coordinator','manager','gestor'], module: 'onboarding' },

  // Admin
  { href: '/departamentos', icon: Building2,       i18nKey: 'nav.departments',  section: 'admin', roles: ['admin','gth'], module: 'departamentos' },
  { href: '/usuarios',      icon: Shield,          i18nKey: 'nav.users',        section: 'admin', roles: ['admin','gth'], module: 'usuarios' },
  { href: '/auditoria',     icon: FileText,        i18nKey: 'nav.audit',        section: 'admin', roles: ['admin','gth'], module: 'auditoria' },
  { href: '/configuracion/reglas', icon: SlidersHorizontal, i18nKey: 'nav.rules', section: 'admin', roles: ['admin','gth'], module: 'reglas' },
  { href: '/configuracion', icon: Settings,        i18nKey: 'nav.settings',     section: 'admin', roles: ['admin','gth'], module: 'configuracion' },
  { href: '/sistema',       icon: Server,          i18nKey: 'nav.system',       section: 'admin', superOnly: true, module: 'sistema' },
  { href: '/sistema/salud', icon: Activity,        i18nKey: 'nav.system_health',section: 'admin', roles: ['admin','gth'], module: 'sistema' },
]

interface SidebarSettings {
  system_sidebar_bg?: string
  system_sidebar_text?: string
  system_sidebar_active?: string
  system_name?: string
}

type EffectivePerms = Record<string, { can_view: boolean; can_create: boolean; can_update: boolean; can_delete: boolean }>

export default function Sidebar() {
  const pathname = usePathname()
  const user = useCurrentUser()
  const { t } = useI18n()
  const SECTION_LABEL: Record<string, string> = {
    portal:  t('nav.section_portal'),
    gestion: t('nav.section_management'),
    admin:   t('nav.section_admin'),
  }
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<SidebarSettings>({})
  const [perms, setPerms] = useState<EffectivePerms | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('sidebar_collapsed') || '{}') } catch { return {} }
  })
  function toggleSection(sec: string) {
    setCollapsed(prev => {
      const next = { ...prev, [sec]: !prev[sec] }
      try { localStorage.setItem('sidebar_collapsed', JSON.stringify(next)) } catch {}
      return next
    })
  }

  // Carga settings de tema (sin bloquear render)
  useEffect(() => {
    fetch(apiUrl('/api/settings'))
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setTheme(d) })
      .catch(() => {})
  }, [])

  // Carga permisos granulares del usuario logueado
  useEffect(() => {
    if (!user) return
    const token = typeof window !== 'undefined'
      ? (localStorage.getItem('access_token') || localStorage.getItem('token'))
      : null
    if (!token) return
    fetch(apiUrl('/api/me/module-permissions'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.effective) setPerms(d.effective) })
      .catch(() => {})
  }, [user?.id])

  // Cerrar drawer al navegar (mobile)
  useEffect(() => { setOpen(false) }, [pathname])

  const isAdminLike = user?.role === 'admin' || user?.role === 'super_admin'
  const items = NAV.filter(item => {
    if (item.superOnly) return isSuperAdmin(user)
    // admin/super_admin siempre ven todo (salvo portal del empleado, que no es su espacio)
    if (isAdminLike) return item.section !== 'portal' || item.href === '/seguridad'
    // Si hay permisos granulares, mandan sobre el rol
    if (perms && item.module && perms[item.module]) return perms[item.module].can_view
    if (!item.roles) return true
    return hasRole(user, ...item.roles)
  })

  // Agrupar por sección preservando orden
  const sections: Record<string, NavItem[]> = {}
  for (const it of items) {
    const sec = it.section || 'gestion'
    if (!sections[sec]) sections[sec] = []
    sections[sec].push(it)
  }

  function handleLogout() {
    const refresh = localStorage.getItem('refresh_token')
    if (refresh) fetch('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: refresh }) })
    localStorage.clear()
    window.location.href = '/login'
  }

  const bg         = theme.system_sidebar_bg     || '#0f172a'
  const textColor  = theme.system_sidebar_text   || '#94a3b8'
  const activeBg   = theme.system_sidebar_active || '#2563eb'

  const Content = (
    <>
      {/* Logo / branding */}
      <div className="px-6 py-5 border-b border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                 style={{ backgroundColor: activeBg }}>
              <Clock size={18} className="text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-white font-bold text-sm truncate">{theme.system_name || 'Asistencia'}</p>
              <p className="text-xs truncate" style={{ color: textColor }}>
                {user?.role === 'super_admin' ? 'Super Admin'
                 : user?.role === 'employee' ? 'Empleado'
                 : 'Recursos Humanos'}
              </p>
            </div>
          </div>
          <button
            aria-label="Cerrar menú"
            className="md:hidden text-white/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white rounded-lg p-1"
            onClick={() => setOpen(false)}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Nav con secciones */}
      <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
        {(['portal','gestion','admin'] as const).map(sec => {
          const list = sections[sec]
          if (!list?.length) return null
          const sectionActive = list.some(it => pathname === it.href || pathname.startsWith(it.href + '/'))
          const isCollapsed = collapsed[sec] ?? false
          return (
            <div key={sec} className="space-y-1">
              <button
                type="button"
                onClick={() => toggleSection(sec)}
                aria-expanded={!isCollapsed}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                style={{ color: textColor }}
              >
                <span className="text-[10px] uppercase tracking-widest font-semibold opacity-60">
                  {SECTION_LABEL[sec]}
                </span>
                <ChevronDown size={14} className={clsx('transition-transform', isCollapsed && '-rotate-90')} />
              </button>
              {!isCollapsed && list.map(({ href, icon: Icon, i18nKey }) => {
                const active = pathname === href || pathname.startsWith(href + '/')
                return (
                  <Link key={href} href={href}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all',
                      'hover:text-white focus-visible:outline-2 focus-visible:outline focus-visible:outline-white focus-visible:outline-offset-2'
                    )}
                    style={active
                      ? { backgroundColor: activeBg, color: '#fff' }
                      : { color: textColor }}
                  >
                    <Icon size={18} aria-hidden="true" />
                    {t(i18nKey)}
                  </Link>
                )
              })}
              {isCollapsed && sectionActive && (
                <div className="h-0.5 mx-3 rounded" style={{ backgroundColor: activeBg, opacity: 0.5 }} />
              )}
            </div>
          )
        })}
      </nav>

      {/* User + Logout */}
      <div className="px-3 py-4 border-t border-white/10 space-y-2">
        {user && (
          <div className="px-3 py-2 text-xs" style={{ color: textColor }}>
            <p className="text-white font-medium truncate">{user.fullName || user.username}</p>
            <p className="truncate capitalize">{user.role.replace('_', ' ')}</p>
          </div>
        )}
        <button onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium transition-colors hover:bg-white/5 hover:text-white"
          style={{ color: textColor }}
        >
          <LogOut size={18} />
          {t('nav.logout')}
        </button>
      </div>
    </>
  )

  // Para empleados en móvil: solo se usa MobileBottomNav.
  // El sidebar entero se oculta (sin hamburger ni drawer).
  // En desktop (md+) sí se muestra.
  const isEmployee = user?.role === 'employee'

  return (
    <>
      {/* Hamburger (mobile only) — oculto para empleados (usan bottom nav) */}
      {!isEmployee && (
        <button
          aria-label="Abrir menú"
          onClick={() => setOpen(true)}
          className="md:hidden fixed top-3 left-3 z-40 p-2 rounded-xl bg-slate-900 text-white shadow-lg"
        >
          <Menu size={20} />
        </button>
      )}

      {/* Overlay mobile */}
      {open && !isEmployee && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Cerrar menú"
          onClick={() => setOpen(false)}
          onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') setOpen(false) }}
          className="md:hidden fixed inset-0 bg-black/60 z-40"
        />
      )}

      {/* Drawer / sidebar
          - Empleados: oculto en móvil (hidden md:flex), visible en desktop.
          - Otros roles: oculto fuera de pantalla con translate y aparece al abrir hamburger. */}
      <aside
        className={clsx(
          'w-64 min-h-screen flex-col z-50',
          'fixed md:sticky top-0 left-0 transition-transform duration-200',
          isEmployee
            ? 'hidden md:flex'
            : clsx('flex', open ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        )}
        style={{ backgroundColor: bg, maxHeight: '100vh' }}
      >
        {Content}
      </aside>
    </>
  )
}
