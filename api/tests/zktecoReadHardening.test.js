'use strict';

/**
 * zktecoReadHardening.test.js — Endurecimiento OFFLINE de la lectura ZKTeco.
 *
 * Reproduce, con un harness de transporte simulado (tests/helpers/mockZkClient),
 * el escenario reportado (getInfo() OK / getAttendances() con
 * TIMEOUT_ON_WRITING_MESSAGE) y BLINDA los invariantes de seguridad de datos:
 *
 *   1. Un fallo de lectura NUNCA inventa marcaciones (no inserta en
 *      attendance_logs ni raw_device_punches; no toca last_sync).
 *   2. Un fallo de lectura NUNCA se registra como sync 'success' en
 *      device_sync_runs: queda 'timeout' (o 'error').
 *   3. La lectura estable propaga el fallo (no devuelve marcas fabricadas) y
 *      reconoce el buffer truncado.
 *   4. El diagnóstico da una recomendación accionable para TIMEOUT_ON_WRITING.
 *
 * Sin red ni dispositivos reales: la lectura física se inyecta por el seam
 * `_readOnce`. La base se mockea para observar (no ejecutar) el SQL.
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn((sql) => {
    const s = String(sql);
    if (/information_schema\.TABLES/i.test(s)) return Promise.resolve([[{ n: 1 }]]);     // device_sync_runs existe
    if (/information_schema\.COLUMNS/i.test(s)) return Promise.resolve([[]]);            // sin columnas extra
    return Promise.resolve([[]]);
  });
  return { sequelize: { query } };
});
// deviceLock no se usa con lock:false, pero su módulo requiere config/database.
jest.mock('../src/config/logger', () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }));

const { sequelize } = require('../src/config/database');
const reader = require('../src/services/zktecoReader');
const { makeMockZk, punch } = require('./helpers/mockZkClient');

const DEVICE = { id: 7, name: 'Reloj Test', ip_address: '10.0.0.9', port: 4370, connection_mode: 'auto' };
const TIMEOUT_MSG = 'TIMEOUT_ON_WRITING_MESSAGE';

afterEach(() => jest.clearAllMocks());

function findInsert(table) {
  return sequelize.query.mock.calls.find(([sql]) => new RegExp(`INSERT\\s+(IGNORE\\s+)?INTO\\s+${table}`, 'i').test(String(sql)));
}
function anyQueryMatches(re) {
  return sequelize.query.mock.calls.some(([sql]) => re.test(String(sql)));
}

describe('readAttendancesStable — propaga el fallo, no fabrica marcas', () => {
  test('getAttendances TIMEOUT_ON_WRITING en todos los intentos → rechaza (sin logs)', async () => {
    const mock = makeMockZk({ failAttendances: TIMEOUT_MSG });
    await expect(
      reader.readAttendancesStable(DEVICE, { attempts: 2, cooldownMs: 0, _readOnce: () => mock.getAttendances() }),
    ).rejects.toThrow(/TIMEOUT_ON_WRITING/);
  });

  test('lectura OK → devuelve las marcas leídas (no inventadas)', async () => {
    const marks = [punch(1001, '2026-01-05T08:00:00'), punch(1001, '2026-01-05T17:00:00')];
    const mock = makeMockZk({ attendances: marks });
    const r = await reader.readAttendancesStable(DEVICE, { attempts: 1, _readOnce: () => mock.getAttendances() });
    expect(r.logs).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  test('buffer truncado → marca truncated=true (lectura incompleta, no completa)', async () => {
    const mock = makeMockZk({ attendances: [punch(1001, '2026-01-05T08:00:00')], truncated: true });
    const r = await reader.readAttendancesStable(DEVICE, { attempts: 1, _readOnce: () => mock.getAttendances() });
    expect(r.truncated).toBe(true);
  });
});

describe('backupDeviceDirect — un fallo de lectura no inventa marcaciones ni marca éxito', () => {
  test('TIMEOUT_ON_WRITING: rechaza, CERO inserts de marcas, sync run = timeout', async () => {
    const mock = makeMockZk({ info: { userCounts: 3 }, failAttendances: TIMEOUT_MSG });
    // getInfo() del harness responde OK; sólo falla la lectura de marcas.
    await expect(mock.getInfo()).resolves.toBeTruthy();

    await expect(
      reader.backupDeviceDirect(DEVICE, {
        lock: false, dryRun: false, attempts: 1,
        _readOnce: () => mock.getAttendances(),
      }),
    ).rejects.toThrow(/TIMEOUT_ON_WRITING/);

    // (1) NO inventa marcaciones: ningún INSERT de marcas ni UPDATE de last_sync.
    expect(anyQueryMatches(/INSERT\s+(IGNORE\s+)?INTO\s+attendance_logs/i)).toBe(false);
    expect(anyQueryMatches(/INSERT\s+(IGNORE\s+)?INTO\s+raw_device_punches/i)).toBe(false);
    expect(anyQueryMatches(/UPDATE\s+devices\s+SET\s+last_sync/i)).toBe(false);

    // (2) NO marca éxito: la corrida se auditó como 'timeout'.
    const insert = findInsert('device_sync_runs');
    expect(insert).toBeTruthy();
    const statusValue = insert[1].replacements[3]; // cols: device_id, started_at, finished_at, status, …
    expect(statusValue).toBe('timeout');
  });
});

describe('recordSyncRun — el estado nunca es success ante un fallo', () => {
  const base = { startedAt: new Date('2026-01-05T08:00:00Z'), opts: { attempts: 1 } };
  const statusOf = () => findInsert('device_sync_runs')[1].replacements[3];

  test('error de timeout → status timeout', async () => {
    await reader.recordSyncRun(DEVICE, { ...base, error: new Error('lectura del reloj: TIMEOUT_ON_WRITING_MESSAGE') });
    expect(statusOf()).toBe('timeout');
  });

  test('error genérico → status error', async () => {
    await reader.recordSyncRun(DEVICE, { ...base, error: new Error('ECONNREFUSED 10.0.0.9:4370') });
    expect(statusOf()).toBe('error');
  });

  test('reporte de lectura parcial → status partial (no success)', async () => {
    await reader.recordSyncRun(DEVICE, { ...base, report: { partial: true, total_read: 5, imported: 0 } });
    expect(statusOf()).toBe('partial');
  });

  test('reporte de lectura completa → status success', async () => {
    await reader.recordSyncRun(DEVICE, { ...base, report: { partial: false, total_read: 5, imported: 5 } });
    expect(statusOf()).toBe('success');
  });

  test('recordSyncRun sólo escribe en device_sync_runs (nunca en attendance_logs)', async () => {
    await reader.recordSyncRun(DEVICE, { ...base, error: new Error(TIMEOUT_MSG) });
    expect(anyQueryMatches(/INSERT\s+(IGNORE\s+)?INTO\s+attendance_logs/i)).toBe(false);
    expect(findInsert('device_sync_runs')).toBeTruthy();
  });
});

describe('diagnóstico — recomendación accionable', () => {
  test('TIMEOUT_ON_WRITING sugiere cerrar Attendance Management, puerto 4370 y probar TCP/UDP', () => {
    const rec = reader.recommendationFor(TIMEOUT_MSG);
    expect(rec).toMatch(/Attendance Management/i);
    expect(rec).toMatch(/4370/);
    expect(rec).toMatch(/TCP|UDP/);
  });
});
