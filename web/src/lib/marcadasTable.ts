/**
 * marcadasTable.ts — Cálculos de la tabla de Marcadas.
 */

interface RowConPares {
  pairs?: unknown[]
}

interface EmpleadoConFilas {
  rows?: RowConPares[]
}

/**
 * Mayor cantidad de pares entrada/salida entre todos los empleados.
 *
 * Se calcula con reduce y NO con `Math.max(...empleados.flatMap(…))`. El
 * spread pasa cada elemento como un argumento distinto, y V8 desborda el stack
 * con `RangeError: Maximum call stack size exceeded` alrededor de los 125.000
 * argumentos.
 *
 * Ese umbral es alcanzable acá: el array tiene un elemento por combinación
 * (empleado × día con marcajes), así que un rango de un año sobre varios
 * cientos de empleados lo supera. La pantalla no se ponía lenta: lanzaba una
 * excepción al renderizar, con el reporte ya descargado.
 *
 * El mínimo es 1 para que la tabla siempre tenga al menos una columna de par.
 */
export function maxPairsOf(employees: EmpleadoConFilas[] | null | undefined): number {
  return (employees || []).reduce((max, emp) => {
    const filas = emp?.rows || []
    return filas.reduce((m, r) => {
      const n = r?.pairs?.length ?? 0
      return n > m ? n : m
    }, max)
  }, 1)
}
