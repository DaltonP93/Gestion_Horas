/**
 * marcadasMemory.test.js — Que el reporte no retenga memoria entre corridas.
 *
 * ¿POR QUÉ UN TEST Y NO SÓLO EL SCRIPT?
 *
 * `scripts/benchmark-marcadas-memory.js` mide contra la base real y es la
 * herramienta para el servidor. Pero necesita producción, así que no corre en
 * CI, y el defecto que importa —memoria que queda retenida entre peticiones—
 * es exactamente el que se reintroduce sin que nadie lo note.
 *
 * Este test usa la base mockeada con un dataset sintético grande y verifica la
 * propiedad estructural: correr el reporte N veces no puede dejar el heap
 * creciendo de forma monótona.
 *
 * MEDIR RETENCIÓN NECESITA GC DETERMINISTA
 *
 * Sin recolección forzada, el heap puede subir corrida tras corrida sin que
 * haya fuga: es sólo GC perezoso que todavía no corrió. En CI, que no lanza
 * node con `--expose-gc`, `global.gc` es undefined y esa deriva hacía flaquear
 * el test —cinco lecturas crecientes por casualidad—. Acá se habilita el GC
 * PROGRAMÁTICAMENTE, así la medición es la misma corra como corra el runner:
 * lo que quede después de un `gc()` explícito sí es retención.
 *
 * LO QUE ESTE TEST NO ES
 *
 * No es una medición del consumo en producción, y no pretende serlo: acá no
 * hay driver de MySQL, ni buffers del socket, ni PDFKit. El RSS de este
 * proceso no dice nada sobre el RSS del API. Lo único que se afirma es la
 * ausencia de RETENCIÓN en el código del reporte, que es la parte que sí se
 * puede aislar. La magnitud se mide con el script, contra la base.
 */

const v8 = require('v8');
const vm = require('vm');

// Habilita `gc()` sin depender de que node se haya lanzado con --expose-gc.
// Es el mecanismo estándar para tests de memoria deterministas.
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc');

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/workdayConfig', () => ({
  loadWorkdayConfig: jest.fn(async () => ({ forDate: () => null, historyFor: () => [] })),
}));

const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');
const engine = require('../src/services/workdayEngine');

const EMPLEADOS = 120;
const DIAS = 60;

/** Padrón sintético. */
function padron() {
  return Array.from({ length: EMPLEADOS }, (_, i) => ({
    employee_id: i + 1,
    employee_name: `Empleado ${i + 1}`,
    code: String(3000 + i),
    department: 'Operaciones',
  }));
}

/** Cuatro marcajes por empleado y día: entrada, almuerzo, vuelta, salida. */
function marcajesDe(ids) {
  const out = [];
  let id = 1;
  for (const employee_id of ids) {
    let abs = engine.toWall('2024-12-01 08:00:00').abs;
    for (let d = 0; d < DIAS; d++) {
      out.push({ id: id++, employee_id, timestamp: engine.absToDateTime(abs), type: 'in' });
      out.push({ id: id++, employee_id, timestamp: engine.absToDateTime(abs + 4 * 3600), type: 'out' });
      out.push({ id: id++, employee_id, timestamp: engine.absToDateTime(abs + 5 * 3600), type: 'in' });
      out.push({ id: id++, employee_id, timestamp: engine.absToDateTime(abs + 9 * 3600), type: 'out' });
      abs += 86400;
    }
  }
  return out;
}

function mockBase() {
  sequelize.query.mockReset();
  sequelize.query.mockImplementation(async (sql, opts) => {
    if (/FROM employees/.test(sql)) return [padron()];
    if (/FROM attendance_logs/.test(sql)) {
      // El lote pide sus ids: los placeholders del IN menos los dos del rango.
      const ids = (opts.replacements || []).slice(0, -2);
      return [marcajesDe(ids)];
    }
    return [[]];
  });
}

const heap = () => process.memoryUsage().heapUsed;

/** Da lugar a que el GC asíncrono corra antes de medir. */
const respirar = () => new Promise((r) => setTimeout(r, 30));

describe('memoria del reporte de Marcadas', () => {
  beforeEach(mockBase);

  test('procesa un dataset grande sin desbordar ni degradarse', async () => {
    const { data } = await generateMarcadasReport({ dateFrom: '2024-12-01', dateTo: '2025-01-29' });
    expect(data).toHaveLength(EMPLEADOS);
    // Cada empleado tiene DIAS jornadas de 8 h (dos tramos de 4).
    expect(data[0].rows).toHaveLength(DIAS);
    expect(data[0].rows[0].total).toBe('8:00');
    expect(data[0].total_hm).toBe(`${DIAS * 8}:00`);
  }, 60000);

  test('cinco corridas seguidas no dejan el heap creciendo de forma monótona', async () => {
    // Dos corridas de calentamiento: las primeras inflan el heap con código
    // compilado y cachés de módulo que no son retención del reporte.
    for (let i = 0; i < 2; i++) {
      await generateMarcadasReport({ dateFrom: '2024-12-01', dateTo: '2025-01-29' });
    }
    forceGc();
    await respirar();

    const enReposo = [];
    for (let i = 0; i < 5; i++) {
      await generateMarcadasReport({ dateFrom: '2024-12-01', dateTo: '2025-01-29' });
      forceGc();
      await respirar();
      enReposo.push(heap());
    }

    // Con GC forzado entre corridas, lo que queda es retención real. La firma
    // es crecer SIEMPRE y por un margen que no se explica por ruido: 32 MB
    // sobre 120 empleados x 60 días. Un reporte que retiene su dataset dejaría
    // bastante más que eso por corrida.
    const siempreCrece = enReposo.every((v, i) => i === 0 || v > enReposo[i - 1]);
    const crecimientoTotal = enReposo[enReposo.length - 1] - enReposo[0];

    expect(siempreCrece && crecimientoTotal > 32 * 1048576).toBe(false);
  }, 120000);

  test('el resultado no conserva referencias a los marcajes crudos', async () => {
    // La retención más fácil de introducir sin querer: dejar el array de logs
    // colgando del objeto devuelto. Entonces la respuesta —que el router
    // mantiene viva hasta serializarla— arrastra todo el dataset intermedio.
    const { data } = await generateMarcadasReport({ dateFrom: '2024-12-01', dateTo: '2024-12-31' });
    const serializado = JSON.stringify(data[0]);
    expect(serializado).not.toMatch(/attendance_logs/);
    expect(data[0]).not.toHaveProperty('logs');
    expect(data[0]).not.toHaveProperty('punches');
    expect(data[0].rows[0]).not.toHaveProperty('marks');
  }, 60000);

  test('el tope por lote falla con un mensaje accionable en vez de morir por OOM', async () => {
    sequelize.query.mockReset();
    sequelize.query.mockImplementation(async (sql) => {
      if (/FROM employees/.test(sql)) return [padron().slice(0, 1)];
      if (/FROM attendance_logs/.test(sql)) {
        // Simula un lote desmesurado sin materializar 400.001 objetos reales.
        const falso = { length: 400001 };
        return [Object.assign(Object.create(Array.prototype), falso)];
      }
      return [[]];
    });

    await expect(
      generateMarcadasReport({ dateFrom: '2020-01-01', dateTo: '2026-12-31' }),
    ).rejects.toThrow(/demasiados marcajes|Acotar el rango/);
  });
});
