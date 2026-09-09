/**
 * migrateMonotonicityGuard.test.js
 *
 * Gate raíz del orden de migraciones. Prueba las funciones puras del runner
 * (`scripts/migrate.js`) SIN base de datos:
 *   - parseMigrationNumber: extrae el prefijo NNN.
 *   - findDuplicateNumbers: números repetidos en disco (el runner llavea por
 *     nombre → el 2° se saltearía en silencio).
 *   - outOfOrderPending: pendientes con número menor que el máximo aplicado
 *     (aplicarlas correría fuera de secuencia) — el caso 081/082/083 vs 076-080.
 *
 * Es 100% read-only: no toca DB, flags ni att2000.
 */
const {
  parseMigrationNumber,
  findDuplicateNumbers,
  outOfOrderPending,
} = require('../scripts/migrate.js');

describe('parseMigrationNumber', () => {
  test('extrae el prefijo numérico', () => {
    expect(parseMigrationNumber('076_governance_companies_cost_centers.sql')).toBe(76);
    expect(parseMigrationNumber('002_algo.sql')).toBe(2);
    expect(parseMigrationNumber('083_consola.sql')).toBe(83);
  });
  test('devuelve null si no hay prefijo numérico', () => {
    expect(parseMigrationNumber('init.sql')).toBeNull();
    expect(parseMigrationNumber('README.md')).toBeNull();
  });
});

describe('findDuplicateNumbers', () => {
  test('sin duplicados → []', () => {
    expect(findDuplicateNumbers(['002_a.sql', '003_b.sql', '076_c.sql'])).toEqual([]);
  });
  test('detecta el mismo NNN con nombres distintos', () => {
    const dups = findDuplicateNumbers(['081_firma.sql', '081_otra_cosa.sql', '082_ok.sql']);
    expect(dups).toEqual([{ number: 81, files: ['081_firma.sql', '081_otra_cosa.sql'] }]);
  });
  test('ignora archivos sin prefijo numérico', () => {
    expect(findDuplicateNumbers(['init.sql', '002_a.sql', 'notas.txt'])).toEqual([]);
  });
});

describe('outOfOrderPending (guardia de monotonicidad)', () => {
  test('nada aplicado todavía → nunca hay desorden', () => {
    expect(outOfOrderPending(['002_a.sql', '076_b.sql'], [])).toEqual([]);
  });

  test('pendientes todas por encima del máximo aplicado → []', () => {
    const done = ['002_a.sql', '003_b.sql'];
    const pending = ['004_c.sql', '005_d.sql'];
    expect(outOfOrderPending(pending, done)).toEqual([]);
  });

  test('EL CASO REAL: 081/082/083 aplicadas y 076-080 (FASE F) llegan después', () => {
    const done = ['080_x.sql', '081_firma.sql', '082_firma2.sql', '083_consola.sql'];
    const pending = [
      '076_governance_companies_cost_centers.sql',
      '077_audit.sql',
      '078_people.sql',
      '079_calendars.sql',
    ];
    // 076-079 < 083 (máximo aplicado) → todas fuera de secuencia, en orden.
    expect(outOfOrderPending(pending, done)).toEqual([
      '076_governance_companies_cost_centers.sql',
      '077_audit.sql',
      '078_people.sql',
      '079_calendars.sql',
    ]);
  });

  test('una sola pendiente por debajo del máximo se detecta', () => {
    const done = ['075_a.sql', '081_b.sql'];
    const pending = ['076_c.sql', '090_d.sql']; // 076 < 81, 090 > 81
    expect(outOfOrderPending(pending, done)).toEqual(['076_c.sql']);
  });

  test('huecos de numeración (falta 001/058) no cuentan como desorden', () => {
    const done = ['002_a.sql', '057_b.sql', '059_c.sql'];
    const pending = ['060_d.sql', '075_e.sql'];
    expect(outOfOrderPending(pending, done)).toEqual([]);
  });
});
