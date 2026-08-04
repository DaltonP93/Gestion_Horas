/**
 * netMetrics.test.js — línea base de consumo de red.
 *
 * Este módulo sólo mide, así que lo que importa fijar es que los números
 * sean honestos: que una estimación se declare como tal, que el ahorro
 * refleje lo que realmente se descarta, y que nada de lo que se guarda o
 * devuelve arrastre secretos ni datos personales.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

const { sequelize } = require('../src/config/database');
const nm = require('../src/services/netMetrics');

beforeEach(() => {
  jest.clearAllMocks();
  // `availableColumns` memoriza el esquema: sin esto, una prueba heredaría
  // las columnas de la anterior y la secuencia de mocks se correría.
  nm.__resetColumnsCache();
});

describe('modeFromOrigin', () => {
  it('traduce los orígenes de lock existentes', () => {
    expect(nm.modeFromOrigin('automatic')).toBe('polling_auto');
    expect(nm.modeFromOrigin('manual')).toBe('polling_manual');
  });

  it('reconoce los modos que llegarán con PUSH-first', () => {
    expect(nm.modeFromOrigin('recovery')).toBe('recovery');
    expect(nm.modeFromOrigin('push')).toBe('push');
  });

  it('sin origen no inventa un modo', () => {
    expect(nm.modeFromOrigin(null)).toBeNull();
    expect(nm.modeFromOrigin('')).toBeNull();
  });
});

describe('estimateBytes', () => {
  it('un buffer vacío no es una estimación: es cero medido', () => {
    expect(nm.estimateBytes([])).toEqual({ bytes: 0, estimated: false });
    expect(nm.estimateBytes(null)).toEqual({ bytes: 0, estimated: false });
  });

  it('si mide todos los registros el resultado es exacto', () => {
    const recs = [{ a: 1 }, { a: 2 }];
    const r = nm.estimateBytes(recs, { sample: 10 });
    expect(r.estimated).toBe(false);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('si muestrea, lo declara', () => {
    const recs = new Array(100).fill({ deviceUserId: '5404', recordTime: '2026-08-03T18:44:51' });
    const r = nm.estimateBytes(recs, { sample: 5 });
    expect(r.estimated).toBe(true);
    // Con registros homogéneos la extrapolación es la del registro × 100.
    const uno = nm.estimateBytes([recs[0]], { sample: 1 }).bytes;
    expect(r.bytes).toBe(uno * 100);
  });

  it('un registro no serializable no rompe la medición', () => {
    const circular = {};
    circular.self = circular;
    expect(() => nm.estimateBytes([circular])).not.toThrow();
  });

  it('soporta BigInt, que JSON.stringify rechaza por defecto', () => {
    expect(() => nm.estimateBytes([{ n: BigInt(9) }])).not.toThrow();
  });
});

describe('classifyErrorCode', () => {
  it.each([
    ['Timeout de lectura del reloj', 'timeout'],
    ['TIMEOUT WHEN RECEIVING PACKET', 'timeout'],
    ['buffer incompleto: lectura truncada', 'truncated'],
    ['connect ECONNREFUSED', 'unreachable'],
    ['read ECONNRESET', 'connection_reset'],
    ['Deadlock found when trying to get lock', 'db_lock'],
    ['Unauthorized: clave inválida', 'auth'],
    ['algo raro', 'other'],
  ])('%s → %s', (msg, code) => {
    expect(nm.classifyErrorCode(msg)).toBe(code);
  });

  it('sin error no hay código', () => {
    expect(nm.classifyErrorCode(null)).toBeNull();
    expect(nm.classifyErrorCode(undefined)).toBeNull();
  });

  it('acepta un Error y nunca devuelve su texto', () => {
    const e = new Error('Timeout en 10.0.0.160:4370 con clave secreta');
    const code = nm.classifyErrorCode(e);
    expect(code).toBe('timeout');
    expect(code).not.toMatch(/10\.0\.0|clave|secreta/);
  });
});

describe('estimateIncrementalSaving', () => {
  it('el caso que motiva el cambio: se lee todo el buffer para 12 nuevas', () => {
    const r = nm.estimateIncrementalSaving({
      raw_count: 10000, imported_count: 12, bytes_from_device: 1_000_000,
    });
    expect(r.useful_ratio).toBeCloseTo(0.0012, 4);
    expect(r.wasted_ratio).toBeCloseTo(0.9988, 4);
    expect(r.wasted_bytes).toBe(998800);
  });

  it('si todo lo leído es nuevo no hay desperdicio', () => {
    const r = nm.estimateIncrementalSaving({ raw_count: 50, imported_count: 50, bytes_from_device: 500 });
    expect(r.wasted_ratio).toBe(0);
    expect(r.wasted_bytes).toBe(0);
  });

  it('sin lecturas no divide por cero', () => {
    expect(nm.estimateIncrementalSaving({ raw_count: 0, imported_count: 0 }))
      .toEqual({ wasted_ratio: 0, wasted_bytes: 0, useful_ratio: 0 });
  });

  it('más importados que leídos no produce un ahorro negativo', () => {
    // Puede pasar si el recálculo suma marcas de otra fuente.
    const r = nm.estimateIncrementalSaving({ raw_count: 10, imported_count: 40 });
    expect(r.useful_ratio).toBe(1);
    expect(r.wasted_ratio).toBe(0);
  });
});

describe('aggregateRuns', () => {
  const runs = [
    { device_id: 1, device_name: 'Comedor', started_at: '2026-08-03T10:00:00Z', status: 'success',
      mode: 'polling_auto', raw_count: 1000, in_range_count: 40, imported_count: 5,
      duplicate_count: 995, unmapped_count: 0, attempts: 1, duration_ms: 3000,
      bytes_from_device: 100000, bytes_estimated: 1, error_code: null },
    { device_id: 1, device_name: 'Comedor', started_at: '2026-08-03T11:00:00Z', status: 'timeout',
      mode: 'polling_auto', raw_count: 0, in_range_count: 0, imported_count: 0,
      duplicate_count: 0, unmapped_count: 0, attempts: 3, duration_ms: 600000,
      bytes_from_device: 0, bytes_estimated: 0, error_code: 'timeout' },
    { device_id: 2, device_name: 'Gerencia', started_at: '2026-08-03T10:30:00Z', status: 'success',
      mode: 'polling_manual', raw_count: 200, in_range_count: 10, imported_count: 10,
      duplicate_count: 190, unmapped_count: 2, attempts: 1, duration_ms: 1500,
      bytes_from_device: 20000, bytes_estimated: 1, error_code: null },
  ];

  it('agrupa por reloj y suma contadores', () => {
    const { devices } = nm.aggregateRuns(runs);
    const comedor = devices.find(d => d.device_id === 1);
    expect(comedor.runs).toBe(2);
    expect(comedor.raw_count).toBe(1000);
    expect(comedor.attempts).toBe(4);
    expect(comedor.bytes_from_device).toBe(100000);
  });

  it('cuenta modos, estados y códigos de error', () => {
    const { devices } = nm.aggregateRuns(runs);
    const comedor = devices.find(d => d.device_id === 1);
    expect(comedor.modes).toEqual({ polling_auto: 2 });
    expect(comedor.statuses).toEqual({ success: 1, timeout: 1 });
    expect(comedor.error_codes).toEqual({ timeout: 1 });
  });

  it('marca el total como estimado si alguna corrida lo era', () => {
    const { devices } = nm.aggregateRuns(runs);
    expect(devices.find(d => d.device_id === 1).bytes_estimated).toBe(true);
  });

  it('ordena por consumo descendente: primero el que más gasta', () => {
    const { devices } = nm.aggregateRuns(runs);
    expect(devices[0].device_id).toBe(1);
  });

  it('calcula el ahorro por reloj y el total', () => {
    const { devices, totals } = nm.aggregateRuns(runs);
    const comedor = devices.find(d => d.device_id === 1);
    // 5 nuevas sobre 1000 leídas.
    expect(comedor.saving.wasted_ratio).toBeCloseTo(0.995, 3);
    expect(totals.raw_count).toBe(1200);
    expect(totals.imported_count).toBe(15);
    expect(totals.saving.wasted_ratio).toBeGreaterThan(0.9);
  });

  it('la duración promedio se calcula por corrida', () => {
    const { devices } = nm.aggregateRuns(runs);
    expect(devices.find(d => d.device_id === 1).avg_duration_ms).toBe(301500);
  });

  it('sin corridas devuelve estructura vacía y no explota', () => {
    expect(nm.aggregateRuns([])).toEqual({
      devices: [],
      totals: { runs: 0, raw_count: 0, imported_count: 0, bytes_from_device: 0,
                measured_runs: 0, unmeasured_runs: 0,
                saving: { wasted_ratio: 0, wasted_bytes: 0, useful_ratio: 0 } },
    });
    expect(() => nm.aggregateRuns(null)).not.toThrow();
  });

  it('una corrida sin dispositivo no se pierde', () => {
    const { devices } = nm.aggregateRuns([{ device_id: null, raw_count: 5, started_at: '2026-08-03T10:00:00Z' }]);
    expect(devices).toHaveLength(1);
    expect(devices[0].device_id).toBeNull();
  });

  it('los agregados en string de MySQL se suman como números', () => {
    const { devices } = nm.aggregateRuns([
      { device_id: 1, raw_count: '100', imported_count: '5', bytes_from_device: '2048', attempts: '2', duration_ms: '10' },
    ]);
    expect(devices[0].raw_count).toBe(100);
    expect(devices[0].bytes_from_device).toBe(2048);
  });

  it('ningún campo agregado expone datos personales', () => {
    const { devices } = nm.aggregateRuns(runs);
    const claves = Object.keys(devices[0]);
    for (const prohibida of ['employee', 'user', 'password', 'token', 'descriptor', 'payload', 'ip']) {
      expect(claves.some(k => k.toLowerCase().includes(prohibida))).toBe(false);
    }
  });
});

describe('fetchRuns', () => {
  it('funciona sin la migración aplicada: las columnas ausentes van como NULL', async () => {
    sequelize.query
      .mockResolvedValueOnce([[]])       // availableColumns: ninguna
      .mockResolvedValueOnce([[]]);      // la consulta de corridas
    await nm.fetchRuns({ from: new Date(), to: new Date() });

    const sql = sequelize.query.mock.calls[1][0];
    expect(sql).toContain('NULL AS mode');
    expect(sql).toContain('NULL AS bytes_from_device');
  });

  it('con la migración aplicada selecciona las columnas reales', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ c: 'mode' }, { c: 'bytes_from_device' },
                               { c: 'bytes_estimated' }, { c: 'error_code' }]])
      .mockResolvedValueOnce([[]]);
    await nm.fetchRuns({ from: new Date(), to: new Date() });

    const sql = sequelize.query.mock.calls[1][0];
    expect(sql).not.toContain('NULL AS mode');
  });

  it('filtra por dispositivo cuando se pide', async () => {
    sequelize.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
    await nm.fetchRuns({ from: new Date(), to: new Date(), deviceId: 3 });

    const { replacements } = sequelize.query.mock.calls[1][1];
    expect(replacements).toContain(3);
  });

  it('no selecciona ninguna columna con datos personales', async () => {
    sequelize.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
    await nm.fetchRuns({ from: new Date(), to: new Date() });

    const sql = sequelize.query.mock.calls[1][0].toLowerCase();
    for (const prohibida of ['password', 'token', 'descriptor', 'raw_payload', 'employee_id']) {
      expect(sql).not.toContain(prohibida);
    }
  });
});

describe('queueSnapshot', () => {
  it('reutiliza sync_jobs y device_locks', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ pending: '2', running: '1', oldest: new Date(Date.now() - 60000) }]])
      .mockResolvedValueOnce([[{ c: '1' }]]);
    const snap = await nm.queueSnapshot();

    expect(snap.pending).toBe(2);
    expect(snap.running).toBe(1);
    expect(snap.locks).toBe(1);
    expect(snap.oldest_pending_age_sec).toBeGreaterThanOrEqual(59);
  });

  it('si las tablas no existen devuelve ceros en vez de fallar', async () => {
    sequelize.query.mockRejectedValue(new Error('no such table'));
    await expect(nm.queueSnapshot()).resolves.toEqual({
      pending: 0, running: 0, locks: 0, oldest_pending_age_sec: null,
    });
  });
});
