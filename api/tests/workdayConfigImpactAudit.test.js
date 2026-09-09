'use strict';

/**
 * workdayConfigImpactAudit.test.js — Gate FASE E, sobre datos SINTÉTICOS.
 *
 * El auditor de impacto (`scripts/workday-config-impact-audit.js`) decide el
 * GO/NO-GO de FASE E: corre el MISMO rango dos veces —fallback puro vs.
 * resolución con configuración— y con `--require-no-impact` falla (exit 1) si
 * alguna jornada cambia. Ese gate sólo sirve si su comparación es fiel.
 *
 * Estas pruebas NO tocan la base ni datos reales: construyen marcajes
 * sintéticos, los pasan por el motor REAL y verifican la lógica pura del
 * auditor (`signature`/`sameRows`/`validDate`), que ahora se exporta porque el
 * `main()` con MySQL sólo corre como CLI.
 *
 * Invariantes cubiertos:
 *   1. Empleado sin configuración → jornada en `historical_fallback` y la
 *      comparación da "sin cambio" (el gate ve NO-impacto, correcto).
 *   2. Empleado con configuración que descuenta descanso → la comparación
 *      detecta el cambio. Con la huella vieja (que leía `in_ts`/`out_ts`
 *      inexistentes y sólo miraba `segment_minutes`) ese cambio se PERDÍA:
 *      el gate habría dado GO con impacto real sobre daily_summary.
 *   3. `validDate` acepta sólo fechas civiles existentes.
 *
 * Sin dependencia de zona horaria: los marcajes son strings de pared y el motor
 * los interpreta con aritmética UTC pura. La suite se corre además bajo
 * UTC / America/Asuncion / Asia/Tokyo (ver informe) sin cambiar resultados.
 */

const engine = require('../src/services/workdayEngine');
const { validDate, signature, sameRows } = require('../scripts/workday-config-impact-audit');

const PERIODO = { from: '2025-06-10', to: '2025-06-10' };

/** Una jornada simple 08:00→17:00 (segmento crudo de 540'). */
function punchesUnDia(employeeId = 1) {
  return [
    { employee_id: employeeId, timestamp: '2025-06-10 08:00:00', type: 'in',  id: 1 },
    { employee_id: employeeId, timestamp: '2025-06-10 17:00:00', type: 'out', id: 2 },
  ];
}

function jornadas(punches, resolveConfig) {
  const opts = resolveConfig ? { resolveConfig } : undefined;
  return engine.clipToPeriod(engine.buildWorkdays(punches, opts).workdays, PERIODO);
}

/** Reproduce la huella VIEJA (buggy) para demostrar qué dejaba pasar. */
function signatureVieja(j) {
  return JSON.stringify({
    work_date: j.work_date,
    segment_minutes: j.segment_minutes,
    segments: (j.segments || []).map((s) => ({ in: s.in_ts, out: s.out_ts })),
  });
}

describe('invariante FASE E — empleado sin configuración no cambia', () => {
  test('★ resolveConfig→null deja la jornada en historical_fallback', () => {
    const [j] = jornadas(punchesUnDia(), () => null);
    expect(j.calculation_mode).toBe('historical_fallback');
  });

  test('★ fallback puro y resolución sin config son idénticos (gate: NO-impacto)', () => {
    const fallback = jornadas(punchesUnDia());
    const resolved = jornadas(punchesUnDia(), () => null);
    expect(sameRows(fallback, resolved)).toBe(true);
  });

  test('el fallback también es historical_fallback (nunca configured sin snapshot)', () => {
    const [j] = jornadas(punchesUnDia());
    expect(j.calculation_mode).toBe('historical_fallback');
    expect(j.worked_minutes).toBe(540);
    expect(j.break_minutes).toBe(0);
  });
});

describe('invariante FASE E — una configuración que cambia el resultado se detecta', () => {
  const cfg = { break_mode: engine.BREAK_FIXED_UNPAID, break_minutes: 60 };

  test('la config descuenta el descanso: worked 540→480 con igual segment_minutes', () => {
    const [j] = jornadas(punchesUnDia(), () => cfg);
    expect(j.calculation_mode).toBe('configured');
    expect(j.segment_minutes).toBe(540);   // el crudo entrada→salida no cambia
    expect(j.worked_minutes).toBe(480);    // pero sí lo que llega a daily_summary
    expect(j.break_minutes).toBe(60);
  });

  test('★ sameRows detecta el cambio (fallback vs configurado)', () => {
    const fallback = jornadas(punchesUnDia());
    const resolved = jornadas(punchesUnDia(), () => cfg);
    expect(sameRows(fallback, resolved)).toBe(false);
  });

  test('★ REGRESIÓN: la huella vieja NO veía el cambio — el gate daba GO con impacto', () => {
    const fallback = jornadas(punchesUnDia());
    const resolved = jornadas(punchesUnDia(), () => cfg);
    // Con la huella vieja las dos ramas colapsan al mismo valor: mismo
    // segment_minutes (540) y segmentos con in/out `undefined`.
    const viejasFallback = fallback.map(signatureVieja);
    const viejasResolved = resolved.map(signatureVieja);
    expect(viejasResolved).toEqual(viejasFallback);
    // La huella nueva, en cambio, difiere.
    expect(signature(resolved[0])).not.toBe(signature(fallback[0]));
  });
});

describe('signature — compara lo que la configuración puede mover', () => {
  test('usa campos de segmento que el motor SÍ produce (in/out de pared)', () => {
    const [j] = jornadas(punchesUnDia());
    const parsed = JSON.parse(signature(j));
    expect(parsed.segments[0].in).toBe('2025-06-10 08:00:00');
    expect(parsed.segments[0].out).toBe('2025-06-10 17:00:00');
    expect(parsed.worked_minutes).toBe(540);
  });

  test('dos jornadas con igual segmento pero distinto worked_minutes difieren', () => {
    const a = { work_date: '2025-06-10', calculation_mode: 'configured', segment_minutes: 540, worked_minutes: 480, break_minutes: 60, segments: [{ in: '2025-06-10 08:00:00', out: '2025-06-10 17:00:00', minutes: 540 }] };
    const b = { ...a, worked_minutes: 540, break_minutes: 0 };
    expect(sameRows([a], [b])).toBe(false);
  });

  test('conjuntos idénticos con distinto orden son iguales (compara multiconjunto)', () => {
    const j1 = { work_date: '2025-06-10', calculation_mode: 'historical_fallback', segment_minutes: 480, worked_minutes: 480, break_minutes: 0, segments: [] };
    const j2 = { ...j1, work_date: '2025-06-11' };
    expect(sameRows([j1, j2], [j2, j1])).toBe(true);
  });
});

describe('validDate — sólo fechas civiles existentes', () => {
  test('acepta una fecha real', () => {
    expect(validDate('2025-06-10')).toBe(true);
    expect(validDate('2024-02-29')).toBe(true); // bisiesto real
  });

  test('★ rechaza fechas inexistentes en vez de normalizarlas', () => {
    expect(validDate('2025-02-29')).toBe(false); // 2025 no es bisiesto
    expect(validDate('2025-13-01')).toBe(false);
    expect(validDate('2025-06-31')).toBe(false);
  });

  test('rechaza formatos no ISO o vacíos', () => {
    expect(validDate('2025-6-1')).toBe(false);
    expect(validDate('10/06/2025')).toBe(false);
    expect(validDate('')).toBe(false);
    expect(validDate(null)).toBe(false);
  });
});
