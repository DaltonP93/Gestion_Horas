/**
 * csvExport — helper compartido para exportar tablas a CSV del lado del cliente.
 *
 * `toCsv` es puro (testeable): arma el texto CSV con comillas RFC-4180
 * (escapa comas, comillas y saltos de línea) y filas separadas por CRLF.
 * `downloadCsv` agrega el BOM UTF-8 (para que Excel abra bien los acentos) y
 * dispara la descarga en el navegador.
 */

export type CsvCell = string | number | null | undefined

function escapeCell(v: CsvCell): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Arma el texto CSV (sin BOM). Puro: sin efectos de navegador. */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(escapeCell).join(',')]
  for (const row of rows) lines.push(row.map(escapeCell).join(','))
  return lines.join('\r\n')
}

/** Dispara la descarga de un CSV con BOM UTF-8. No-op fuera del navegador. */
export function downloadCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  if (typeof document === 'undefined') return
  const csv = toCsv(headers, rows)
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
