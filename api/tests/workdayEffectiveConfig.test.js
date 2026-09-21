/**
 * workdayEffectiveConfig.test.js — Precedencia explícita de configuración de
 * jornada efectiva (pura, sin BD): orden de capas, vigencias, completitud,
 * nocturnos y determinismo independiente de timezone.
 */

const R = require('../src/services/workdayEffectiveConfig');

const COMPLETE = { check_in: '08:00:00', check_out: '17:00:00', work_days: '2,3,4,5,6' };
const NIGHT = { check_in: '22:00:00', check_out: '06:00:00', work_days: '2,3,4,5,6', night_start: '21:00:00', night_end: '06:00:00' };

describe('parseWorkDays / isCompleteConfig', () => {
  test('parseWorkDays acepta string y array, filtra 1..7', () => {
    expect(R.parseWorkDays('2,3,4,5,6')).toEqual([2, 3, 4, 5, 6]);
    expect(R.parseWorkDays([1, 7, 9, 0])).toEqual([1, 7]);
    expect(R.parseWorkDays('')).toEqual([]);
    expect(R.parseWorkDays(null)).toEqual([]);
  });
  test('isCompleteConfig exige check_in+check_out+work_days', () => {
    expect(R.isCompleteConfig(COMPLETE)).toBe(true);
    expect(R.isCompleteConfig({ check_in: '08:00', check_out: '17:00', work_days: '' })).toBe(false);
    expect(R.isCompleteConfig({ check_in: '08:00', work_days: '2,3' })).toBe(false);
    expect(R.isCompleteConfig(null)).toBe(false);
  });
});

describe('pickVigente — versión vigente por fecha', () => {
  const rows = [
    { valid_from: '2026-01-01', valid_to: '2026-05-31', tag: 'v1' },
    { valid_from: '2026-06-01', valid_to: null, tag: 'v2' },
    { valid_from: '2027-01-01', valid_to: null, tag: 'future' },
  ];
  test('elige la de valid_from más reciente que cubre la fecha', () => {
    expect(R.pickVigente(rows, '2026-03-15').tag).toBe('v1');
    expect(R.pickVigente(rows, '2026-06-01').tag).toBe('v2');
    expect(R.pickVigente(rows, '2026-12-31').tag).toBe('v2');
  });
  test('excluye futuras y cerradas antes de la fecha', () => {
    expect(R.pickVigente(rows, '2025-12-31')).toBeNull();
    expect(R.pickVigente([{ valid_from: '2026-01-01', valid_to: '2026-01-31' }], '2026-02-01')).toBeNull();
  });
  test('ignora filas inactivas', () => {
    expect(R.pickVigente([{ valid_from: '2026-01-01', valid_to: null, active: 0 }], '2026-06-01')).toBeNull();
  });
});

describe('resolveEffective — orden de precedencia', () => {
  const dept = { ...COMPLETE, label: 'dept' };
  const company = { ...COMPLETE, label: 'company' };
  const general = { ...COMPLETE, label: 'general' };

  test('1. published shift assignment gana a todo', () => {
    const r = R.resolveEffective({
      employeeLayer: { config: { ...COMPLETE, source: 'shift_assignment' }, layer: R.LAYER.PUBLISHED_SHIFT_ASSIGNMENT },
      departmentDefault: dept, companyDefault: company, generalDefault: general,
    });
    expect(r.layer).toBe('published_shift_assignment');
    expect(r.calculation_mode).toBe('configured');
  });

  test('2. employee override gana a dept/company/general', () => {
    const r = R.resolveEffective({
      employeeLayer: { config: { ...COMPLETE, source: 'schedule_history' }, layer: R.LAYER.EMPLOYEE_HISTORICAL_OVERRIDE },
      departmentDefault: dept, companyDefault: company, generalDefault: general,
    });
    expect(r.layer).toBe('employee_historical_override');
  });

  test('3. sin capa empleado → department default', () => {
    const r = R.resolveEffective({ employeeLayer: null, departmentDefault: dept, companyDefault: company, generalDefault: general });
    expect(r.layer).toBe('department_historical_default');
    expect(r.calculation_mode).toBe('configured');
    expect(r.config.label).toBe('dept');
    expect(r.config.source).toBe('department_historical_default');
  });

  test('4a. sin dept → company default', () => {
    const r = R.resolveEffective({ departmentDefault: null, companyDefault: company, generalDefault: general });
    expect(r.layer).toBe('company_historical_default');
    expect(r.config.label).toBe('company');
  });

  test('4b. sin dept ni company → general default', () => {
    const r = R.resolveEffective({ generalDefault: general });
    expect(r.layer).toBe('general_historical_default');
    expect(r.config.label).toBe('general');
  });

  test('default INCOMPLETO se salta (no inventa jornada)', () => {
    const incompleteDept = { check_in: '08:00:00', check_out: null, work_days: '2,3,4,5,6' };
    const r = R.resolveEffective({ departmentDefault: incompleteDept, companyDefault: company });
    expect(r.layer).toBe('company_historical_default'); // saltó el dept incompleto
  });

  test('5. sólo traza de contrato → historical_fallback con contract_id', () => {
    const r = R.resolveEffective({ contractTrace: { contract_id: 42 } });
    expect(r.layer).toBe('employee_contract_trace');
    expect(r.calculation_mode).toBe('historical_fallback');
    expect(r.contract_id).toBe(42);
    expect(r.config).toBeNull();
  });

  test('6. sin nada → historical_fallback', () => {
    const r = R.resolveEffective({});
    expect(r.layer).toBe('historical_fallback');
    expect(r.calculation_mode).toBe('historical_fallback');
    expect(r.config).toBeNull();
  });

  test('capa empleado no-laborable → calculation_mode non_working', () => {
    const r = R.resolveEffective({
      employeeLayer: { config: { non_working: true, kind: 'vacation' }, layer: R.LAYER.PUBLISHED_SHIFT_ASSIGNMENT },
      departmentDefault: dept,
    });
    expect(r.calculation_mode).toBe('non_working');
  });

  test('nocturno: el default nocturno preserva night_start/night_end', () => {
    const r = R.resolveEffective({ departmentDefault: { ...NIGHT, label: 'noct' } });
    expect(r.layer).toBe('department_historical_default');
    expect(r.config.night_start).toBe('21:00:00');
    expect(r.config.night_end).toBe('06:00:00');
  });

  test('PRECEDENCE es el orden canónico de 7 capas', () => {
    expect(R.PRECEDENCE).toEqual([
      'published_shift_assignment', 'employee_historical_override',
      'department_historical_default', 'company_historical_default',
      'general_historical_default', 'employee_contract_trace', 'historical_fallback',
    ]);
  });
});

describe('determinismo independiente de timezone', () => {
  test('la resolución por fecha usa strings YYYY-MM-DD (sin Date/TZ)', () => {
    const rows = [{ valid_from: '2026-09-19', valid_to: null, work_days: '2,3,4,5,6', check_in: '18:00:00', check_out: '02:00:00' }];
    // Fecha del día siguiente (cruce de medianoche civil) sigue cubierta por la versión abierta.
    expect(R.pickVigente(rows, '2026-09-20')).not.toBeNull();
    expect(R.pickVigente(rows, '2026-09-18')).toBeNull();
  });
});
