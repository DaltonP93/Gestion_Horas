const { maxPairsOf } = require('../src/services/scheduler');

/** Filas de un empleado: `n` días, cada uno con `pares` pares. */
function filas(n, pares = 1) {
  return Array.from({ length: n }, () => ({ pairs: new Array(pares).fill({}) }));
}

describe('maxPairsOf', () => {
  test('devuelve el máximo de pares', () => {
    expect(maxPairsOf([{ pairs: [1, 2] }, { pairs: [1] }, { pairs: [1, 2, 3] }])).toBe(3);
  });

  test('el mínimo es 1 para que la tabla tenga al menos una columna', () => {
    expect(maxPairsOf([])).toBe(1);
    expect(maxPairsOf([{ pairs: [] }])).toBe(1);
    expect(maxPairsOf(null)).toBe(1);
    expect(maxPairsOf(undefined)).toBe(1);
  });

  test('tolera filas mal formadas sin lanzar', () => {
    expect(maxPairsOf([null, undefined, {}, { pairs: [1, 2] }])).toBe(2);
  });

  test('★ la regresión: no desborda el stack con arrays grandes', () => {
    // El código viejo hacía Math.max(...filas.map(…)). El spread pasa cada
    // elemento como un argumento y V8 revienta cerca de los 125.000. Este
    // array tiene 200.000, un tamaño realista para un año de marcajes sobre
    // varios cientos de empleados.
    const grande = filas(200_000, 2);

    expect(() => Math.max(...grande.map(r => r.pairs.length))).toThrow(RangeError);
    expect(maxPairsOf(grande)).toBe(2);
  });

  test('el resultado coincide con el del método viejo por debajo del umbral', () => {
    // Donde el spread no desborda, ambos tienen que dar lo mismo: el cambio es
    // de mecánica, no de semántica.
    const chico = [...filas(50, 1), { pairs: [1, 2, 3, 4] }, ...filas(50, 2)];
    expect(maxPairsOf(chico)).toBe(Math.max(...chico.map(r => r.pairs.length), 1));
  });
});
