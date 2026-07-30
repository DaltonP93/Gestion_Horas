/**
 * PR-A: la columna `antiguedad_rate` pasa a interpretarse como AÑOS.
 * `computeLiquidacion` debe multiplicar por `antiguedadPctPorAno` (default 1%).
 */

const { computeLiquidacion, DEFAULT_RATES } = require('../src/services/liquidacion');

describe('computeLiquidacion — antigüedad (años × pct/año)', () => {
  const baseEmp = {
    pay_type: 'mensualizado',
    salary_base: 3_000_000,       // Gs.
    children_count: 0,
    days: [],
  };

  test('default: 5 años × 1%/año = 5% del básico', () => {
    const r = computeLiquidacion({ ...baseEmp, antiguedad_rate: 5 }, 30);
    // básico prorrateado 30/30 → 3.000.000 · 5% = 150.000
    expect(r.antiguedad).toBe(150000);
  });

  test('0 años no aporta antigüedad', () => {
    const r = computeLiquidacion({ ...baseEmp, antiguedad_rate: 0 }, 30);
    expect(r.antiguedad).toBe(0);
  });

  test('antiguedad_rate ausente no rompe (default 0)', () => {
    const r = computeLiquidacion({ ...baseEmp }, 30);
    expect(r.antiguedad).toBe(0);
  });

  test('override de antiguedadPctPorAno vía rates (CCT distinto)', () => {
    // 10 años · 2%/año = 20% del básico → 600.000
    const r = computeLiquidacion(
      { ...baseEmp, antiguedad_rate: 10 }, 30,
      { antiguedadPctPorAno: 2 }
    );
    expect(r.antiguedad).toBe(600000);
  });

  test('DEFAULT_RATES incluye antiguedadPctPorAno', () => {
    expect(DEFAULT_RATES.antiguedadPctPorAno).toBe(1);
  });
});
