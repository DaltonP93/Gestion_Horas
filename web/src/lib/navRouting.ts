/**
 * navRouting — Resolución PURA de ruta → módulo (sin React ni iconos).
 *
 * Es el contrato de enrutamiento de la navegación por módulos. Se mantiene
 * separado de navModules.tsx (que agrega iconos/labels/permiso) para poder
 * probarlo en Node sin dependencias de UI.
 *
 * IMPORTANTE: los `paths` deben reflejar los href de los submódulos en
 * navModules.tsx. El id del grupo es el slug usado en /m/<slug>.
 */
export type RouteGroup = { id: string; paths: string[] }

export const NAV_ROUTES: RouteGroup[] = [
  { id: 'inicio',            paths: ['/dashboard', '/mi-perfil', '/mi-asistencia', '/marcar', '/mis-permisos'] },
  { id: 'gestion-personal',  paths: ['/empleados', '/asistencia', '/permisos', '/aprobaciones', '/horas-extra', '/marcaciones-fuera-rango', '/marcaciones-geocerca'] },
  { id: 'mi-equipo',         paths: ['/supervisor', '/turnera', '/calendario', '/banco-horas', '/reportes', '/reportes/planillas-legales'] },
  { id: 'talento',           paths: ['/capacitaciones', '/encuestas', '/evaluaciones'] },
  { id: 'ciclo-laboral',     paths: ['/ingresos', '/onboarding', '/vacaciones', '/lactancia', '/comunicados'] },
  { id: 'estrategica',       paths: ['/ejecutivo', '/nomina'] },
  { id: 'administracion',    paths: ['/departamentos', '/usuarios', '/auditoria', '/configuracion/reglas', '/configuracion', '/configuracion/sincronizacion', '/sistema', '/sistema/salud'] },
]

/**
 * Alias de slugs de módulo → slug canónico. Rutas antiguas o marcadores que
 * usaban un slug previo se resuelven al módulo actual (y el `/m/<alias>` se
 * redirige al canónico en la página del módulo). Ampliar aquí si un módulo
 * cambia de slug sin romper enlaces existentes.
 */
export const MODULE_ALIASES: Record<string, string> = {
  'talento-desarrollo': 'talento',
}

/** Devuelve el slug canónico de un módulo (o el mismo slug si no es alias). */
export function normalizeGroupSlug(slug: string): string {
  return MODULE_ALIASES[slug] ?? slug
}

/**
 * Devuelve el id del módulo al que pertenece la ruta actual, o null.
 *  - `/m/<slug>` (página principal del módulo) → ese módulo (aceptando alias).
 *  - Cualquier submódulo → su módulo, por coincidencia de prefijo más larga
 *    (para que /configuracion/sincronizacion gane sobre /configuracion).
 */
export function locateGroupIdByPath(pathname: string, routes: RouteGroup[] = NAV_ROUTES): string | null {
  const m = pathname.match(/^\/m\/([^/?#]+)/)
  if (m) { const slug = normalizeGroupSlug(m[1]); return routes.some(g => g.id === slug) ? slug : null }

  let best: { id: string; len: number } | null = null
  for (const g of routes) {
    for (const p of g.paths) {
      if (pathname === p || pathname.startsWith(p + '/')) {
        if (!best || p.length > best.len) best = { id: g.id, len: p.length }
      }
    }
  }
  return best?.id ?? null
}
