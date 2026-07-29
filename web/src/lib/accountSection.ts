/**
 * accountSection.ts — sección activa dentro de /cuenta/seguridad.
 *
 * PR 2. Antes usábamos fragmentos como `/cuenta/seguridad#password`,
 * pero al navegar entre pantallas ese hash podía duplicarse (URLs vistas
 * como `#password#password`). El origen: fragmentos no se normalizan en
 * navegación programática y varias entradas del menú apuntaban con hash.
 *
 * Ahora la sección viaja como query param (`?section=password`) y esta
 * función tolera ambas fuentes:
 *   1. `?section=…`
 *   2. `#password` legado (compatibilidad de bookmarks) — con
 *      normalización (elimina `#` múltiples, se queda con la primera
 *      sección conocida).
 *
 * La función es pura para permitir tests sin DOM.
 */

export type SecuritySection = 'password' | 'sessions' | '2fa'
const KNOWN: SecuritySection[] = ['password', 'sessions', '2fa']

export const DEFAULT_SECURITY_SECTION: SecuritySection = 'password'

/** Extrae la sección activa desde una URL completa o parcial. */
export function parseSecuritySection(input: string | undefined | null): SecuritySection {
  if (!input) return DEFAULT_SECURITY_SECTION
  const s = String(input)

  // 1) Query string
  const qIdx = s.indexOf('?')
  if (qIdx >= 0) {
    const hIdx = s.indexOf('#')
    const qEnd = hIdx >= 0 ? hIdx : s.length
    const qs = s.slice(qIdx + 1, qEnd)
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=')
      if (k === 'section') {
        const found = normalize(decodeURIComponent(v || ''))
        if (found) return found
      }
    }
  }

  // 2) Hash legado — con protección contra duplicados. Se parte por `#`
  //    y se acepta la primera sección conocida.
  const hIdx = s.indexOf('#')
  if (hIdx >= 0) {
    const raw = s.slice(hIdx + 1)
    for (const chunk of raw.split('#')) {
      const found = normalize(chunk)
      if (found) return found
    }
  }

  return DEFAULT_SECURITY_SECTION
}

/** URL canónica para saltar a una sección desde otras pantallas. */
export function securitySectionHref(section: SecuritySection): string {
  return `/cuenta/seguridad?section=${section}`
}

/** Colapsa `#password#password` (o cualquier repetido) en un solo hash. */
export function collapseDuplicateHashes(href: string): string {
  const idx = href.indexOf('#')
  if (idx < 0) return href
  const base = href.slice(0, idx)
  const raw = href.slice(idx + 1)
  // Quedarse con la primera sección conocida; si no hay, dejar el primer
  // chunk no vacío para no perder anclas ajenas.
  for (const chunk of raw.split('#')) {
    const found = normalize(chunk)
    if (found) return `${base}#${found}`
  }
  const first = raw.split('#').find(Boolean)
  return first ? `${base}#${first}` : base
}

function normalize(v: string): SecuritySection | null {
  const s = (v || '').trim().toLowerCase()
  if (!s) return null
  return (KNOWN as string[]).includes(s) ? (s as SecuritySection) : null
}
