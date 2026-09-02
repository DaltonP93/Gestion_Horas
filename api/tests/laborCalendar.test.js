/**
 * laborCalendar.test.js — clasificación PURA de días, invariante a la TZ del
 * proceso (CI corre este archivo en UTC, America/Asuncion y Asia/Tokyo y debe
 * dar el mismo resultado). Fechas de referencia en enero 2026:
 *   2026-01-03 = sábado, 2026-01-04 = domingo, 2026-01-05 = lunes.
 */
const cal = require('../src/services/laborCalendar');

describe('classifyDay — modelo de semana (descanso dominical por defecto)', () => {
  test('domingo no laborable, lunes laborable', () => {
    expect(cal.classifyDay('2026-01-04', {})).toEqual({ date: '2026-01-04', working: false, reason: 'sunday' });
    expect(cal.classifyDay('2026-01-05', {})).toEqual({ date: '2026-01-05', working: true, reason: 'workday' });
  });

  test('isSunday', () => {
    expect(cal.isSunday('2026-01-04')).toBe(true);
    expect(cal.isSunday('2026-01-05')).toBe(false);
  });
});

describe('classifyDay — feriados y excepciones (precedencia)', () => {
  test('feriado no laborable', () => {
    const r = cal.classifyDay('2026-01-05', { holidaySet: new Set(['2026-01-05']) });
    expect(r).toEqual({ date: '2026-01-05', working: false, reason: 'holiday' });
  });

  test('excepción working habilita un domingo', () => {
    const r = cal.classifyDay('2026-01-04', { exceptionMap: new Map([['2026-01-04', 'working']]) });
    expect(r).toEqual({ date: '2026-01-04', working: true, reason: 'exception_working' });
  });

  test('excepción nonworking bloquea un día hábil', () => {
    const r = cal.classifyDay('2026-01-05', { exceptionMap: new Map([['2026-01-05', 'nonworking']]) });
    expect(r).toEqual({ date: '2026-01-05', working: false, reason: 'exception_nonworking' });
  });

  test('excepción working tiene prioridad sobre feriado', () => {
    const r = cal.classifyDay('2026-01-05', {
      holidaySet: new Set(['2026-01-05']),
      exceptionMap: new Map([['2026-01-05', 'working']]),
    });
    expect(r.working).toBe(true);
    expect(r.reason).toBe('exception_working');
  });

  test('excepción special marca el día pero no cambia la base laborable', () => {
    const r = cal.classifyDay('2026-01-05', { exceptionMap: new Map([['2026-01-05', 'special']]) });
    expect(r).toEqual({ date: '2026-01-05', working: true, reason: 'special' });
  });
});

describe('classifyDay — work_days (1=domingo … 7=sábado)', () => {
  const workDays = [2, 3, 4, 5, 6]; // lunes a viernes
  test('sábado y domingo descansan; lunes trabaja', () => {
    expect(cal.classifyDay('2026-01-03', { workDays }).working).toBe(false); // sábado
    expect(cal.classifyDay('2026-01-03', { workDays }).reason).toBe('rest_day');
    expect(cal.classifyDay('2026-01-04', { workDays }).reason).toBe('sunday');
    expect(cal.classifyDay('2026-01-05', { workDays }).working).toBe(true);
  });
});

describe('composeRange', () => {
  test('cuenta días laborables con descanso dominical', () => {
    const r = cal.composeRange('2026-01-04', '2026-01-10'); // dom..sáb
    expect(r).toHaveLength(7);
    expect(cal.countWorking(r)).toBe(6); // sólo el domingo descansa
  });

  test('rechaza rango invertido, inválido o excesivo', () => {
    expect(() => cal.composeRange('2026-01-10', '2026-01-04')).toThrow(/anterior/i);
    expect(() => cal.composeRange('bad', '2026-01-10')).toThrow(/inválid/i);
    expect(() => cal.composeRange('2020-01-01', '2026-01-01')).toThrow(/amplio/i);
  });
});
