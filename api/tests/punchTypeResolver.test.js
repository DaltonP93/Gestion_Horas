/**
 * punchTypeResolver.test.js — Semántica CONTEXTUAL única de in/out.
 *
 * Verifica las reglas de oro: el explícito no se reescribe (y el conflicto se
 * reporta, no se invierte), la inferencia sólo corre sin tipo confiable, sin
 * evidencia → unknown, y el cruce de medianoche se resuelve por VENTANA de
 * jornada (no por día civil). Cubre resolución online (secuencia) y por lote
 * (múltiples marcas/empleados/dispositivos, orden desordenado).
 *
 * Todo trabaja sobre HORA DE PARED (strings), de modo que el resultado NO
 * depende de la timezone del proceso (la suite corre además en UTC/Asunción/
 * Tokyo por matriz de CI).
 */

const engine = require('../src/services/workdayEngine');
const R = require('../src/services/punchTypeResolver');

const absOf = (wall) => engine.toWall(wall).abs;

/** Construye items de secuencia (context/punch) a partir de tuplas compactas. */
function ctx(wall, type) { return { kind: 'context', abs: absOf(wall), type }; }
function punch(wall, explicitType = null, extra = {}) {
  return { kind: 'punch', abs: absOf(wall), explicitType, ...extra };
}

describe('inferContextualType — reglas base', () => {
  test('1a. una marca sin contexto → unknown (no se inventa entrada)', () => {
    expect(R.inferContextualType([], absOf('2026-09-16 08:00:00'))).toBe('unknown');
  });
  test('1b. contexto IN + unknown posterior (misma jornada) → out', () => {
    const prior = [{ abs: absOf('2026-09-16 08:00:00'), type: 'in' }];
    expect(R.inferContextualType(prior, absOf('2026-09-16 17:00:00'))).toBe('out');
  });
  test('2. cruce de medianoche: 18:16 IN + 07:01 del día siguiente (dentro de ventana) → out', () => {
    const prior = [{ abs: absOf('2026-09-19 18:16:00'), type: 'in' }];
    expect(R.inferContextualType(prior, absOf('2026-09-20 07:01:00'))).toBe('out');
  });
  test('6. una sola marca sin contexto → unknown', () => {
    expect(R.inferContextualType([], absOf('2026-09-16 09:00:00'))).toBe('unknown');
  });
  test('7. sólo unknown previos → unknown (sin estado de sesión)', () => {
    const prior = [
      { abs: absOf('2026-09-16 08:00:00'), type: 'unknown' },
      { abs: absOf('2026-09-16 12:00:00'), type: 'unknown' },
    ];
    expect(R.inferContextualType(prior, absOf('2026-09-16 17:00:00'))).toBe('unknown');
  });
  test('8. duplicado/réplica dentro de duplicateWindowSeconds → conserva tipo previo', () => {
    const prior = [{ abs: absOf('2026-09-16 08:00:00'), type: 'in' }];
    expect(R.inferContextualType(prior, absOf('2026-09-16 08:00:30'))).toBe('in');
  });
  test('9. marca fuera del máximo de jornada (IN de hace 30 h) → unknown (no cierra el turno anterior)', () => {
    const prior = [{ abs: absOf('2026-09-15 06:00:00'), type: 'in' }];
    expect(R.inferContextualType(prior, absOf('2026-09-16 12:00:00'))).toBe('unknown');
  });
  test('última conocida OUT → siguiente unknown = in', () => {
    const prior = [
      { abs: absOf('2026-09-16 08:00:00'), type: 'in' },
      { abs: absOf('2026-09-16 12:00:00'), type: 'out' },
    ];
    expect(R.inferContextualType(prior, absOf('2026-09-16 13:00:00'))).toBe('in');
  });
});

describe('resolveSequence — explícito, conflicto y turnos', () => {
  test('3. DOS IN explícitos → se conservan AMBOS in (el 2º NO se convierte en out)', () => {
    const items = [
      punch('2026-09-19 18:16:00', 'in'),
      punch('2026-09-20 07:01:00', 'in'),
    ];
    R.resolveSequence(items);
    expect(items[0].resolvedType).toBe('in');
    expect(items[0].typeProvenance).toBe('explicit');
    expect(items[1].resolvedType).toBe('in');           // NO se invierte
    expect(items[1].typeProvenance).toBe('explicit');
    expect(items[1].contextualExpectation).toBe('out');  // el contexto sugería out
    expect(items[1].typeConflict).toBe(true);            // se REPORTA el conflicto
  });

  test('4. conflicto explícito: contexto sugiere OUT pero raw dice IN → conserva IN + conflicto', () => {
    const items = [ctx('2026-09-16 08:00:00', 'in'), punch('2026-09-16 17:00:00', 'in')];
    R.resolveSequence(items);
    const p = items[1];
    expect(p.resolvedType).toBe('in');        // se conserva el explícito
    expect(p.contextualExpectation).toBe('out');
    expect(p.typeConflict).toBe(true);
  });

  test('4b. explícito consistente con el contexto → sin conflicto', () => {
    const items = [ctx('2026-09-16 08:00:00', 'in'), punch('2026-09-16 17:00:00', 'out')];
    R.resolveSequence(items);
    expect(items[1].resolvedType).toBe('out');
    expect(items[1].typeConflict).toBe(false);
  });

  test('5. split shift IN/OUT/IN/OUT (todo unknown, sólo el primer IN sembrado) se resuelve alternando por sesión', () => {
    // Primer IN explícito ancla; el resto unknown se infiere por sesión.
    const items = [
      punch('2026-09-16 08:00:00', 'in'),   // explícito in
      punch('2026-09-16 12:00:00'),         // unknown → out (cierra)
      punch('2026-09-16 13:00:00'),         // unknown → in (abre)
      punch('2026-09-16 17:00:00'),         // unknown → out (cierra)
    ];
    R.resolveSequence(items);
    expect(items.map(i => i.resolvedType)).toEqual(['in', 'out', 'in', 'out']);
    expect(items.slice(1).every(i => i.typeProvenance === 'contextual')).toBe(true);
  });

  test('unknown sin ancla al inicio de la secuencia → unknown', () => {
    const items = [punch('2026-09-16 08:00:00')];
    R.resolveSequence(items);
    expect(items[0].resolvedType).toBe('unknown');
    expect(items[0].typeProvenance).toBe('unknown_no_context');
  });
});

describe('resolvePunchTypesBatch — lote eficiente y determinista', () => {
  // sequelize falso: la consulta de contexto devuelve las filas provistas.
  function fakeSequelize(contextRows = []) {
    return {
      query: jest.fn(async () => [contextRows]),
    };
  }
  const deps = (sequelize, contextRows) => ({
    sequelize: sequelize || fakeSequelize(contextRows),
    getEmpId: (p) => p.empId,
    getWall: (p) => p.wall,
    getExplicitType: (p) => p.explicitType ?? null,
  });

  test('10. varias marcas del MISMO empleado en el mismo batch (in explícito + unknowns)', async () => {
    const punches = [
      { empId: 1, wall: '2026-09-16 08:00:00', explicitType: 'in' },
      { empId: 1, wall: '2026-09-16 17:00:00', explicitType: null },
    ];
    await R.resolvePunchTypesBatch(punches, deps(null, []));
    // el explícito no se toca (p.type no se sobrescribe); sí se anota su procedencia
    expect(punches[0].typeProvenance).toBe('explicit');
    expect(punches[0].explicitType).toBe('in');
    expect(punches[1].type).toBe('out');
    expect(punches[1].typeProvenance).toBe('contextual');
  });

  test('11 & 12. varios empleados y DOS dispositivos del mismo empleado', async () => {
    const punches = [
      { empId: 1, wall: '2026-09-16 08:00:00', explicitType: 'in' },   // dev A
      { empId: 1, wall: '2026-09-16 17:05:00', explicitType: null },   // dev B → out
      { empId: 2, wall: '2026-09-16 09:00:00', explicitType: 'in' },
      { empId: 2, wall: '2026-09-16 18:00:00', explicitType: null },   // → out
    ];
    await R.resolvePunchTypesBatch(punches, deps(null, []));
    expect(punches[1].type).toBe('out');
    expect(punches[3].type).toBe('out');
    // el estado de un empleado no contamina al otro
    expect(punches[2].typeProvenance).toBe('explicit');
  });

  test('13. orden de entrada DESORDENADO → resultado determinista tras ordenar', async () => {
    const ordered = [
      { empId: 7, wall: '2026-09-16 08:00:00', explicitType: 'in' },
      { empId: 7, wall: '2026-09-16 12:00:00', explicitType: null },
      { empId: 7, wall: '2026-09-16 13:00:00', explicitType: null },
      { empId: 7, wall: '2026-09-16 17:00:00', explicitType: null },
    ];
    const shuffled = [ordered[3], ordered[0], ordered[2], ordered[1]].map(p => ({ ...p }));
    await R.resolvePunchTypesBatch(shuffled, deps(null, []));
    // reindexar por wall para comparar
    const byWall = Object.fromEntries(shuffled.map(p => [p.wall, p.type ?? p.explicitType]));
    expect(byWall['2026-09-16 08:00:00']).toBe('in');
    expect(byWall['2026-09-16 12:00:00']).toBe('out');
    expect(byWall['2026-09-16 13:00:00']).toBe('in');
    expect(byWall['2026-09-16 17:00:00']).toBe('out');
  });

  test('contexto de BD CONFIABLE (jornada anterior IN, fuente device) resuelve la madrugada como out', async () => {
    // IN previo confiable (source device) en attendance_logs, no en el batch.
    const contextRows = [{ empId: 3, wall: '2026-09-19 18:16:00', storedType: 'in', source: 'device', rawJson: null }];
    const punches = [{ empId: 3, wall: '2026-09-20 07:01:00', explicitType: null }];
    await R.resolvePunchTypesBatch(punches, deps(fakeSequelize(contextRows), contextRows));
    expect(punches[0].type).toBe('out');
    expect(punches[0].typeProvenance).toBe('contextual');
  });

  // ── Corrección 5: contexto zkteco_direct sin raw explícito NO es confiable ──
  test('5A. contexto zkteco_direct stored=IN SIN raw explícito → NO fuerza OUT (unknown)', async () => {
    const contextRows = [{ empId: 4, wall: '2026-09-19 18:16:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{}' }];
    const punches = [{ empId: 4, wall: '2026-09-20 07:01:00', explicitType: null }];
    await R.resolvePunchTypesBatch(punches, deps(fakeSequelize(contextRows), contextRows));
    expect(punches[0].type).toBe('unknown');
    expect(punches[0].typeProvenance).toBe('unknown_no_context');
  });

  test('5B. contexto zkteco_direct stored=IN CON raw explícito IN → sí infiere OUT', async () => {
    const contextRows = [{ empId: 6, wall: '2026-09-19 18:16:00', storedType: 'in', source: 'zkteco_direct', rawJson: '{"inOutStatus":0}' }];
    const punches = [{ empId: 6, wall: '2026-09-20 07:01:00', explicitType: null }];
    await R.resolvePunchTypesBatch(punches, deps(fakeSequelize(contextRows), contextRows));
    expect(punches[0].type).toBe('out');
    expect(punches[0].typeProvenance).toBe('contextual');
  });

  test('5C. una marca del batch resuelta determinista sí alimenta a la siguiente', async () => {
    // ancla explícita IN + unknown (→out, determinista) + unknown (→in por el out)
    const punches = [
      { empId: 8, wall: '2026-09-16 08:00:00', explicitType: 'in' },
      { empId: 8, wall: '2026-09-16 12:00:00', explicitType: null }, // → out
      { empId: 8, wall: '2026-09-16 13:00:00', explicitType: null }, // → in (por el out previo)
    ];
    await R.resolvePunchTypesBatch(punches, deps(null, []));
    expect(punches[1].type).toBe('out');
    expect(punches[2].type).toBe('in');
  });

  test('dos IN explícitos en el batch NO se invierten y marcan conflicto', async () => {
    const punches = [
      { empId: 9, wall: '2026-09-19 18:16:00', explicitType: 'in' },
      { empId: 9, wall: '2026-09-20 07:01:00', explicitType: 'in' },
    ];
    const summary = await R.resolvePunchTypesBatch(punches, deps(null, []));
    expect(punches[1].typeProvenance).toBe('explicit');
    expect(punches[1].typeConflict).toBe(true);
    expect(summary.conflicts).toBe(1);
  });

  test('sin evidencia → unknown, no se fabrica in/out', async () => {
    const punches = [{ empId: 5, wall: '2026-09-16 08:00:00', explicitType: null }];
    await R.resolvePunchTypesBatch(punches, deps(null, []));
    expect(punches[0].type).toBe('unknown');
    expect(punches[0].typeProvenance).toBe('unknown_no_context');
  });
});

describe('determinismo independiente de la timezone del proceso', () => {
  test('el abs de pared no depende de process.TZ (contador civil puro)', () => {
    // toWall usa Date.UTC como calendario puro: mismo string → mismo abs.
    expect(absOf('2026-09-20 07:01:00') - absOf('2026-09-19 18:16:00')).toBe((12 * 3600) + (45 * 60));
  });
});
