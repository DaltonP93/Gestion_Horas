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
jest.mock('../src/services/recalcLock', () => ({
  withDayRecalcLock: jest.fn(async (_d, fn) => fn('TX')),
  dayBounds: (d) => ({ start: `${d} 00:00:00`, next: `${d} 00:00:00` }),
}));

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/workdaySummaryService');

const ENV = 'WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED';
const orig = process.env[ENV];

afterEach(() => {
  if (orig === undefined) delete process.env[ENV];
  else process.env[ENV] = orig;
  sequelize.query.mockReset();
});

/** Programa el valor del setting de BD fase_e_forward_enabled. */
function conSetting(value) {
  sequelize.query.mockImplementation(async (sql) => {
    if (/system_settings/i.test(sql)) return [value === undefined ? [] : [{ value }]];
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

  test('recalcDailySummary (por marca) espera la compuerta doble', () => {
    expect(controller).toMatch(/await\s+workdaySummary\.isEngineForwardWriteEnabled\(\)/);
  });
  test('bulkRecalc y materializeAbsents usan la compuerta doble (2 usos)', () => {
    const usos = (scheduler.match(/isEngineForwardWriteEnabled\(\)/g) || []).length;
    expect(usos).toBeGreaterThanOrEqual(2);
  });
});
