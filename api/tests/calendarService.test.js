/**
 * calendarService.test.js — kill-switch, resolutor read-only, degradación ante
 * tabla ausente e integración READ-ONLY con jornada.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const workdayConfig = require('../src/services/workdayConfig');
const svc = require('../src/services/calendarService');

const ORIG = process.env.CALENDAR_WRITE_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CALENDAR_WRITE_ENABLED; else process.env.CALENDAR_WRITE_ENABLED = ORIG;
  jest.clearAllMocks();
});

describe('kill switch fail-closed', () => {
  test('sólo "true" habilita; assertWriteEnabled → 503', () => {
    delete process.env.CALENDAR_WRITE_ENABLED;
    expect(svc.isWriteEnabled()).toBe(false);
    try { svc.assertWriteEnabled(); throw new Error('no lanzó'); }
    catch (e) { expect(e.status).toBe(503); expect(e.code).toBe('CALENDAR_WRITES_DISABLED'); }
    process.env.CALENDAR_WRITE_ENABLED = 'true';
    expect(svc.isWriteEnabled()).toBe(true);
  });
});

describe('degradación ante tabla ausente', () => {
  test('listCalendars devuelve [] si la tabla no existe (42S02)', async () => {
    sequelize.query.mockRejectedValueOnce(Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' }));
    expect(await svc.listCalendars()).toEqual([]);
  });

  test('propaga un error real de base (no 42S02)', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('connection lost'));
    await expect(svc.listCalendars()).rejects.toThrow(/connection lost/);
  });
});

describe('resolveEffective (read-only) compone feriados + excepciones', () => {
  test('feriado y excepción se reflejan en el rango', async () => {
    sequelize.query
      // holidaysInRange
      .mockResolvedValueOnce([[{ d: '2026-01-06' }]])
      // exceptionsInRange
      .mockResolvedValueOnce([[{ d: '2026-01-04', kind: 'working' }]]);
    const r = await svc.resolveEffective(1, '2026-01-04', '2026-01-06');
    expect(r.total_days).toBe(3);
    const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
    expect(byDate['2026-01-04'].working).toBe(true);       // domingo habilitado por excepción
    expect(byDate['2026-01-04'].reason).toBe('exception_working');
    expect(byDate['2026-01-06'].working).toBe(false);      // feriado
    expect(byDate['2026-01-06'].reason).toBe('holiday');
    expect(byDate['2026-01-05'].working).toBe(true);
  });
});

describe('integración READ-ONLY con jornada', () => {
  test('delega en workdayConfig y no ejecuta ninguna escritura', async () => {
    const forDate = jest.fn().mockReturnValue({ source: 'employee_schedule_history', config: { check_in: '08:00:00' } });
    workdayConfig.loadWorkdayConfig.mockResolvedValueOnce({ forDate });
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(workdayConfig.loadWorkdayConfig).toHaveBeenCalledWith([50], { from: '2026-01-05', to: '2026-01-05' });
    expect(r.source).toBe('employee_schedule_history');
    // No hubo INSERT/UPDATE/DELETE
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('devuelve historical_fallback cuando no hay config', async () => {
    workdayConfig.loadWorkdayConfig.mockResolvedValueOnce({ forDate: () => null });
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r).toEqual({ source: 'historical_fallback', config: null });
  });
});
