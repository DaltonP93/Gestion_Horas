import { toCsv } from '../csvExport'

describe('toCsv', () => {
  test('encabezado + filas separadas por CRLF', () => {
    const csv = toCsv(['a', 'b'], [[1, 2], [3, 4]])
    expect(csv).toBe('a,b\r\n1,2\r\n3,4')
  })

  test('escapa comas, comillas y saltos de línea (RFC 4180)', () => {
    const csv = toCsv(['x'], [['con, coma'], ['con "comillas"'], ['con\nsalto']])
    expect(csv).toBe('x\r\n"con, coma"\r\n"con ""comillas"""\r\n"con\nsalto"')
  })

  test('null/undefined → celda vacía', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,')
  })

  test('sin filas → sólo encabezado', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b')
  })
})
