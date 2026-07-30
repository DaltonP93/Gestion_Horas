import { formatPYG } from '../currency'

describe('formatPYG', () => {
  test('formatea números con separador de miles paraguayo (punto)', () => {
    expect(formatPYG(1234567)).toBe('Gs. 1.234.567')
    expect(formatPYG(0)).toBe('Gs. 0')
    expect(formatPYG(1000)).toBe('Gs. 1.000')
  })

  test('acepta strings numéricos', () => {
    expect(formatPYG('2500000')).toBe('Gs. 2.500.000')
  })

  test('trunca decimales — el guaraní no tiene subunidad práctica', () => {
    expect(formatPYG(1500.75)).toBe('Gs. 1.500')
  })

  test('null / undefined / vacío → cadena vacía', () => {
    expect(formatPYG(null)).toBe('')
    expect(formatPYG(undefined)).toBe('')
    expect(formatPYG('')).toBe('')
  })

  test('valores no finitos → cadena vacía (no rompe la UI)', () => {
    expect(formatPYG('abc')).toBe('')
    expect(formatPYG(Number.NaN)).toBe('')
  })
})
