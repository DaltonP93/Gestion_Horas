/**
 * Formato de las métricas de red en el historial de sincronización.
 *
 * El historial ahora muestra volumen y porcentaje descartado. Son números que
 * sostienen una decisión de arquitectura, así que no pueden mentir: un dato
 * ausente tiene que verse como ausente y no como cero.
 *
 * Las funciones viven en SyncWizard; acá se replica su contrato para poder
 * ejercitarlo sin montar el árbol de configuración entero.
 */

function fmtBytes(b: number | null | undefined): string {
  const n = Number(b)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtPct(v: number | null | undefined): string {
  // null/undefined son "no medido". Number(null) es 0, y "0.0%" se leería
  // como "no se descartó nada", que es lo contrario de no saberlo.
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

describe('fmtBytes', () => {
  it('escala a KB y MB', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(1024 * 1024 * 3)).toBe('3.0 MB')
  })

  it('un dato ausente no se muestra como cero', () => {
    // Sin la migración 070 la columna llega nula: "0 B" haría creer que se
    // midió y no se transmitió nada.
    expect(fmtBytes(null)).toBe('—')
    expect(fmtBytes(undefined)).toBe('—')
    expect(fmtBytes(0)).toBe('—')
  })

  it('un valor no numérico no produce NaN en pantalla', () => {
    expect(fmtBytes('x' as unknown as number)).toBe('—')
  })
})

describe('fmtPct', () => {
  it('convierte la proporción a porcentaje con un decimal', () => {
    expect(fmtPct(0.9988)).toBe('99.9%')
    expect(fmtPct(0)).toBe('0.0%')
    expect(fmtPct(1)).toBe('100.0%')
  })

  it('sin dato muestra guion, no 0%', () => {
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(undefined)).toBe('—')
  })
})
