import { maxPairsOf } from '../marcadasTable'

/** `emps` empleados, cada uno con `dias` filas de `pares` pares. */
function empleados(emps: number, dias: number, pares = 1) {
  return Array.from({ length: emps }, () => ({
    rows: Array.from({ length: dias }, () => ({ pairs: new Array(pares).fill({}) })),
  }))
}

describe('maxPairsOf', () => {
  test('devuelve el máximo de pares entre todos los empleados', () => {
    const data = [
      { rows: [{ pairs: [1, 2] }, { pairs: [1] }] },
      { rows: [{ pairs: [1, 2, 3] }] },
    ]
    expect(maxPairsOf(data)).toBe(3)
  })

  test('el mínimo es 1 para que la tabla tenga al menos una columna', () => {
    expect(maxPairsOf([])).toBe(1)
    expect(maxPairsOf(null)).toBe(1)
    expect(maxPairsOf(undefined)).toBe(1)
    expect(maxPairsOf([{ rows: [] }])).toBe(1)
  })

  test('tolera datos mal formados sin lanzar', () => {
    const data: any = [null, {}, { rows: null }, { rows: [null, { pairs: [1, 2] }] }]
    expect(maxPairsOf(data)).toBe(2)
  })

  test('★ la regresión: no desborda el stack con arrays grandes', () => {
    // El código viejo hacía Math.max(...employees.flatMap(e => e.rows)…).
    // El spread revienta cerca de los 125.000 argumentos; acá son 200.000,
    // un tamaño realista para un año sobre varios cientos de empleados.
    // La pantalla no se ponía lenta: lanzaba al renderizar, con el reporte
    // ya descargado.
    const data = empleados(400, 500, 2)

    expect(() => Math.max(...data.flatMap(e => e.rows).map(r => r.pairs.length)))
      .toThrow(RangeError)
    expect(maxPairsOf(data)).toBe(2)
  })

  test('coincide con el método viejo por debajo del umbral', () => {
    const data = [...empleados(5, 10, 1), { rows: [{ pairs: [1, 2, 3, 4] }] }]
    expect(maxPairsOf(data)).toBe(
      Math.max(...data.flatMap(e => e.rows).map(r => r.pairs.length), 1),
    )
  })
})
