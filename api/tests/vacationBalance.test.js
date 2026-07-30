const {
  yearsBetween, entitlementFor, countDays, countTakenIn,
} = require('../src/services/vacationBalance');

describe('vacationBalance.yearsBetween', () => {
  test('sin hire_date → 0', () => {
    expect(yearsBetween(null, new Date('2026-07-30'))).toBe(0);
    expect(yearsBetween(undefined, '2026-07-30')).toBe(0);
  });
  test('exactamente en el aniversario cuenta 1', () => {
    expect(yearsBetween('2020-07-30', new Date('2021-07-30'))).toBe(1);
  });
  test('un día antes del aniversario NO cuenta el año', () => {
    expect(yearsBetween('2020-07-30', new Date('2021-07-29'))).toBe(0);
  });
  test('5 años cumplidos', () => {
    expect(yearsBetween('2020-07-30', new Date('2026-07-30'))).toBe(6);
    expect(yearsBetween('2020-07-30', new Date('2026-07-29'))).toBe(5);
  });
  test('cutoff previo al hire → 0 (no negativo)', () => {
    expect(yearsBetween('2026-01-01', new Date('2025-12-31'))).toBe(0);
  });
});

describe('vacationBalance.entitlementFor', () => {
  const brackets = [
    { min_years: 0,  max_years: 5,    days: 12 },
    { min_years: 5,  max_years: 10,   days: 18 },
    { min_years: 10, max_years: null, days: 24 },
  ];
  test('menos de 5 → 12', () => expect(entitlementFor(brackets, 2)).toBe(12));
  test('exactamente 5 → 18', () => expect(entitlementFor(brackets, 5)).toBe(18));
  test('10 o más → 24', () => expect(entitlementFor(brackets, 15)).toBe(24));
  test('brackets vacío → 0', () => expect(entitlementFor([], 8)).toBe(0));
  test('brackets no-array → 0', () => expect(entitlementFor(null, 8)).toBe(0));
});

describe('vacationBalance.countDays', () => {
  test('rango inválido (to < from) → 0', () => {
    expect(countDays('2026-01-05', '2026-01-01')).toBe(0);
  });
  test('corridos incluye fines de semana y feriados', () => {
    // 2026-07-30 (jue) a 2026-08-05 (mie) = 7 días
    expect(countDays('2026-07-30', '2026-08-05', { dayType: 'corridos' })).toBe(7);
  });
  test('hábiles excluye sábado y domingo', () => {
    // 2026-07-30 jue, 31 vie, 1 sáb, 2 dom, 3 lun, 4 mar, 5 mie → 5 hábiles
    expect(countDays('2026-07-30', '2026-08-05', { dayType: 'habiles' })).toBe(5);
  });
  test('hábiles descuenta feriados de la semana', () => {
    const holidays = new Set(['2026-07-31']);
    expect(countDays('2026-07-30', '2026-08-05', { dayType: 'habiles', holidaysSet: holidays })).toBe(4);
  });
  test('un solo día hábil', () => {
    expect(countDays('2026-08-03', '2026-08-03', { dayType: 'habiles' })).toBe(1); // lun
    expect(countDays('2026-08-01', '2026-08-01', { dayType: 'habiles' })).toBe(0); // sáb
  });
});

describe('vacationBalance.countTakenIn', () => {
  test('recorta a los límites del año', () => {
    const vacs = [{ date_from: '2025-12-28', date_to: '2026-01-05' }];
    const taken = countTakenIn(vacs, {
      yearStart: '2026-01-01', yearEnd: '2026-12-31',
      dayType: 'corridos', holidaysSet: new Set(),
    });
    // Solo los días desde 2026-01-01 → 05 = 5 corridos.
    expect(taken).toBe(5);
  });
  test('suma múltiples rangos', () => {
    const vacs = [
      { date_from: '2026-02-02', date_to: '2026-02-06' }, // lun-vie = 5 hábiles
      { date_from: '2026-03-02', date_to: '2026-03-03' }, // lun-mar = 2 hábiles
    ];
    const taken = countTakenIn(vacs, {
      yearStart: '2026-01-01', yearEnd: '2026-12-31',
      dayType: 'habiles', holidaysSet: new Set(),
    });
    expect(taken).toBe(7);
  });
  test('sin rangos → 0', () => {
    expect(countTakenIn([], { yearStart: '2026-01-01', yearEnd: '2026-12-31', dayType: 'habiles', holidaysSet: new Set() })).toBe(0);
    expect(countTakenIn(null, { yearStart: '2026-01-01', yearEnd: '2026-12-31', dayType: 'habiles', holidaysSet: new Set() })).toBe(0);
  });
});
