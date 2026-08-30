// Tests de la serialización por fecha del recálculo de daily_summary.
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (cb) => cb('TX')); // ejecuta el cuerpo con un token de transacción
jest.mock('../src/config/database', () => ({
  sequelize: { query: (...a) => mockQuery(...a), transaction: (...a) => mockTransaction(...a) },
}));

const { withDayRecalcLock, keyFor, dayBounds } = require('../src/services/recalcLock');

const deadlockErr = () => Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });

// Por defecto GET_LOCK se toma (ok:1); el resto devuelve vacío. Un test lo
// sobrescribe para simular que el lock NO se toma.
function wireLockOk() {
  mockQuery.mockImplementation(async (sql) => {
    if (/GET_LOCK/i.test(sql)) return [[{ ok: 1 }]];
    return [[]];
  });
}
beforeEach(() => { mockQuery.mockReset(); mockTransaction.mockClear(); wireLockOk(); });

describe('dayBounds (rango sargable)', () => {
  test('devuelve [inicio, díaSiguiente) del día', () => {
    expect(dayBounds('2026-07-28')).toEqual({ start: '2026-07-28 00:00:00', next: '2026-07-29 00:00:00' });
  });
  test('cruza fin de mes correctamente', () => {
    expect(dayBounds('2026-07-31')).toEqual({ start: '2026-07-31 00:00:00', next: '2026-08-01 00:00:00' });
  });
  test('keyFor produce una clave por fecha estable', () => {
    expect(keyFor('2026-07-28')).toBe('sishoras:recalc:2026-07-28');
  });
});

describe('withDayRecalcLock', () => {
  test('toma GET_LOCK, ejecuta fn(t) y libera con RELEASE_LOCK (orden correcto)', async () => {
    const fn = jest.fn(async (t) => { expect(t).toBe('TX'); });
    const { retries } = await withDayRecalcLock('2026-07-28', fn);

    expect(retries).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);

    const sqls = mockQuery.mock.calls.map(c => c[0]);
    const getIdx = sqls.findIndex(s => /GET_LOCK/i.test(s));
    const relIdx = sqls.findIndex(s => /RELEASE_LOCK/i.test(s));
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(relIdx).toBeGreaterThan(getIdx); // libera DESPUÉS de trabajar

    // La clave del lock corresponde a la fecha.
    const getCall = mockQuery.mock.calls.find(c => /GET_LOCK/i.test(c[0]));
    expect(getCall[1].replacements[0]).toBe('sishoras:recalc:2026-07-28');
  });

  test('libera el lock SIEMPRE, aunque fn lance un error no-reintentable', async () => {
    const boom = Object.assign(new Error('columna inválida'), { errno: 1054 });
    const fn = jest.fn(async () => { throw boom; });
    await expect(withDayRecalcLock('2026-07-28', fn)).rejects.toThrow(/columna inválida/);
    // RELEASE_LOCK debió ejecutarse en el finally pese al fallo.
    expect(mockQuery.mock.calls.some(c => /RELEASE_LOCK/i.test(c[0]))).toBe(true);
  });

  test('reintenta ante deadlock: nueva transacción y devuelve retries>0', async () => {
    let calls = 0;
    const fn = jest.fn(async () => { calls++; if (calls < 2) throw deadlockErr(); });
    const { retries } = await withDayRecalcLock('2026-07-28', fn);
    expect(calls).toBe(2);
    expect(retries).toBe(1);
    expect(mockTransaction).toHaveBeenCalledTimes(2); // cada intento = transacción nueva
    // Cada intento libera su propio lock.
    const releases = mockQuery.mock.calls.filter(c => /RELEASE_LOCK/i.test(c[0]));
    expect(releases.length).toBe(2);
  });

  test('si GET_LOCK NO se toma (0), NO ejecuta fn: reintenta y termina fallando', async () => {
    // Otro proceso tiene el lock (timeout → 0). Ejecutar fn sin el lock reabriría
    // la carrera de escritura, así que NO se ejecuta: se reintenta (lock-wait) y,
    // al agotarse, se propaga el error en vez de recalcular desprotegido.
    mockQuery.mockImplementation(async (sql) => {
      if (/GET_LOCK/i.test(sql)) return [[{ ok: 0 }]];
      return [[]];
    });
    const fn = jest.fn(async () => {});
    await expect(withDayRecalcLock('2026-07-28', fn)).rejects.toThrow(/no se pudo tomar el lock/i);
    expect(fn).not.toHaveBeenCalled();                 // nunca corre sin el lock
    expect(mockTransaction).toHaveBeenCalledTimes(3);  // 3 intentos (retries por defecto)
  });

  test('si GET_LOCK devuelve NULL (error interno) tampoco ejecuta fn', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/GET_LOCK/i.test(sql)) return [[{ ok: null }]];
      return [[]];
    });
    const fn = jest.fn(async () => {});
    await expect(withDayRecalcLock('2026-07-28', fn)).rejects.toThrow(/no se pudo tomar el lock/i);
    expect(fn).not.toHaveBeenCalled();
  });
});
