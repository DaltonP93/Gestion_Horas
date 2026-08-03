/**
 * currency.ts — formateo de moneda paraguaya (PYG / Guaraníes).
 *
 * `formatPYG(1234567)` → "Gs. 1.234.567".
 * `formatThousandsPY(1234567)` → "1.234.567" (para inputs, sin prefijo).
 * `stripThousands("1.234.567")` → "1234567" (para enviar al backend).
 */

const NF_PY = new Intl.NumberFormat('es-PY', {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
})

export function formatPYG(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return ''
  return `Gs. ${NF_PY.format(Math.trunc(n))}`
}

export function formatThousandsPY(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return ''
  return NF_PY.format(Math.trunc(n))
}

// Convierte lo que el usuario TIPEA (con o sin separadores de miles) a un
// string de dígitos. Preserva el signo negativo si viene (el validador lo
// rechazará en la capa siguiente). Nunca lanza.
//
// Sólo apto para entrada del usuario: en es-PY el punto es separador de
// miles, así que "3.500.000" → "3500000". NUNCA aplicar sobre un DECIMAL
// del backend ("3500000.00"), donde el punto es separador decimal — para
// eso está `parseDecimalPYG`.
export function stripThousands(input: string): string {
  if (typeof input !== 'string') return ''
  const neg = input.trim().startsWith('-')
  const digits = input.replace(/[^\d]/g, '')
  return neg ? '-' + digits : digits
}

// Convierte un valor tal como llega de la API (MySQL DECIMAL serializado
// como "3500000.00", o un number) al entero canónico en string.
// Devuelve '' para null/undefined/'' o para cualquier cosa no numérica —
// preferimos vacío antes que un número corrupto.
export function parseDecimalPYG(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const s = typeof v === 'number' ? String(v) : String(v).trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return ''
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  return String(Math.trunc(n))
}
