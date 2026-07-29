/**
 * Benchmark de memoria de la lectura multi-intento (readAttendancesStable).
 *
 * Reproduce Comedor: ~82.000 registros por intento y varios intentos. Verifica
 * que NO se retengan los buffers de TODOS los intentos (sólo la mejor lectura),
 * que el resultado funcional no cambie y que la memoria no crezca de forma
 * monotónica entre ciclos. Usa el inyector `_readOnce` (no toca hardware).
 */
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const { readAttendancesStable } = require('../src/services/zktecoReader');

const N = 82000;
const FILLER = 'x'.repeat(180); // marca "pesada" para que un dataset sea ~decenas de MB
const device = { id: 1, name: 'Comedor', connection_mode: 'auto' };

function makeDataset(n = N, base = Date.UTC(2026, 6, 28, 8, 0, 0)) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = { deviceUserId: String((i % 300) + 1), recordTime: new Date(base + i * 1000).toISOString(), _filler: FILLER };
  }
  return arr;
}
const heap = () => process.memoryUsage().heapUsed;

describe('readAttendancesStable — memoria', () => {
  test('elige la mejor lectura; el detail no retiene arreglos de logs', async () => {
    const sizes = [70000, 82000, 60000, 82000];
    const res = await readAttendancesStable(device, {
      attempts: 4,
      _readOnce: async (i) => ({ data: makeDataset(sizes[i]), err: 'TIMEOUT' }), // truncado → corren los 4
    });
    expect(res.attempts).toBe(4);
    expect(res.detail).toHaveLength(4);
    for (const d of res.detail) expect(d).not.toHaveProperty('logs'); // metadatos, sin buffers
    expect(res.logs.length).toBe(82000);           // best = primera con 82000 válidas
    expect(res.valids).toEqual(sizes);
  });

  test('early-stop: una lectura completa que cubre el rango corta los intentos', async () => {
    let calls = 0;
    const res = await readAttendancesStable(device, {
      attempts: 5,
      _readOnce: async () => { calls++; return { data: makeDataset(1000) }; }, // NO truncado → cubre
    });
    expect(calls).toBe(1);
    expect(res.attempts).toBe(1);
    expect(res.logs.length).toBe(1000);
  });

  test('el resultado retiene SÓLO la mejor lectura, aunque haya muchos intentos', async () => {
    // Con 6 intentos truncados de 82.000, el objeto devuelto NO acumula los 6
    // buffers: expone un único arreglo grande (best.logs). Determinista (no GC).
    const sizes = [70000, 82000, 60000, 79000, 81000, 55000]; // best = attempt 1
    const res = await readAttendancesStable(device, {
      attempts: 6,
      _readOnce: async (i) => ({ data: makeDataset(sizes[i]), err: 'TIMEOUT' }),
    });
    expect(res.attempts).toBe(6);
    expect(res.logs.length).toBe(82000);
    const bigArrays = Object.values(res).filter(v => Array.isArray(v) && v.length > 1000);
    expect(bigArrays).toHaveLength(1);                 // sólo res.logs, no los 6
    for (const d of res.detail) expect(Object.values(d).some(v => Array.isArray(v))).toBe(false);
    expect(res.valids).toEqual(sizes);                 // metadatos numéricos de todos
  });

  test('la memoria no crece de forma monotónica entre ciclos', async () => {
    // Guardia anti-fuga entre ciclos: neither versión retiene datasets entre
    // corridas, así que el crecimiento total queda acotado (con GC forzado si
    // está disponible; si no, el GC natural reclama los datasets descartados).
    const samples = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      // eslint-disable-next-line no-await-in-loop
      await readAttendancesStable(device, {
        attempts: 3,
        _readOnce: async () => ({ data: makeDataset(N), err: 'TIMEOUT' }),
      });
      if (typeof global.gc === 'function') global.gc();
      samples.push(heap());
    }
    // Cota generosa: una retención cruzada real (18 datasets ≈ cientos de MB)
    // superaría ampliamente este límite; el GC natural mantiene el heap acotado.
    const growth = samples[samples.length - 1] - samples[0];
    expect(growth).toBeLessThan(200 * 1048576);
  });
});
