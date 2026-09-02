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
    // Ahora: holidaysInRange (1) + loadScopeCalendars UNA vez (1) + exceptionsInRange
    // por calendario (1). Sin branch_id no se deriva empresa (no hay query extra).
    sequelize.query
      .mockResolvedValueOnce([[]])                                                                 // holidaysInRange
      .mockResolvedValueOnce([[{ id: 7, work_days: '2,3,4,5,6', valid_from: '2026-01-01', valid_to: null }]]) // loadScopeCalendars
      .mockResolvedValueOnce([[]]);                                                                // exceptionsInRange(cal 7)
    const r = await svc.resolveEffectiveByScope({ company_id: 9, branch_id: null }, '2026-01-05', '2026-01-05');
    expect(r.total_days).toBe(1);
    expect(r.days[0]).toMatchObject({ date: '2026-01-05', working: true, calendar_id: 7 });
  });

  test('★ pedido SÓLO por sucursal deriva su empresa → aplica el calendario de EMPRESA (fallback)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[]])                        // holidaysInRange
      .mockResolvedValueOnce([[{ company_id: 9 }]])       // companyIdOfBranch(5) → empresa 9
      .mockResolvedValueOnce([[{ id: 20, work_days: '2,3,4,5,6', valid_from: '2026-01-01', valid_to: null, company_id: 9, branch_id: null }]]) // loadScopeCalendars (nivel empresa)
      .mockResolvedValueOnce([[]]);                       // exceptionsInRange(cal 20)
    const r = await svc.resolveEffectiveByScope({ company_id: null, branch_id: 5 }, '2026-01-05', '2026-01-05');
    // Antes: sin company derivada, el nivel empresa nunca matcheaba → global/ninguno.
    expect(r.days[0].calendar_id).toBe(20);
    // La consulta de calendarios recibió la empresa derivada (9) en el filtro.
    const loadCall = sequelize.query.mock.calls.find(([sql]) => /FROM labor_calendars/i.test(String(sql)) && /branch_id IS NULL AND company_id/i.test(String(sql)));
    expect(loadCall[1].replacements).toEqual(['2026-01-05', '2026-01-05', 5, 5, 9, 9]);
  });
});

describe('pickFromCandidates — precedencia y vigencia en memoria (equivale a pickCalendarForDate)', () => {
  // Filas YA ordenadas por el SQL (sucursal > empresa > global; valid_from DESC).
  const cands = [
    { id: 30, _vf: '2026-01-01', _vt: null },        // sucursal (gana si cubre)
    { id: 20, _vf: '2026-01-01', _vt: null },        // empresa
    { id: 10, _vf: '2026-01-01', _vt: null },        // global
  ];
  test('elige la de mayor especificidad que cubre la fecha', () => {
    expect(svc.pickFromCandidates(cands, '2026-06-10').id).toBe(30);
  });
  test('si la más específica no cubre la fecha, cae a la siguiente', () => {
    const c = [
      { id: 30, _vf: '2026-07-01', _vt: null },      // sucursal: empieza después
      { id: 20, _vf: '2026-01-01', _vt: null },      // empresa: cubre
      { id: 10, _vf: '2026-01-01', _vt: null },      // global
    ];
    expect(svc.pickFromCandidates(c, '2026-06-10').id).toBe(20);
  });
  test('respeta valid_to (versión vencida no aplica)', () => {
    const c = [
      { id: 30, _vf: '2026-01-01', _vt: '2026-05-31' }, // sucursal: vence antes
      { id: 20, _vf: '2026-06-01', _vt: null },         // empresa: vigente
    ];
    expect(svc.pickFromCandidates(c, '2026-06-10').id).toBe(20);
  });
  test('a igual especificidad, gana la de valid_from más reciente (orden del SQL)', () => {
    const c = [
      { id: 31, _vf: '2026-06-01', _vt: null }, // más nueva primero (DESC)
      { id: 30, _vf: '2026-01-01', _vt: null },
    ];
    expect(svc.pickFromCandidates(c, '2026-06-10').id).toBe(31);
  });
  test('ninguna cubre → null', () => {
    expect(svc.pickFromCandidates([{ id: 1, _vf: '2027-01-01', _vt: null }], '2026-06-10')).toBeNull();
    expect(svc.pickFromCandidates([], '2026-06-10')).toBeNull();
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

  test('incomplete: tabla sin NINGUNA columna de 073 → respuesta controlada (no error crudo)', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]]) // TABLES existe
      .mockResolvedValueOnce([[]]);         // COLUMNS: ninguna
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('incomplete');
    expect(r.workday).toBeNull();
    expect(r.message).toMatch(/parcialmente migrado/i);
    expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
  });

  // Conjunto COMPLETO que exige workdaySchemaState (base 072/073 + 075/phaseC).
  const FULL_COLS = [
    'schedule_id', 'valid_from', 'valid_to',
    'check_in', 'check_out', 'tolerance_in', 'tolerance_out',
    'break_mode', 'break_minutes', 'break_after_minutes',
    'weekly_target_minutes', 'daily_target_minutes',
    'work_regime', 'overtime_policy', 'rounding_policy',
    'night_start', 'night_end', 'work_days',
    'schedule_name_snapshot', 'snapshot_version', 'snapshot_source', 'change_reason',
    'overtime_policy_version', 'overtime_policy_config',
    'rounding_policy_version', 'rounding_policy_config',
  ];

  test('incomplete: 073 PARCIAL (falta daily_target_minutes) → incomplete, NO delega', async () => {
    const cols = FULL_COLS.filter((c) => c !== 'daily_target_minutes').map((name) => ({ name }));
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]]) // TABLES existe
      .mockResolvedValueOnce([cols]);       // COLUMNS incompletas
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('incomplete');
    expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
  });

  test('incomplete: 072 BASE ausente (7 de 073 presentes pero sin check_in/check_out) → incomplete', async () => {
    // Tiene las 7 columnas de 073 + phaseC pero le falta la base 072 (check_in/out…).
    const cols = FULL_COLS.filter((c) => c !== 'check_in' && c !== 'check_out').map((name) => ({ name }));
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])
      .mockResolvedValueOnce([cols]);
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('incomplete');
    expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
  });

  test('incomplete: 075 PARCIAL (faltan metadatos phaseC) → incomplete controlado, NO error+reintento', async () => {
    // Base 072/073 completa pero sin las columnas de 075 → detección EXPLÍCITA,
    // no vía el error+reintento silencioso de loadScheduleHistory.
    const cols = FULL_COLS.filter((c) => !c.includes('policy_version') && !c.includes('policy_config')
      && c !== 'snapshot_version' && c !== 'snapshot_source' && c !== 'schedule_name_snapshot' && c !== 'change_reason')
      .map((name) => ({ name }));
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]])
      .mockResolvedValueOnce([cols]);
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('incomplete');
    expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
  });

  test('complete: TODAS las columnas (072+073+075) → delega en workdayConfig (read-only)', async () => {
    const cols = FULL_COLS.map((name) => ({ name }));
    sequelize.query
      .mockResolvedValueOnce([[{ ok: 1 }]]) // TABLES
      .mockResolvedValueOnce([cols]);       // COLUMNS completas
    const forDate = jest.fn().mockReturnValue({ source: 'employee_schedule_history', config: { check_in: '08:00:00' } });
    workdayConfig.loadWorkdayConfig.mockResolvedValueOnce({ forDate });
    const r = await svc.readWorkdayForDate(50, '2026-01-05');
    expect(r.schema_state).toBe('complete');
    expect(r.workday.source).toBe('employee_schedule_history');
  });

  test('fecha civil imposible (2026-02-30) → 400 INVALID_DATE sin tocar el esquema', async () => {
    await expect(svc.readWorkdayForDate(50, '2026-02-30')).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('createCalendar — fechas civiles reales', () => {
  test('rechaza fecha imposible (2026-02-30) → 400 INVALID_DATE', async () => {
    await expect(svc.createCalendar({ code: 'X', name: 'x', valid_from: '2026-02-30' }, null))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
  });
  test('rechaza vigencia invertida real → 400 INVALID_VALIDITY', async () => {
    await expect(svc.createCalendar({ code: 'X', name: 'x', valid_from: '2026-05-01', valid_to: '2026-01-01' }, null))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_VALIDITY' });
  });
});

describe('validateCalendarRefs — alcance (no crear calendario global con scope)', () => {
  const SCOPED = { unrestricted: false, companyIds: [9], branchIds: [2] };

  test('★ rol con alcance + global (company_id null, branch_id null) → 403 OUT_OF_SCOPE', async () => {
    await expect(svc.validateCalendarRefs(SCOPED, {}))
      .rejects.toMatchObject({ status: 403, code: 'OUT_OF_SCOPE' });
    // La guarda es previa a cualquier consulta.
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('rol global (unrestricted) SÍ puede crear un calendario global', async () => {
    await expect(svc.validateCalendarRefs({ unrestricted: true }, {})).resolves.toBeUndefined();
  });
});
