import { formatPYG, formatThousandsPY, parseDecimalPYG, stripThousands } from '../currency'

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

describe('parseDecimalPYG', () => {
  test('DECIMAL del backend → entero canónico', () => {
    expect(parseDecimalPYG('3500000.00')).toBe('3500000')
    expect(parseDecimalPYG('2899048.00')).toBe('2899048')
    expect(parseDecimalPYG('0.00')).toBe('0')
  })
  test('number o string entero pasan sin cambios', () => {
    expect(parseDecimalPYG(3500000)).toBe('3500000')
    expect(parseDecimalPYG('3500000')).toBe('3500000')
  })
  test('vacío / null / undefined → ""', () => {
    expect(parseDecimalPYG(null)).toBe('')
    expect(parseDecimalPYG(undefined)).toBe('')
    expect(parseDecimalPYG('')).toBe('')
  })
  test('no numérico → "" (nunca un número corrupto)', () => {
    expect(parseDecimalPYG('abc')).toBe('')
    expect(parseDecimalPYG('3.500.000')).toBe('')
    expect(parseDecimalPYG(NaN)).toBe('')
    expect(parseDecimalPYG(Infinity)).toBe('')
  })
  test('es idempotente: aplicarlo N veces da lo mismo', () => {
    let v: string = parseDecimalPYG('3500000.00')
    for (let i = 0; i < 5; i++) v = parseDecimalPYG(v)
    expect(v).toBe('3500000')
  })
  test('nunca reintroduce el error de multiplicar por 100', () => {
    expect(Number(parseDecimalPYG('3500000.00'))).toBe(3500000)
    expect(Number(parseDecimalPYG('3500000.00'))).not.toBe(350000000)
  })
})
