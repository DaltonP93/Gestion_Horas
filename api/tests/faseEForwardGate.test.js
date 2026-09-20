/**
 * faseEForwardGate.test.js — El escritor "hacia adelante" del motor exige AMBOS
 * cerrojos: env kill-switch de ops Y setting de BD fase_e_forward_enabled.
 *
 * Se prueban las 4 combinaciones: SÓLO (env true AND setting true) habilita la
 * escritura. Con cualquiera en false → fail-closed (camino legacy).
 *
 * Además se fija por inspección de fuente que los 3 puntos de conmutación
 * (recalc por marca, recalc en bloque y materializeAbsents) usan la compuerta
 * combinada, no sólo el env.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
  DB_TIMEZONE: '-03:00',
}));
jest.mock('../src/services/workdayConfig', () => ({ loadWorkdayConfig: jest.fn() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../src/services/recalcLock', () => ({
  withDayRecalcLock: jest.fn(async (_d, fn) => fn('TX')),
  dayBounds: (d) => ({ start: `${d} 00:00:00`, next: `${d} 00:00:00` }),
}));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');
const { withDayRecalcLock } = require('../src/services/recalcLock');
const svc = require('../src/services/workdaySummaryService');

const ENV = 'WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED';
const orig = process.env[ENV];

afterEach(() => {
  if (orig === undefined) delete process.env[ENV];
  else process.env[ENV] = orig;
  sequelize.query.mockReset();
  audit.log.mockClear();
  withDayRecalcLock.mockClear();
});

/** Programa ambos settings de BD: gate forward + cutover. */
function conSetting(value, cutover) {
  if (arguments.length < 2) cutover = '2026-09-16';
  sequelize.query.mockImplementation(async (sql, opt) => {
    if (/system_settings/i.test(sql)) {
      const key = opt?.replacements?.[0];
      if (key === svc.FORWARD_SETTING_KEY) return [value === undefined ? [] : [{ value }]];
      if (key === svc.CUTOVER_SETTING_KEY) return [cutover === undefined ? [] : [{ value: cutover }]];
    }
    return [[]];
  });
}

describe('isEngineForwardWriteEnabled — 4 combinaciones', () => {
  test('env OFF + setting OFF → false', async () => {
    delete process.env[ENV];
    conSetting('false');
    expect(await svc.isEngineForwardWriteEnabled()).toBe(false);
  });

  test('env OFF + setting ON → false (corto-circuito, ni lee BD)', async () => {
    delete process.env[ENV];
    conSetting('true');
    expect(await svc.isEngineForwardWriteEnabled()).toBe(false);
    // Corto-circuito: con env OFF no se consulta system_settings.
    const consultó = sequelize.query.mock.calls.some((c) => /system_settings/i.test(c[0]));
    expect(consultó).toBe(false);
  });

  test('env ON + setting OFF → false', async () => {
    process.env[ENV] = 'true';
    conSetting('false');
    expect(await svc.isEngineForwardWriteEnabled()).toBe(false);
  });

  test('env ON + setting ON → true (ÚNICA combinación que escribe)', async () => {
    process.env[ENV] = 'true';
    conSetting('true');
    expect(await svc.isEngineForwardWriteEnabled()).toBe(true);
  });
});

describe('cutover guard — fail-closed e histórico inmutable', () => {
  test('ambos gates ON pero cutover ausente/inválido → writer nuevo OFF', async () => {
    process.env[ENV] = 'true';
    conSetting('true', undefined);
    expect(await svc.isEngineForwardWriteEnabled()).toBe(false);
    conSetting('true', '2026-02-30');
    expect(await svc.isEngineForwardWriteEnabled()).toBe(false);
  });

  test('fecha anterior al cutover se bloquea y audita; no toma lock de escritura', async () => {
    delete process.env[ENV];
    conSetting('false', '2026-09-16');
    const g = await svc.guardAutomaticSummaryDate('2026-09-15', { employeeId: 7, context: 'test' });
    expect(g).toMatchObject({ allowed: false, reason: 'before_cutover', cutoverDate: '2026-09-16' });
    expect(audit.log).toHaveBeenCalledTimes(1);

    await svc.applyResolvedRows(7, [{
      date: '2026-09-15', status: 'present', workday_count: 1,
      first_in: null, last_out: null, worked_minutes: 0, break_minutes: 0,
      overtime_minutes: 0, late_minutes: 0, notes: null,
    }]);
    expect(withDayRecalcLock).not.toHaveBeenCalled();
  });

  test('sin cutover y con ambos gates ON no cae silenciosamente al legacy', async () => {
    process.env[ENV] = 'true';
    conSetting('true', undefined);
    const g = await svc.guardAutomaticSummaryDate('2026-09-20', { context: 'test' });
    expect(g).toMatchObject({ allowed: false, reason: 'cutover_missing' });
  });

  test('antes del rollout, sin cutover y gate BD OFF, el legacy sigue permitido', async () => {
    delete process.env[ENV];
    conSetting('false', undefined);
    const g = await svc.guardAutomaticSummaryDate('2026-09-20', { context: 'test' });
    expect(g).toMatchObject({ allowed: true, reason: 'pre_cutover_legacy' });
  });
});

describe('isForwardSettingEnabled — fail-closed', () => {
  test('fila ausente → false', async () => {
    conSetting(undefined);
    expect(await svc.isForwardSettingEnabled()).toBe(false);
  });
  test("sólo el string exacto 'true' habilita (no '1')", async () => {
    conSetting('1');
    expect(await svc.isForwardSettingEnabled()).toBe(false);
    conSetting('true');
    expect(await svc.isForwardSettingEnabled()).toBe(true);
  });
  test('error de lectura (tabla ausente) → false, no propaga', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('no such table'));
    expect(await svc.isForwardSettingEnabled()).toBe(false);
  });
});

describe('el env sigue siendo el kill-switch de ops (no togglable por request)', () => {
  test('isEngineSummaryWriteEnabled sólo mira el env', () => {
    delete process.env[ENV];
    expect(svc.isEngineSummaryWriteEnabled()).toBe(false);
    process.env[ENV] = 'true';
    expect(svc.isEngineSummaryWriteEnabled()).toBe(true);
  });
});

describe('wiring: los 3 puntos de conmutación usan la compuerta combinada', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'controllers', 'attendanceController.js'), 'utf8');
  const scheduler = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'services', 'scheduler.js'), 'utf8');
  const processing = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'services', 'processing.js'), 'utf8');

  test('recalcDailySummary (por marca) espera la compuerta doble', () => {
    expect(controller).toMatch(/await\s+workdaySummary\.isEngineForwardWriteEnabled\(\)/);
  });
  test('bulkRecalc y materializeAbsents usan la compuerta doble (2 usos)', () => {
    const usos = (scheduler.match(/isEngineForwardWriteEnabled\(\)/g) || []).length;
    expect(usos).toBeGreaterThanOrEqual(2);
  });
  test('ningún camino automático conocido omite el CUTOVER GUARD', () => {
    expect(controller).toMatch(/guardAutomaticSummaryDate\(/);
    expect((scheduler.match(/guardAutomaticSummaryDate\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(processing).toMatch(/guardAutomaticSummaryDate\(/);
  });
});
