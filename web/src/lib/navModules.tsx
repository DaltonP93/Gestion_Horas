'use client'
/**
 * navModules — Estructura de navegación por módulos (solo UX/frontend).
 *
 * Agrupa los submódulos existentes en módulos temáticos. NO cambia rutas,
 * permisos ni lógica: cada submódulo conserva su href, roles y clave de
 * permiso (`module`) actuales. El sidebar y las páginas principales de cada
 * módulo (tarjetas) consumen esta misma fuente.
 */
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Users, Clock, Calendar, CheckSquare, AlertTriangle, MapPinOff,
  CalendarRange, BarChart2, FileText, TrendingUp, DollarSign, Cake, Plane, PiggyBank,
  Megaphone, GraduationCap, ClipboardList, Star, FileSignature, Baby, UserCheck,
  Building2, Shield, SlidersHorizontal, Settings, RefreshCw, Server, Activity,
  UserCircle2, QrCode, Home, UsersRound, UserCog, Sparkles, HeartHandshake, Target, Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useCurrentUser, hasRole, isSuperAdmin, type Role } from '@/lib/useCurrentUser'
import { apiUrl } from '@/lib/api'
import { locateGroupIdByPath } from '@/lib/navRouting'

export type NavItem = {
  href: string
  icon: LucideIcon
  i18nKey: string           // etiqueta (dictionary nav.*)
  desc: string              // descripción en lenguaje de usuario (para tarjetas)
  roles?: Role[]
  superOnly?: boolean
  module?: string           // clave de user_permissions (can_view manda si existe)
  portal?: boolean          // ítem del portal del empleado (admin/gth/hr no lo ven)
  color?: string            // color de la tarjeta
}

export type NavGroup = {
  id: string
  label: string
  icon: LucideIcon
  desc: string
  items: NavItem[]
}

// ── Definición de los módulos y sus submódulos ─────────────────────
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'inicio', label: 'Inicio', icon: Home, desc: 'Tu punto de partida.',
    items: [
      { href: '/dashboard',     icon: LayoutDashboard, i18nKey: 'nav.dashboard',    desc: 'Indicadores del día en tiempo real.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'dashboard', color: 'bg-blue-500' },
      { href: '/mi-perfil',     icon: UserCircle2,     i18nKey: 'nav.my_profile',    desc: 'Tus datos y tu cuenta.', portal: true, roles: ['employee'], module: 'mi_perfil', color: 'bg-blue-500' },
      { href: '/mi-asistencia', icon: Clock,           i18nKey: 'nav.my_attendance', desc: 'Tus entradas, salidas y resumen.', portal: true, roles: ['employee'], module: 'mi_asistencia', color: 'bg-emerald-500' },
      { href: '/marcar',        icon: QrCode,          i18nKey: 'nav.punch_qr_gps',  desc: 'Marcar entrada/salida desde el móvil.', portal: true, roles: ['employee'], module: 'marcar', color: 'bg-violet-500' },
      { href: '/mis-permisos',  icon: Calendar,        i18nKey: 'nav.my_permissions',desc: 'Solicitar y ver tus permisos.', portal: true, roles: ['employee'], module: 'mis_permisos', color: 'bg-amber-500' },
    ],
  },
  {
    id: 'gestion-personal', label: 'Gestión de personal', icon: UsersRound, desc: 'Empleados, asistencia, permisos e incidencias.',
    items: [
      { href: '/empleados',   icon: Users,        i18nKey: 'nav.employees',   desc: 'Alta, edición y baja de empleados.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'empleados', color: 'bg-cyan-500' },
      { href: '/asistencia',  icon: Clock,        i18nKey: 'nav.attendance',  desc: 'Marcaciones del día con detalle.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'asistencia', color: 'bg-emerald-500' },
      { href: '/permisos',    icon: Calendar,     i18nKey: 'nav.permissions', desc: 'Gestión de permisos y ausencias.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'permisos', color: 'bg-amber-500' },
      { href: '/aprobaciones',icon: CheckSquare,  i18nKey: 'nav.approvals',   desc: 'Aprobar o rechazar solicitudes.', roles: ['admin','gth','hr','coordinator','manager'], module: 'aprobaciones', color: 'bg-green-600' },
      { href: '/horas-extra', icon: Clock,        i18nKey: 'nav.overtime',    desc: 'Revisar y autorizar horas extra.', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'aprobaciones', color: 'bg-orange-500' },
      { href: '/marcaciones-fuera-rango', icon: AlertTriangle, i18nKey: 'nav.out_of_range',   desc: 'Entradas muy tempranas o salidas muy tardías.', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'asistencia', color: 'bg-rose-500' },
      { href: '/marcaciones-geocerca',   icon: MapPinOff,      i18nKey: 'nav.out_of_geofence', desc: 'Marcajes fuera del perímetro de la sede.', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'asistencia', color: 'bg-red-500' },
    ],
  },
  {
    id: 'mi-equipo', label: 'Mi equipo', icon: UserCog, desc: 'Turnos, calendario, banco de horas y reportes.',
    items: [
      { href: '/supervisor',  icon: Users,        i18nKey: 'nav.my_team',     desc: 'Tu equipo a cargo.', roles: ['coordinator','manager','supervisor','gestor'], module: 'supervisor', color: 'bg-cyan-500' },
      { href: '/turnera',     icon: CalendarRange,i18nKey: 'nav.shifts',      desc: 'Planificación de turnos por semana.', roles: ['admin','gth','hr','coordinator','manager','supervisor'], module: 'turnera', color: 'bg-indigo-500' },
      { href: '/calendario',  icon: Cake,         i18nKey: 'nav.calendar',    desc: 'Cumpleaños, feriados y eventos.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'calendario', color: 'bg-pink-500' },
      { href: '/banco-horas', icon: PiggyBank,    i18nKey: 'nav.overtime_bank',desc: 'Saldo de horas a favor y en contra.', roles: ['admin','gth','hr','manager','gestor','supervisor'], module: 'banco_horas', color: 'bg-amber-600' },
      { href: '/reportes',    icon: BarChart2,    i18nKey: 'nav.reports',     desc: 'Reportes de asistencia y marcadas.', roles: ['admin','gth','hr','manager','gestor'], module: 'reportes', color: 'bg-blue-600' },
      { href: '/reportes/planillas-legales', icon: FileText, i18nKey: 'nav.legal_sheets', desc: 'Planillas MTESS / IPS y liquidaciones.', roles: ['admin','gth','hr'], module: 'reportes', color: 'bg-slate-600' },
    ],
  },
  {
    id: 'talento-desarrollo', label: 'Talento y desarrollo', icon: Sparkles, desc: 'Capacitaciones, encuestas y evaluaciones.',
    items: [
      { href: '/capacitaciones', icon: GraduationCap, i18nKey: 'nav.training',    desc: 'Cursos y formación del personal.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'capacitaciones', color: 'bg-violet-500' },
      { href: '/encuestas',      icon: ClipboardList, i18nKey: 'nav.surveys',     desc: 'Encuestas internas y clima laboral.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'encuestas', color: 'bg-teal-500' },
      { href: '/evaluaciones',   icon: Star,          i18nKey: 'nav.appraisals',  desc: 'Evaluaciones de desempeño.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'evaluaciones', color: 'bg-amber-500' },
    ],
  },
  {
    id: 'ciclo-laboral', label: 'Ciclo laboral y bienestar', icon: HeartHandshake, desc: 'Ingresos, egresos, vacaciones y comunicados.',
    items: [
      { href: '/ingresos',    icon: FileSignature, i18nKey: 'nav.ingresos',      desc: 'Contratos, período de prueba y bajas.', roles: ['admin','gth','hr','coordinator','manager','gestor'], module: 'ingresos', color: 'bg-emerald-600' },
      { href: '/onboarding',  icon: UserCheck,     i18nKey: 'nav.onboarding',    desc: 'Checklists de ingreso y egreso.', roles: ['admin','gth','hr','coordinator','manager','gestor'], module: 'onboarding', color: 'bg-green-500' },
      { href: '/vacaciones',  icon: Plane,         i18nKey: 'nav.vacations',     desc: 'Plan de vacaciones y saldos.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor'], module: 'vacaciones', color: 'bg-sky-500' },
      { href: '/lactancia',   icon: Baby,          i18nKey: 'nav.lactancia',     desc: 'Maternidad y reducción horaria.', roles: ['admin','gth','hr','coordinator','manager','gestor'], module: 'lactancia', color: 'bg-pink-500' },
      { href: '/comunicados', icon: Megaphone,     i18nKey: 'nav.announcements', desc: 'Anuncios y comunicados internos.', roles: ['admin','gth','hr','coordinator','manager','gestor','supervisor','employee'], module: 'comunicados', color: 'bg-rose-500' },
    ],
  },
  {
    id: 'estrategica', label: 'Gestión estratégica', icon: Target, desc: 'Tablero ejecutivo y nómina.',
    items: [
      { href: '/ejecutivo', icon: TrendingUp, i18nKey: 'nav.executive', desc: 'Indicadores ejecutivos y tendencias.', roles: ['admin','gth','hr','manager'], module: 'ejecutivo', color: 'bg-indigo-600' },
      { href: '/nomina',    icon: DollarSign, i18nKey: 'nav.payroll',   desc: 'Liquidación de haberes (SAA).', roles: ['admin','gth','hr'], module: 'nomina', color: 'bg-green-600' },
    ],
  },
  {
    id: 'administracion', label: 'Administración', icon: Wrench, desc: 'Configuración, usuarios, auditoría y sistema.',
    items: [
      { href: '/departamentos', icon: Building2,        i18nKey: 'nav.departments', desc: 'Áreas y departamentos.', roles: ['admin','gth'], module: 'departamentos', color: 'bg-slate-600' },
      { href: '/usuarios',      icon: Shield,           i18nKey: 'nav.users',       desc: 'Usuarios del sistema y roles.', roles: ['admin','gth'], module: 'usuarios', color: 'bg-blue-600' },
      { href: '/auditoria',     icon: FileText,         i18nKey: 'nav.audit',       desc: 'Registro de acciones (audit log).', roles: ['admin','gth'], module: 'auditoria', color: 'bg-amber-600' },
      { href: '/configuracion/reglas', icon: SlidersHorizontal, i18nKey: 'nav.rules', desc: 'Motor de reglas parametrizable.', roles: ['admin','gth'], module: 'reglas', color: 'bg-violet-600' },
      { href: '/configuracion', icon: Settings,         i18nKey: 'nav.settings',    desc: 'Relojes, apariencia e integraciones.', roles: ['admin','gth'], module: 'configuracion', color: 'bg-slate-700' },
      { href: '/configuracion/sincronizacion', icon: RefreshCw, i18nKey: 'nav.sync', desc: 'Lectura de relojes y marcaciones.', roles: ['admin'], module: 'sistema', color: 'bg-cyan-600' },
      { href: '/sistema',       icon: Server,           i18nKey: 'nav.system',      desc: 'Operaciones técnicas del sistema.', superOnly: true, module: 'sistema', color: 'bg-slate-900' },
      { href: '/sistema/salud', icon: Activity,         i18nKey: 'nav.system_health',desc: 'Salud de MySQL, Redis, Bridge, att2000.', roles: ['admin','gth'], module: 'sistema', color: 'bg-emerald-600' },
    ],
  },
]

export type EffectivePerms = Record<string, { can_view: boolean; can_create: boolean; can_update: boolean; can_delete: boolean }>

// Hook: permisos efectivos + predicado de visibilidad (misma lógica que el
// sidebar anterior, sin cambiar reglas de permiso).
export function useNavPermissions() {
  const user = useCurrentUser()
  const [perms, setPerms] = useState<EffectivePerms | null>(null)

  useEffect(() => {
    if (!user) return
    const token = typeof window !== 'undefined'
      ? (localStorage.getItem('access_token') || localStorage.getItem('token')) : null
    if (!token) return
    fetch(apiUrl('/api/me/module-permissions'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.effective) setPerms(d.effective) })
      .catch(() => {})
  }, [user?.id])

  const isAdminLike = user?.role === 'admin' || user?.role === 'super_admin'

  function canSee(item: NavItem): boolean {
    if (item.superOnly) return isSuperAdmin(user)
    if (isAdminLike) return !item.portal            // admin ve todo salvo el portal del empleado
    if (perms && item.module && perms[item.module]) return perms[item.module].can_view
    if (!item.roles) return true
    return hasRole(user, ...item.roles)
  }

  return { user, perms, canSee }
}

// Grupos visibles (con sus ítems ya filtrados). Oculta grupos sin ítems.
export function visibleGroups(canSee: (i: NavItem) => boolean): (NavGroup & { visibleItems: NavItem[] })[] {
  return NAV_GROUPS
    .map(g => ({ ...g, visibleItems: g.items.filter(canSee) }))
    .filter(g => g.visibleItems.length > 0)
}

export function groupById(id: string) { return NAV_GROUPS.find(g => g.id === id) || null }

// Encuentra el grupo (y el ítem, si aplica) de una ruta — para breadcrumbs y
// auto-expand del sidebar. Reutiliza el enrutamiento puro (incluye /m/<slug>).
// item es null en la página principal del módulo (/m/<slug>).
export function locateByPath(pathname: string): { group: NavGroup; item: NavItem | null } | null {
  const gid = locateGroupIdByPath(pathname)
  if (!gid) return null
  const group = NAV_GROUPS.find(g => g.id === gid)
  if (!group) return null
  let item: NavItem | null = null, len = -1
  for (const it of group.items) {
    const base = it.href.split('?')[0]
    if (pathname === base || pathname.startsWith(base + '/')) {
      if (base.length > len) { item = it; len = base.length }
    }
  }
  return { group, item }
}
