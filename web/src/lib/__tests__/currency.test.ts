import { formatPYG, formatThousandsPY, stripThousands } from '../currency'

describe('formatPYG', () => {
  test('formatea con "Gs." + separador de miles paraguayo', () => {
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
  test('valores no finitos → cadena vacía', () => {
    expect(formatPYG('abc')).toBe('')
    expect(formatPYG(Number.NaN)).toBe('')
  })
})

describe('formatThousandsPY', () => {
  test('sin prefijo, sólo separadores', () => {
    expect(formatThousandsPY(2899048)).toBe('2.899.048')
    expect(formatThousandsPY(0)).toBe('0')
  })
  test('vacío → cadena vacía', () => {
    expect(formatThousandsPY('')).toBe('')
    expect(formatThousandsPY(null)).toBe('')
  })
})

describe('stripThousands', () => {
  test('remueve puntos, comas, espacios y otros caracteres', () => {
    expect(stripThousands('1.234.567')).toBe('1234567')
    expect(stripThousands('2 899 048')).toBe('2899048')
    expect(stripThousands('Gs. 15.000.000')).toBe('15000000')
  })
  test('preserva el signo negativo', () => {
    expect(stripThousands('-1000')).toBe('-1000')
    expect(stripThousands('-1.000')).toBe('-1000')
  })
  test('devuelve "" para no-string', () => {
    expect(stripThousands(null as unknown as string)).toBe('')
  })
})
