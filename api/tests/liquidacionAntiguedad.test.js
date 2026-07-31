/**
 * PR-B: la antigüedad la deriva `computeLiquidacion` desde `hire_date`
 * (fuente única). Se conserva un fallback al valor legado `antiguedad_rate`
 * si el empleado no tiene fecha de ingreso. `refDate` puede fijarse en los
 * rates para pruebas deterministas.
 */

const { computeLiquidacion, DEFAULT_RATES } = require('../src/services/liquidacion');

describe('computeLiquidacion — antigüedad derivada de hire_date', () => {
  const baseEmp = {
    pay_type: 'mensualizado',
    salary_base: 3_000_000,       // Gs.
    children_count: 0,
    days: [],
  };

  test('5 años completos × 1%/año = 5% del básico', () => {
    const r = computeLiquidacion(
      { ...baseEmp, hire_date: '2020-07-30' },
      30,
      { refDate: '2025-07-30' }
    );
    expect(r.antiguedad).toBe(150000); // 3.000.000 × 5%
  });

  test('un día antes del aniversario NO cumple el año', () => {
    const r = computeLiquidacion(
      { ...baseEmp, hire_date: '2020-07-30' },
      30,
      { refDate: '2025-07-29' }
    );
    // 4 años cumplidos × 1% = 4%
    expect(r.antiguedad).toBe(120000);
  });

  test('0 años sin hire_date ni fallback → sin antigüedad', () => {
    const r = computeLiquidacion({ ...baseEmp }, 30);
    expect(r.antiguedad).toBe(0);
  });

  test('fallback a antiguedad_rate cuando no hay hire_date (compat)', () => {
    const r = computeLiquidacion(
      { ...baseEmp, antiguedad_rate: 8 }, 30
    );
    expect(r.antiguedad).toBe(240000); // 3.000.000 × 8 × 1%
  });

  test('hire_date presente ignora legacy antiguedad_rate', () => {
    // hire_date acabaría dando 5 años, no los 20 del campo legado.
    const r = computeLiquidacion(
      { ...baseEmp, hire_date: '2020-07-30', antiguedad_rate: 20 }, 30,
      { refDate: '2025-07-30' }
    );
    expect(r.antiguedad).toBe(150000);
  });

  test('override de antiguedadPctPorAno vía rates (CCT distinto)', () => {
    // 10 años × 2%/año = 20% del básico → 600.000
    const r = computeLiquidacion(
      { ...baseEmp, hire_date: '2015-07-30' }, 30,
      { antiguedadPctPorAno: 2, refDate: '2025-07-30' }
    );
    expect(r.antiguedad).toBe(600000);
  });

  test('DEFAULT_RATES incluye antiguedadPctPorAno', () => {
    expect(DEFAULT_RATES.antiguedadPctPorAno).toBe(1);
  });
});
