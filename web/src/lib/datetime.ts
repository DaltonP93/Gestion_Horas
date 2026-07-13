/**
 * datetime.ts — Formateo de fechas/horas SIEMPRE en hora de Paraguay.
 *
 * La API devuelve los timestamps en ISO UTC (…Z). Si el frontend usa
 * `new Date(x)` y formatea con la zona del navegador, un usuario fuera de
 * Paraguay (o un render SSR en UTC) ve la hora corrida. Estos helpers fuerzan
 * `timeZone: 'America/Asuncion'`, así la marcación se muestra igual que en el
 * reloj sin importar dónde se abra la app.
 */
const TZ = 'America/Asuncion'

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d }
  let s = String(v).trim().replace(' ', 'T')
  // Si NO trae zona (ni "Z" ni "±hh:mm" al final), es hora local de Paraguay →
  // se fija el offset -03:00 para que no la reinterprete la zona del navegador.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += '-03:00'
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** Hora "HH:mm" en Paraguay (o el fallback si es nulo/ inválido). */
export function fmtTimePy(v: string | number | Date | null | undefined, fallback = '—'): string {
  const d = toDate(v)
  if (!d) return fallback
  return new Intl.DateTimeFormat('es-PY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

/** Hora "HH:mm:ss" en Paraguay. */
export function fmtTimeSecPy(v: string | number | Date | null | undefined, fallback = '—'): string {
  const d = toDate(v)
  if (!d) return fallback
  return new Intl.DateTimeFormat('es-PY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d)
}

/** Fecha "dd/mm/aaaa" en Paraguay. */
export function fmtDatePy(v: string | number | Date | null | undefined, fallback = '—'): string {
  const d = toDate(v)
  if (!d) return fallback
  return new Intl.DateTimeFormat('es-PY', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
}

/** Fecha y hora "dd/mm/aaaa HH:mm" en Paraguay. */
export function fmtDateTimePy(v: string | number | Date | null | undefined, fallback = '—'): string {
  const d = toDate(v)
  if (!d) return fallback
  return new Intl.DateTimeFormat('es-PY', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)
}
