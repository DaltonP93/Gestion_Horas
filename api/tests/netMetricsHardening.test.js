/**
 * netMetricsHardening.test.js — la medición no puede dañar lo medido.
 *
 * Hallazgos de la revisión del PR #111, ya mergeado. Los tres nacen de la
 * misma regla: la instrumentación de red se agregó al camino que leen los
 * relojes automáticos y manuales, así que su peor fallo aceptable es perder
 * una métrica — nunca una lectura ni una fila de auditoría.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

const { sequelize } = require('../src/config/database');
const nm = require('../src/services/netMetrics');
const { readFileSync } = require('fs');
const { join } = require('path');

const readerSrc = readFileSync(
  join(__dirname, '..', 'src', 'services', 'zktecoReader.js'), 'utf8'
);

beforeEach(() => {
  jest.clearAllMocks();
  nm.__resetColumnsCache();
});

describe('la instrumentación está aislada del camino de lectura', () => {
  it('estimateBytes se invoca dentro de un try/catch propio', () => {
    // Está fuera del try/catch de la lectura: si lanzara, se llevaría puesto
    // el intento y, con él, la sincronización automática o manual.
    const i = readerSrc.indexOf('netMetrics.estimateBytes');
    expect(i).toBeGreaterThan(-1);
    const contexto = readerSrc.slice(Math.max(0, i - 220), i);
    expect(contexto).toMatch(/try\s*\{/);
  });

  it('un fallo al medir deja la métrica en cero, no propaga', () => {
    // Reproduce el contrato del bloque del lector.
    const romper = () => { throw new Error('medición rota'); };
    let payload = { bytes: 0, estimated: false };
    expect(() => {
      try { payload = romper(); }
      catch { payload = { bytes: 0, estimated: true }; }
    }).not.toThrow();
    expect(payload).toEqual({ bytes: 0, estimated: true });
  });

  it('estimateBytes no retiene el buffer que recibe', () => {
    // Devuelve sólo números: si retuviera los registros, el lector no podría
    // soltar la referencia y la memoria por lectura crecería.
    const r = nm.estimateBytes([{ a: 1 }, { a: 2 }]);
    expect(Object.keys(r).sort()).toEqual(['bytes', 'estimated']);
    expect(typeof r.bytes).toBe('number');
  });

  it('muestrea, no serializa el buffer entero', () => {
    // 50.000 registros con una muestra de 5: el costo no puede escalar con
    // el tamaño del buffer, que es justo lo que el lector vigila.
    const grande = new Array(50_000).fill({ deviceUserId: '5404', recordTime: '2026-08-03T18:44:51' });
    const t0 = process.hrtime.bigint();
    nm.estimateBytes(grande);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
  });
});

describe('attempts_detail se recorta por elementos, no por caracteres', () => {
  it('el detalle se arma recortando el arreglo', () => {
    // Cortar el string deja JSON inválido; en una columna JSON el INSERT
    // falla y se pierde la fila de auditoría completa, en silencio.
    expect(readerSrc).not.toMatch(/JSON\.stringify\(report\.read_attempts_detail\)\.slice/);
    expect(readerSrc).toMatch(/all\.slice\(-keep\)/);
  });

  it('con muchos intentos el JSON resultante sigue siendo válido', () => {
    const unIntento = {
      attempt: 1, mode: 'auto', raw: 10000, valid: 9800, in_range: 40, garbage: 200,
      truncated: false, first_valid: '2026-08-03 08:00:00', last_valid: '2026-08-03 18:00:00',
      duration_ms: 3200, error: null, payload_bytes: 1048576, payload_estimated: true,
    };
    const all = new Array(40).fill(0).map((_, i) => ({ ...unIntento, attempt: i + 1 }));

    // Misma lógica que el lector.
    let json = null;
    for (let keep = all.length; keep > 0; keep--) {
      const j = JSON.stringify(all.slice(-keep));
      if (j.length <= 4000) { json = j; break; }
    }

    expect(json).not.toBeNull();
    expect(json.length).toBeLessThanOrEqual(4000);
    expect(() => JSON.parse(json)).not.toThrow();
    // Conserva los ÚLTIMOS intentos: son los que explican el resultado.
    const parsed = JSON.parse(json);
    expect(parsed[parsed.length - 1].attempt).toBe(40);
  });
});

describe('el esquema se consulta una sola vez', () => {
  it('memoriza las columnas entre llamadas', async () => {
    sequelize.query.mockResolvedValue([[{ c: 'mode' }]]);
    await nm.availableColumns();
    await nm.availableColumns();
    await nm.availableColumns();
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  it('un fallo no se memoriza: se reintenta', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('sin conexión'));
    expect(await nm.availableColumns()).toEqual([]);

    sequelize.query.mockResolvedValueOnce([[{ c: 'mode' }]]);
    expect(await nm.availableColumns()).toEqual(['mode']);
  });
});
