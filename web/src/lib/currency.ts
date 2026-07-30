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

// Convierte lo que el usuario tipea (con o sin separadores) a un string de
// dígitos apto para el backend. Preserva el signo negativo si viene (el
// validador lo rechazará en la capa siguiente). Nunca lanza.
export function stripThousands(input: string): string {
  if (typeof input !== 'string') return ''
  const neg = input.trim().startsWith('-')
  const digits = input.replace(/[^\d]/g, '')
  return neg ? '-' + digits : digits
}
