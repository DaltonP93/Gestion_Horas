/**
 * sistemaNav — tarjetas del módulo /sistema (datos puros, sin React/iconos).
 *
 * Sólo operaciones técnicas GENUINAS. Las funciones con ubicación CANÓNICA en
 * otro lado no se duplican aquí (una sola entrada visible por función):
 *   · Relojes ZKTeco    → /configuracion?tab=relojes
 *   · Salud del sistema → /sistema/salud (entrada en el sidebar)
 *   · Webhooks          → /configuracion/webhooks
 *   · Descubrimiento    → acción dentro de Relojes ZKTeco (no tarjeta suelta)
 *   · att2000           → integración legada /sistema/legado-att2000 (super_admin)
 */
export interface SistemaCard {
  href: string; iconKey: string; title: string; desc: string; color: string
  superOnly?: boolean
}

export const SISTEMA_CARDS: SistemaCard[] = [
  { href: '/sistema/procesar',              iconKey: 'Calculator', title: 'Procesar Horas',
    desc: 'Recalcular el resumen diario (daily_summary) para un rango de fechas.', color: 'bg-emerald-500' },
  { href: '/configuracion/reglas-permisos', iconKey: 'FileCog',    title: 'Reglas de Permisos',
    desc: 'Niveles requeridos por departamento y tipo de permiso.', color: 'bg-amber-500' },
  { href: '/sistema/backups',               iconKey: 'Archive',    title: 'Backups de BD',
    desc: 'Backups automáticos y manuales de MySQL. Listado, descarga, retención.', color: 'bg-rose-500' },
  { href: '/sistema/gdpr',                  iconKey: 'Shield',     title: 'Cumplimiento GDPR',
    desc: 'Exportar datos personales de un empleado o anonimizar.', color: 'bg-slate-700' },
  { href: '/sistema/embed',                 iconKey: 'Code2',      title: 'Embed (dashboards públicos)',
    desc: 'Tokens read-only para insertar widgets en portales externos.', color: 'bg-violet-500' },
  { href: '/sistema/legado-att2000',        iconKey: 'History',    title: 'Integración legada att2000',
    desc: 'Contingencia, migración y recuperación histórica. No es el flujo normal de marcaciones.',
    color: 'bg-purple-600', superOnly: true },
]

/** Tarjetas visibles según el rol (legado att2000 sólo super_admin). */
export function visibleSistemaCards(isSuper: boolean): SistemaCard[] {
  return SISTEMA_CARDS.filter(c => !c.superOnly || isSuper)
}
