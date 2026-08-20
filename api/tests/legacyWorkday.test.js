/**
 * legacyWorkday.test.js — Deja constancia de los defectos del armado anterior.
 *
 * Estos tests NO afirman que el resultado sea correcto: afirman que es el que
 * producción venía dando. Son la referencia contra la que
 * `scripts/workday-engine-audit.js` mide, y la prueba de que el motor cambia
 * los números que dice cambiar y no otros.
 *
 * `TZ_PY` está fijo en el módulo legacy, así que el resultado es el mismo
 * corriendo en UTC, America/Asuncion o Asia/Tokyo — igual que en producción.
 */

const legacy = require('../src/services/legacyWorkday');
const engine = require('../src/services/workdayEngine');

const logs = (...ts) => ts.map((t) => ({ timestamp: t, type: 'unknown' }));

describe('armado legacy — defectos conservados a propósito', () => {
  test('parte el turno nocturno 18:30 → 07:04 en dos filas', () => {
    const rows = legacy.buildLegacyRows(
      logs('2024-12-01 18:30:00', '2024-12-02 07:04:00'),
      { from: '2024-12-01', to: '2024-12-31' },
    );
    // Dos jornadas de cero minutos cada una: una entrada sin salida y una
    // salida sin entrada. Las 12:34 reales desaparecen del reporte.
    expect(rows.map((r) => r.work_date)).toEqual(['2024-12-01', '2024-12-02']);
    expect(rows.every((r) => r.minutes === 0)).toBe(true);

    const { workdays } = engine.buildWorkdays(logs('2024-12-01 18:30:00', '2024-12-02 07:04:00'));
    expect(workdays).toHaveLength(1);
    expect(workdays[0].segment_minutes).toBe(754);
  });

  test('le da día propio a la salida de 05:29 y pierde el segundo tramo', () => {
    const marcas = logs(
      '2025-03-09 21:32:00', '2025-03-10 00:05:00',
      '2025-03-10 01:02:00', '2025-03-10 05:29:00',
    );
    const rows = legacy.buildLegacyRows(marcas, { from: '2025-03-01', to: '2025-03-31' });

    // El corte de las 05:00 manda 00:05 y 01:02 al 09/03 pero deja 05:29 en el
    // 10/03: el segundo tramo queda partido entre dos filas.
    expect(rows.map((r) => r.work_date)).toEqual(['2025-03-09', '2025-03-10']);
    const totalLegacy = rows.reduce((a, r) => a + r.minutes, 0);
    expect(totalLegacy).not.toBe(420);

    const { workdays } = engine.buildWorkdays(marcas);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].segment_minutes).toBe(420);
  });

  test('corre una hora las marcas de invierno anteriores al 2024-10-06', () => {
    const rows = legacy.buildLegacyRows(
      logs('2024-08-01 08:00:00', '2024-08-01 17:00:00'),
      { from: '2024-08-01', to: '2024-08-31' },
    );
    // Guardado 08:00 y 17:00; el legacy imprime una hora antes.
    expect(rows[0].pairs).toEqual([{ entrada: '07:00', salida: '16:00' }]);
    // El TOTAL sí coincide: el desfase es igual en los dos extremos y se
    // cancela al restar. Por eso el defecto se veía en las columnas de hora y
    // no en la de total, y por eso pasó tanto tiempo sin corregirse.
    expect(rows[0].minutes).toBe(540);

    const { workdays } = engine.buildWorkdays(logs('2024-08-01 08:00:00', '2024-08-01 17:00:00'));
    expect(workdays[0].segments[0].in_hhmm).toBe('08:00');
    expect(workdays[0].segment_minutes).toBe(540);
  });

  test('manda al día anterior una marca de 00:30 de invierno', () => {
    const rows = legacy.buildLegacyRows(
      logs('2024-06-15 00:30:00', '2024-06-15 04:30:00'),
      { from: '2024-06-01', to: '2024-06-30' },
    );
    // La entrada guardada como 00:30 del 15/06 se formatea 23:30 del 14/06:
    // el desfase de la tzdata la cambia de DÍA. Sobre la hora ya corrida el
    // corte de las 05:00 ni siquiera llega a aplicarse (23 no es menor a 5),
    // así que la jornada entera queda contabilizada en el 14/06.
    expect(rows[0].work_date).toBe('2024-06-14');
    expect(rows[0].pairs[0].entrada).toBe('23:30');

    const { workdays } = engine.buildWorkdays(logs('2024-06-15 00:30:00', '2024-06-15 04:30:00'));
    expect(workdays[0].work_date).toBe('2024-06-15');
  });

  test('empareja por posición e ignora el tipo del marcaje', () => {
    const rows = legacy.buildLegacyRows([
      { timestamp: '2025-06-10 08:00:00', type: 'in' },
      { timestamp: '2025-06-10 09:00:00', type: 'in' },
      { timestamp: '2025-06-10 17:00:00', type: 'out' },
    ], { from: '2025-06-10', to: '2025-06-10' });

    // Empareja (08:00, 09:00) = 60 min y descarta la salida real de 17:00.
    expect(rows[0].minutes).toBe(60);
    expect(rows[0].pairs[1]).toEqual({ entrada: '17:00', salida: '' });
  });

  test('un día diurno normal coincide con el motor: la mayoría no se mueve', () => {
    const marcas = logs(
      '2025-06-10 08:00:00', '2025-06-10 12:00:00',
      '2025-06-10 13:00:00', '2025-06-10 17:00:00',
    );
    const rows = legacy.buildLegacyRows(marcas, { from: '2025-06-10', to: '2025-06-10' });
    const { workdays } = engine.buildWorkdays(marcas);

    expect(rows).toHaveLength(1);
    expect(workdays).toHaveLength(1);
    expect(rows[0].minutes).toBe(workdays[0].segment_minutes);
    expect(rows[0].work_date).toBe(workdays[0].work_date);
  });

  test('conserva la deduplicación por minuto', () => {
    const rows = legacy.buildLegacyRows(
      logs('2025-06-10 08:00:00', '2025-06-10 08:00:30', '2025-06-10 17:00:00'),
      { from: '2025-06-10', to: '2025-06-10' },
    );
    expect(rows[0].pairs).toEqual([{ entrada: '08:00', salida: '17:00' }]);
  });
});
