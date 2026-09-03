/**
 * workdayEngineRolloutCategories.test.js — golden dirigido a las categorías que
 * `docs/historical-2025-readiness.md` nombra como drivers de NO-GO del baseline
 * enero-2025: turno_nocturno, boundary de mes, emparejamiento y la categoría
 * "otro" (con volumen = NO-GO).
 *
 * Invariante que se protege: para datos BIEN FORMADOS el bucket "otro"
 * (anomalías inexplicadas) queda VACÍO; una marca genuinamente malformada
 * produce una anomalía EXPLÍCITA y nunca se absorbe silenciosamente en "otro".
 *
 * Absolutos a propósito: el motor trabaja en hora de pared y la suite corre en
 * UTC / America/Asuncion / Asia/Tokyo dando lo mismo en las tres.
 */

const engine = require('../src/services/workdayEngine');
const { buildWorkdays, ANOMALY, minutesToHM } = engine;

const marcas = (...ts) => ts.map((t) => ({ timestamp: t }));
// "otro" en el sentido del auditor = jornadas con anomalías que nadie explicó.
const totalAnomalies = (workdays, global) =>
  global.length + workdays.reduce((n, w) => n + (w.anomalies?.length || 0), 0);

describe('categorías NO-GO del baseline enero-2025', () => {
  test('turno_nocturno: se fecha en el día de inicio, sin "otro"', () => {
    const { workdays, anomalies } = buildWorkdays(marcas('2025-01-15 18:30:00', '2025-01-16 07:04:00'));
    expect(workdays).toHaveLength(1);
    expect(workdays[0].work_date).toBe('2025-01-15');
    expect(minutesToHM(workdays[0].worked_minutes)).toBe('12:34');
    expect(workdays[0].crosses_midnight).toBe(true);
    expect(totalAnomalies(workdays, anomalies)).toBe(0);
  });

  test('boundary de mes: 31/ene 22:00 → 1/feb 06:00 queda UNA jornada del 31/ene (no fabrica una de febrero)', () => {
    const { workdays, anomalies } = buildWorkdays(marcas('2025-01-31 22:00:00', '2025-02-01 06:00:00'));
    expect(workdays.map((w) => w.work_date)).toEqual(['2025-01-31']);
    expect(workdays[0].worked_minutes).toBe(480);
    expect(workdays[0].crosses_midnight).toBe(true);
    // Ninguna jornada se fecha en febrero por el cruce de límite de mes.
    expect(workdays.some((w) => w.work_date.startsWith('2025-02'))).toBe(false);
    expect(totalAnomalies(workdays, anomalies)).toBe(0);
  });

  test('emparejamiento: varios días bien formados → "otro" vacío (0 anomalías)', () => {
    const { workdays, anomalies } = buildWorkdays(marcas(
      '2025-01-06 08:00:00', '2025-01-06 17:00:00',               // diurno simple
      '2025-01-07 08:00:00', '2025-01-07 12:00:00',
      '2025-01-07 13:00:00', '2025-01-07 17:00:00',               // diurno con almuerzo
      '2025-01-08 21:32:00', '2025-01-09 00:05:00',
      '2025-01-09 01:02:00', '2025-01-09 05:29:00',               // nocturno partido
    ));
    expect(workdays.map((w) => w.work_date)).toEqual(['2025-01-06', '2025-01-07', '2025-01-08']);
    expect(totalAnomalies(workdays, anomalies)).toBe(0);
  });

  test('la categoría "otro" nunca es silenciosa: una salida huérfana es una anomalía EXPLÍCITA', () => {
    const { workdays, anomalies } = buildWorkdays([
      { timestamp: '2025-01-20 17:00:00', type: 'out' },
    ]);
    // No se inventa jornada ni se clasifica como "otro": sale con código conocido.
    expect(workdays).toEqual([]);
    expect(anomalies).toEqual([
      { code: ANOMALY.SALIDA_SIN_ENTRADA, at: '2025-01-20 17:00:00', log_ids: [] },
    ]);
  });

  test('una entrada sin salida queda como tramo abierto con anomalía nombrada (no "otro")', () => {
    const { workdays } = buildWorkdays([
      { timestamp: '2025-01-21 08:00:00', type: 'in' },
    ]);
    expect(workdays).toHaveLength(1);
    expect(workdays[0].open).toBe(true);
    expect(workdays[0].anomalies.map((a) => a.code)).toContain(ANOMALY.ENTRADA_SIN_SALIDA);
  });
});
