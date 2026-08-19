/**
 * marcadasWorkday.test.js — El reporte de Marcadas, extremo a extremo.
 *
 * `workdayEngine.test.js` prueba el motor en aislamiento. Acá se prueba que el
 * reporte efectivamente lo USA: que los casos dorados salen por la salida real
 * de `generateMarcadasReport`, con la forma que consumen el HTML, el PDF y el
 * CSV, y no sólo por una función interna que nadie llama.
 *
 * La base está mockeada: la primera consulta devuelve el padrón, la segunda
 * los marcajes. Es la misma estructura que usa marcadasScope.test.js.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/services/workdayConfig', () => ({
  loadScheduleHistory: jest.fn(async () => new Map()),
}));

const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');

const EMP = { employee_id: 1, employee_name: 'Andina Páez', code: '3091', department: 'Recepción' };

/** Programa el padrón y los marcajes que devolverá el mock. */
function conMarcajes(timestamps) {
  sequelize.query.mockReset();
  sequelize.query
    .mockResolvedValueOnce([[EMP]])
    .mockResolvedValueOnce([timestamps.map((t) => ({ employee_id: 1, timestamp: t, type: 'unknown' }))]);
}

describe('reporte de Marcadas sobre el motor de jornada', () => {
  test('caso dorado: 01/12 18:30 → 02/12 07:04 es UNA fila del 01/12 con 12:34', async () => {
    conMarcajes(['2024-12-01 18:30:00', '2024-12-02 07:04:00']);

    const { data } = await generateMarcadasReport({ dateFrom: '2024-12-01', dateTo: '2024-12-31' });

    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(1);
    expect(data[0].rows[0].date).toBe('01/12/2024');
    expect(data[0].rows[0].dayName).toBe('Domingo');
    expect(data[0].rows[0].pairs).toEqual([{ entrada: '18:30', salida: '07:04' }]);
    expect(data[0].rows[0].total).toBe('12:34');
    expect(data[0].rows[0].crosses_midnight).toBe(true);
    expect(data[0].total_hm).toBe('12:34');
  });

  test('caso dorado: nocturno partido suma 7:00 en una sola fila', async () => {
    conMarcajes([
      '2025-03-09 21:32:00', '2025-03-10 00:05:00',
      '2025-03-10 01:02:00', '2025-03-10 05:29:00',
    ]);

    const { data } = await generateMarcadasReport({ dateFrom: '2025-03-01', dateTo: '2025-03-31' });

    expect(data[0].rows).toHaveLength(1);
    expect(data[0].rows[0].date).toBe('09/03/2025');
    expect(data[0].rows[0].pairs).toEqual([
      { entrada: '21:32', salida: '00:05' },
      { entrada: '01:02', salida: '05:29' },
    ]);
    expect(data[0].rows[0].total).toBe('7:00');
    expect(data[0].total_hm).toBe('7:00');
  });

  test('una fecha de invierno previa al 2024-10-06 conserva la hora guardada', async () => {
    // El armado anterior imprimía 07:00 y 16:00 acá, por formatear con la
    // tzdata histórica de America/Asuncion (UTC-4 en esa fecha).
    conMarcajes(['2024-08-01 08:00:00', '2024-08-01 17:00:00']);

    const { data } = await generateMarcadasReport({ dateFrom: '2024-08-01', dateTo: '2024-08-31' });

    expect(data[0].rows[0].date).toBe('01/08/2024');
    expect(data[0].rows[0].pairs).toEqual([{ entrada: '08:00', salida: '17:00' }]);
  });

  test('una marca de 00:30 en invierno no se corre al día anterior', async () => {
    // Antes: '2024-06-15 00:30:00' se mostraba 23:30 del 14/06.
    conMarcajes(['2024-06-15 00:30:00', '2024-06-15 04:30:00']);

    const { data } = await generateMarcadasReport({ dateFrom: '2024-06-01', dateTo: '2024-06-30' });

    expect(data[0].rows[0].date).toBe('15/06/2024');
    expect(data[0].rows[0].pairs[0].entrada).toBe('00:30');
  });

  test('la jornada que cierra fuera del período no se trunca ni se duplica', async () => {
    conMarcajes(['2025-12-31 22:00:00', '2026-01-01 06:00:00']);

    const dic = await generateMarcadasReport({ dateFrom: '2025-12-01', dateTo: '2025-12-31' });
    expect(dic.data[0].rows).toHaveLength(1);
    expect(dic.data[0].rows[0].total).toBe('8:00');

    conMarcajes(['2025-12-31 22:00:00', '2026-01-01 06:00:00']);
    const ene = await generateMarcadasReport({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(ene.data[0].rows).toEqual([]);
    expect(ene.data[0].total_hm).toBe('0:00');
  });

  test('el total del día excluye la pausa entre pares, como siempre lo hizo', async () => {
    conMarcajes([
      '2025-06-10 08:00:00', '2025-06-10 12:00:00',
      '2025-06-10 13:00:00', '2025-06-10 17:00:00',
    ]);

    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data[0].rows[0].total).toBe('8:00'); // 9 h de permanencia, 8 de trabajo
    expect(data[0].rows[0].pairs).toHaveLength(2);
  });

  test('un empleado sin marcajes aparece con cero, no desaparece del reporte', async () => {
    conMarcajes([]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toEqual([]);
    expect(data[0].total_minutes).toBe(0);
    expect(data[0].total_hm).toBe('0:00');
  });

  test('la jornada abierta se muestra sin inventar la salida', async () => {
    conMarcajes(['2025-06-10 08:00:00']);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data[0].rows[0].pairs).toEqual([{ entrada: '08:00', salida: '' }]);
    expect(data[0].rows[0].total).toBe('0:00');
    expect(data[0].rows[0].open).toBe(true);
  });

  test('el período por defecto es hoy y no rompe el flujo', async () => {
    conMarcajes([]);
    const out = await generateMarcadasReport({});
    expect(out.period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.period.from).toBe(out.period.to);
  });
});
