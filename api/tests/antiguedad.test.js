/**
 * antiguedad.test.js — cálculo derivado (años/meses) a partir de hire_date.
 * Incluye lote TZ-cruzado con subprocesos (UTC vs America/Asuncion).
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { computeAntiguedad, formatAntiguedad } = require('../src/services/antiguedad');

describe('antiguedad.computeAntiguedad', () => {
  test('mismo día → 0/0', () => {
    expect(computeAntiguedad('2026-07-30', '2026-07-30')).toEqual({ years: 0, months: 0, days: 0 });
  });

  test('un día antes del aniversario NO cuenta el año', () => {
    // De 2020-07-30 a 2026-07-29 hay 5 años + 11 meses + 29 días (jun tiene 30).
    expect(computeAntiguedad('2020-07-30', '2026-07-29')).toEqual({ years: 5, months: 11, days: 29 });
  });

  test('exactamente en el aniversario cuenta 1 año', () => {
    expect(computeAntiguedad('2020-07-30', '2021-07-30')).toEqual({ years: 1, months: 0, days: 0 });
  });

  test('10 años y 6 meses', () => {
    expect(computeAntiguedad('2015-01-15', '2025-07-15')).toEqual({ years: 10, months: 6, days: 0 });
  });

  test('cumpleaños laboral aún no cumplido dentro del año', () => {
    expect(computeAntiguedad('2020-08-15', '2025-08-14')).toEqual({ years: 4, months: 11, days: 30 });
  });

  test('fin de mes: 31-ene → 28/29-feb no cierra 1 mes hasta que rueda el día', () => {
    // 31-ene-2020 → 29-feb-2020: aún no cumple 1 mes calendario (el algoritmo
    // usa la longitud del mes previo para el borrow, día a día).
    expect(computeAntiguedad('2020-01-31', '2020-02-29')).toEqual({ years: 0, months: 0, days: 29 });
    // 31-ene-2020 → 2-mar-2020: 1 mes exacto (29 días de febrero + roll a mar).
    expect(computeAntiguedad('2020-01-31', '2020-03-02')).toEqual({ years: 0, months: 1, days: 0 });
    // 31-ene-2020 → 3-mar-2020: 1 mes 1 día.
    expect(computeAntiguedad('2020-01-31', '2020-03-03')).toEqual({ years: 0, months: 1, days: 1 });
  });

  test('año bisiesto: hire 29-feb-2020', () => {
    expect(computeAntiguedad('2020-02-29', '2024-02-29')).toEqual({ years: 4, months: 0, days: 0 });
    expect(computeAntiguedad('2020-02-29', '2024-02-28')).toEqual({ years: 3, months: 11, days: 30 });
    // 2025 (no bisiesto) → el "aniversario" cae efectivamente el 1-mar
    // por el rollover; verificamos el comportamiento actual: 28-feb aún es 4a11m.
    expect(computeAntiguedad('2020-02-29', '2025-02-28')).toEqual({ years: 4, months: 11, days: 30 });
  });

  test('fecha de ingreso futura → 0/0/0', () => {
    expect(computeAntiguedad('2030-01-01', '2026-07-30')).toEqual({ years: 0, months: 0, days: 0 });
  });

  test('hire_date inválido o ausente → null', () => {
    expect(computeAntiguedad(null, '2026-07-30')).toBeNull();
    expect(computeAntiguedad('', '2026-07-30')).toBeNull();
    expect(computeAntiguedad('abc', '2026-07-30')).toBeNull();
    expect(computeAntiguedad('2020-01-15', 'zzz')).toBeNull();
  });
});

describe('antiguedad.formatAntiguedad', () => {
  test('null → "Sin fecha de ingreso"', () => {
    expect(formatAntiguedad(null)).toBe('Sin fecha de ingreso');
  });
  test('0 años 0 meses → "Menos de 1 mes"', () => {
    expect(formatAntiguedad({ years: 0, months: 0 })).toBe('Menos de 1 mes');
  });
  test('sólo meses', () => {
    expect(formatAntiguedad({ years: 0, months: 1 })).toBe('1 mes');
    expect(formatAntiguedad({ years: 0, months: 6 })).toBe('6 meses');
  });
  test('sólo años', () => {
    expect(formatAntiguedad({ years: 1, months: 0 })).toBe('1 año');
    expect(formatAntiguedad({ years: 3, months: 0 })).toBe('3 años');
  });
  test('años y meses', () => {
    expect(formatAntiguedad({ years: 10, months: 6 })).toBe('10 años y 6 meses');
    expect(formatAntiguedad({ years: 2, months: 1 })).toBe('2 años y 1 mes');
  });
});

// ── TZ invariancia ─────────────────────────────────────────────────
const CASES = `
  const { computeAntiguedad } = require('./src/services/antiguedad');
  const out = {
    exact: computeAntiguedad('2020-07-30','2025-07-30'),
    minus1: computeAntiguedad('2020-07-30','2025-07-29'),
    tenSixMonths: computeAntiguedad('2015-01-15','2025-07-15'),
    leap: computeAntiguedad('2020-02-29','2024-02-29'),
    leapMinus1: computeAntiguedad('2020-02-29','2024-02-28'),
    monthEnd: computeAntiguedad('2020-01-31','2020-03-02'),
    future: computeAntiguedad('2030-01-01','2026-07-30'),
  };
  process.stdout.write(JSON.stringify(out));
`;
function runInTZ(tz) {
  const res = spawnSync(process.execPath, ['-e', CASES], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '..'),
  });
  if (res.status !== 0) throw new Error(`node exit ${res.status}\n${res.stderr}`);
  return JSON.parse(res.stdout);
}
describe('antiguedad — invariancia respecto de la TZ del proceso', () => {
  const utc = runInTZ('UTC');
  const asuncion = runInTZ('America/Asuncion');
  test('idéntico bajo TZ=UTC y TZ=America/Asuncion', () => {
    expect(asuncion).toEqual(utc);
  });
});
