/**
 * currency.ts — formateo de moneda paraguaya (PYG / Guaraníes).
 *
 * `formatPYG(1234567)` → "Gs. 1.234.567".
 * Se separa del validador para que la UI pueda mostrar el valor legible
 * sin cambiar el shape numérico que va al backend.
 */

export function formatPYG(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return ''
  // es-PY produce "₲ 1.234.567" con moneda; para consistencia con planillas
  // usamos formato numérico + prefijo textual.
  const numeric = new Intl.NumberFormat('es-PY', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.trunc(n))
  return `Gs. ${numeric}`
}
