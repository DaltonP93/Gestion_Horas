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
  // Sin configuración cargada: todas las jornadas caen en historical_fallback,
  // que es el estado real mientras las migraciones 072/073 no estén aplicadas.
  loadWorkdayConfig: jest.fn(async () => ({
    forDate: () => null,
    historyFor: () => [],
  })),
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
    // La jornada pertenece al 31/12, así que en enero el empleado no tiene
    // ninguna fila y, sin filas, no aparece en el reporte.
    expect(ene.data).toEqual([]);
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

  test('un empleado activo SIN marcajes no aparece en el reporte', async () => {
    // Antes se agregaba con rows:[] y total 0, y en el PDF generaba páginas
    // vacías. Un empleado sin ninguna jornada del período no debe aparecer.
    conMarcajes([]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toEqual([]);
  });

  test('un empleado con marcajes SÓLO fuera del período (contexto) no aparece', async () => {
    // El 09/06 cae en la ventana ampliada como contexto, pero su jornada no
    // pertenece al período pedido (10/06).
    conMarcajes(['2025-06-09 08:00:00', '2025-06-09 17:00:00']);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toEqual([]);
  });

  test('una jornada que abre el último día del período SÍ aparece', async () => {
    // 31/01 IN + 01/02 OUT, reporte hasta 31/01: work_date = 31/01.
    conMarcajes(['2025-01-31 20:00:00', '2025-02-01 06:30:00']);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-01-01', dateTo: '2025-01-31' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(1);
    expect(data[0].rows[0].date).toBe('31/01/2025');
    expect(data[0].rows[0].total).toBe('10:30');
  });

  test('employeeId específico sin marcajes devuelve data vacía', async () => {
    conMarcajes([]);
    const { data } = await generateMarcadasReport({
      dateFrom: '2025-06-10', dateTo: '2025-06-10', employeeId: 1,
    });
    expect(data).toEqual([]);
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

  /** Programa el padrón y marcajes con tipo/id explícitos (para huérfanos). */
  function conMarcajesTipados(marcajes) {
    sequelize.query.mockReset();
    sequelize.query
      .mockResolvedValueOnce([[EMP]])
      .mockResolvedValueOnce([marcajes]);
  }

  test('un OUT huérfano como único marcaje NO borra al empleado del reporte', async () => {
    // Antes, buildWorkdays no generaba jornada (salida_sin_entrada queda global)
    // y el filtro de empleados vacíos lo eliminaba: un período CON un marcaje
    // anómalo se presentaba como si no tuviera ninguno. Ahora se materializa.
    conMarcajesTipados([
      { employee_id: 1, timestamp: '2025-06-10 09:00:00', type: 'out', id: 99 },
    ]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(1);
    expect(data[0].rows[0].date).toBe('10/06/2025');
    expect(data[0].rows[0].pairs).toEqual([{ entrada: '', salida: '09:00' }]);
    expect(data[0].rows[0].total).toBe('0:00');
    expect(data[0].rows[0].anomalies).toContain('salida_sin_entrada');
  });

  test('un huérfano en el borde de la ventana (fuera del período) NO cuenta', async () => {
    // La ventana de lectura se extiende un día; un OUT del día siguiente es sólo
    // contexto del borde y no debe materializar una fila ni conservar al
    // empleado si no tiene nada dentro del período.
    conMarcajesTipados([
      { employee_id: 1, timestamp: '2025-06-11 09:00:00', type: 'out', id: 99 },
    ]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toEqual([]);
  });

  test('dos jornadas del MISMO día son dos filas y el total cierra', async () => {
    // 06:00-10:00 y 18:00-22:00, separadas por más que el umbral de pausa: son
    // dos jornadas del mismo día. Colapsarlas en la fecha perdía una y el total
    // (8:00) dejaba de cerrar con lo que muestra la tabla.
    conMarcajes([
      '2025-06-10 06:00:00', '2025-06-10 10:00:00',
      '2025-06-10 18:00:00', '2025-06-10 22:00:00',
    ]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(2);
    expect(data[0].rows.every((r) => r.date === '10/06/2025')).toBe(true);
    expect(data[0].rows.map((r) => r.total)).toEqual(['4:00', '4:00']);
    expect(data[0].total_hm).toBe('8:00');
  });

  test('un huérfano el mismo día de una jornada válida queda visible como fila aparte', async () => {
    // OUT huérfano 06:00 + jornada 08:00-17:00. La hora del huérfano no puede
    // perderse al compartir fecha: es su propia fila, ordenada antes.
    conMarcajesTipados([
      { employee_id: 1, timestamp: '2025-06-10 06:00:00', type: 'out', id: 1 },
      { employee_id: 1, timestamp: '2025-06-10 08:00:00', type: 'in', id: 2 },
      { employee_id: 1, timestamp: '2025-06-10 17:00:00', type: 'out', id: 3 },
    ]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(2);
    expect(data[0].rows[0].pairs).toEqual([{ entrada: '', salida: '06:00' }]);
    expect(data[0].rows[0].anomalies).toContain('salida_sin_entrada');
    expect(data[0].rows[1].pairs).toEqual([{ entrada: '08:00', salida: '17:00' }]);
    expect(data[0].rows[1].total).toBe('9:00');
  });

  test('dos huérfanos del mismo día muestran los dos fichajes, no sólo el primero', async () => {
    conMarcajesTipados([
      { employee_id: 1, timestamp: '2025-06-10 06:00:00', type: 'out', id: 1 },
      { employee_id: 1, timestamp: '2025-06-10 07:00:00', type: 'out', id: 2 },
    ]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(2);
    expect(data[0].rows.map((r) => r.pairs[0].salida)).toEqual(['06:00', '07:00']);
  });

  test('un OUT huérfano poco después del cierre (atribuido a la jornada) queda visible', async () => {
    // 08:00-17:00 y un OUT de más a las 18:00: por caer dentro del umbral de
    // pausa, el motor lo asigna a la jornada (sale de la lista global). Su código
    // viaja en la jornada, pero su hora no está en ningún par y los
    // renderizadores muestran pares: sin materializarlo, el 18:00 era invisible.
    conMarcajesTipados([
      { employee_id: 1, timestamp: '2025-06-10 08:00:00', type: 'in', id: 1 },
      { employee_id: 1, timestamp: '2025-06-10 17:00:00', type: 'out', id: 2 },
      { employee_id: 1, timestamp: '2025-06-10 18:00:00', type: 'out', id: 3 },
    ]);
    const { data } = await generateMarcadasReport({ dateFrom: '2025-06-10', dateTo: '2025-06-10' });
    expect(data).toHaveLength(1);
    expect(data[0].rows).toHaveLength(2);
    expect(data[0].rows[0].pairs).toEqual([{ entrada: '08:00', salida: '17:00' }]);
    expect(data[0].rows[1].pairs).toEqual([{ entrada: '', salida: '18:00' }]);
    expect(data[0].rows[1].anomalies).toContain('salidas_consecutivas');
    expect(data[0].total_hm).toBe('9:00'); // el huérfano no suma tiempo
  });

  test('un lote que supera el tope de marcajes lanza un error tipado 413', async () => {
    // Determinista: el mismo pedido va a volver a superar el tope, así que la
    // ruta lo mapea a 413 (no reintentable) en vez de un 500 que la UI ofrece
    // reintentar. Sólo importa la longitud: el chequeo lanza antes de iterar.
    sequelize.query.mockReset();
    sequelize.query
      .mockResolvedValueOnce([[EMP]])
      .mockResolvedValueOnce([new Array(400001).fill(0)]);
    await expect(
      generateMarcadasReport({ dateFrom: '2025-06-01', dateTo: '2025-08-31' }),
    ).rejects.toMatchObject({ status: 413, code: 'MARCADAS_TOO_MANY_PUNCHES' });
  });
});
