const {
  parseCivilDate, civilDateISO, addDaysUTC, dayOfWeekUTC, todayInCompanyTZ, civilMonthRange,
} = require('../src/utils/civilDate');

describe('civilDate.parseCivilDate', () => {
  test('YYYY-MM-DD → Date en UTC midnight', () => {
    const d = parseCivilDate('2026-08-03');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(7);
    expect(d.getUTCDate()).toBe(3);
    expect(d.getUTCHours()).toBe(0);
  });
  test('acepta prefijo YYYY-MM-DD y descarta el resto', () => {
    const d = parseCivilDate('2026-08-03T15:30:00-03:00');
    expect(civilDateISO(d)).toBe('2026-08-03');
  });
  test('rechaza formato inválido', () => {
    expect(parseCivilDate('03/08/2026')).toBeNull();
    expect(parseCivilDate('2026-13-40')).toBeNull();
    expect(parseCivilDate('')).toBeNull();
    expect(parseCivilDate(null)).toBeNull();
    expect(parseCivilDate(undefined)).toBeNull();
    expect(parseCivilDate(12345)).toBeNull();
  });
  test('desde Date reconstruye por calendario UTC', () => {
    const src = new Date(Date.UTC(2026, 6, 30, 0, 0, 0));
    expect(civilDateISO(parseCivilDate(src))).toBe('2026-07-30');
  });
});

describe('civilDate.civilDateISO', () => {
  test('formatea con ceros', () => {
    expect(civilDateISO(parseCivilDate('2026-01-05'))).toBe('2026-01-05');
  });
});

describe('civilDate.addDaysUTC', () => {
  test('cruza fin de mes', () => {
    expect(civilDateISO(addDaysUTC(parseCivilDate('2026-07-30'), 3))).toBe('2026-08-02');
  });
  test('cruza fin de año', () => {
    expect(civilDateISO(addDaysUTC(parseCivilDate('2026-12-31'), 1))).toBe('2027-01-01');
  });
  test('año bisiesto: 29 feb existe en 2024', () => {
    expect(civilDateISO(addDaysUTC(parseCivilDate('2024-02-28'), 1))).toBe('2024-02-29');
    expect(civilDateISO(addDaysUTC(parseCivilDate('2024-02-29'), 1))).toBe('2024-03-01');
  });
  test('año no bisiesto: 2026 salta directo al 1 mar', () => {
    expect(civilDateISO(addDaysUTC(parseCivilDate('2026-02-28'), 1))).toBe('2026-03-01');
  });
});

describe('civilDate.dayOfWeekUTC', () => {
  test('2026-08-03 (lun) → 1', () => {
    expect(dayOfWeekUTC(parseCivilDate('2026-08-03'))).toBe(1);
  });
  test('2026-08-01 (sáb) → 6', () => {
    expect(dayOfWeekUTC(parseCivilDate('2026-08-01'))).toBe(6);
  });
  test('2026-08-02 (dom) → 0', () => {
    expect(dayOfWeekUTC(parseCivilDate('2026-08-02'))).toBe(0);
  });
});

describe('civilDate.civilMonthRange [P1-E] (invariante a TZ)', () => {
  test('agosto: 01 → 31 (mes de 31 días)', () => {
    expect(civilMonthRange(2026, 8)).toEqual({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  });
  test('febrero bisiesto 2024: 01 → 29', () => {
    expect(civilMonthRange(2024, 2)).toEqual({ dateFrom: '2024-02-01', dateTo: '2024-02-29' });
  });
  test('febrero no bisiesto 2026: 01 → 28', () => {
    expect(civilMonthRange(2026, 2)).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  });
  test('diciembre: 01 → 31', () => {
    expect(civilMonthRange(2026, 12)).toEqual({ dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  });
  test('acepta year/month como string', () => {
    expect(civilMonthRange('2026', '02')).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  });
});

describe('civilDate.todayInCompanyTZ', () => {
  test('para el mismo instante devuelve la fecha civil en America/Asuncion', () => {
    // 2026-01-01T02:00:00Z = 2025-12-31 23:00 en America/Asuncion (UTC-3).
    const t = todayInCompanyTZ(new Date(Date.UTC(2026, 0, 1, 2, 0, 0)), 'America/Asuncion');
    expect(t).toBe('2025-12-31');
  });
  test('para el mismo instante en UTC devuelve UTC', () => {
    const t = todayInCompanyTZ(new Date(Date.UTC(2026, 0, 1, 2, 0, 0)), 'UTC');
    expect(t).toBe('2026-01-01');
  });
});
