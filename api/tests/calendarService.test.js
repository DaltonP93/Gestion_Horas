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

describe('resolveEffective (read-only) usa work_days del calendario', () => {
  test('feriado y excepción se reflejan; toma work_days persistidos', async () => {
    sequelize.query
      // getCalendar (work_days lun-vie)
      .mockResolvedValueOnce([[{ id: 1, work_days: '2,3,4,5,6', timezone: 'America/Asuncion' }]])
      // holidaysInRange
      .mockResolvedValueOnce([[{ d: '2026-01-06' }]])
      // exceptionsInRange
      .mockResolvedValueOnce([[{ d: '2026-01-04', kind: 'working' }]]);
    const r = await svc.resolveEffective(1, '2026-01-04', '2026-01-06');
    expect(r.total_days).toBe(3);
    expect(r.work_days).toEqual([2, 3, 4, 5, 6]);
    const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
    expect(byDate['2026-01-04'].reason).toBe('exception_working'); // domingo habilitado
    expect(byDate['2026-01-06'].reason).toBe('holiday');           // feriado
    expect(byDate['2026-01-05'].working).toBe(true);
  });
});

describe('resolveEffectiveByScope elige versión por fecha (precedencia determinista)', () => {
  test('cada día resuelve su calendario por alcance + vigencia', async () => {
    // 1 día → pickCalendarForDate (1 query) + exceptionsInRange (1 query). holidays 1 query al inicio.
    sequelize.query
      .mockResolvedValueOnce([[]])                                  // holidaysInRange
      .mockResolvedValueOnce([[{ id: 7, work_days: '2,3,4,5,6' }]]) // pickCalendarForDate
      .mockResolvedValueOnce([[]]);                                 // exceptionsInRange(cal 7)
    const r = await svc.resolveEffectiveByScope({ company_id: 9, branch_id: null }, '2026-01-05', '2026-01-05');
    expect(r.total_days).toBe(1);
    expect(r.days[0]).toMatchObject({ date: '2026-01-05', working: true, calendar_id: 7 });
  });
});

describe('lectura de jornada — 3 estados de esquema', () => {
  test('missing: tabla ausente → historical_fallback', async () => {
    sequelize.query.mockResolvedValueOnce([[]]); // TABLES → no existe
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('missing');
    expect(r.workday).toEqual({ source: 'historical_fallback', config: null });
    expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
  });

  test('incomplete: tabla sin columnas de 073 → respuesta controlada (no error crudo)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]]) // TABLES existe
      .mockResolvedValueOnce([[]]);         // COLUMNS work_regime ausente
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('incomplete');
    expect(r.workday).toBeNull();
    expect(r.message).toMatch(/parcialmente migrado/i);
    expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
  });

  test('complete: delega en workdayConfig (read-only)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]]) // TABLES
      .mockResolvedValueOnce([[{ ok: 1 }]]); // COLUMNS work_regime presente
    const forDate = jest.fn().mockReturnValue({ source: 'employee_schedule_history', config: { check_in: '08:00:00' } });
    workdayConfig.loadWorkdayConfig.mockResolvedValueOnce({ forDate });
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('complete');
    expect(r.workday.source).toBe('employee_schedule_history');
  });
});
