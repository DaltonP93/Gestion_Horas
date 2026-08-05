/**
 * Política de reconciliación de atributos — contrato v1.
 *
 * Los tests que importan son los de PROPIEDAD: conmutatividad, idempotencia y
 * asociatividad se verifican sobre un barrido de combinaciones, no sobre un
 * caso elegido a mano. En el PR del contrato v1 varios tests pasaban porque el
 * caso estaba construido para encajar con la conclusión; acá el barrido es el
 * que decide.
 */
const {
  mergePunchObservations, SOURCE_PRIORITY, MERGE_ERRORS,
} = require('../../contracts/punchMerge');
const { buildEvent } = require('../../contracts/punchContractV1');

// ── Andamiaje ────────────────────────────────────────────────────────

/** Marcación de referencia. Datos ficticios. */
const BASE = buildEvent({
  device_id: 7,
  device_user_id: '0041',
  occurred_at: '2026-03-11T08:02:13-03:00',
  event_type: 'in',
});
if (!BASE.ok) throw new Error('fixture inválido: ' + BASE.error_code);

const IDENTIDAD = {
  event_id:       BASE.event.event_id,
  device_id:      BASE.event.device_id,
  device_user_id: BASE.event.device_user_id,
  occurred_at:    BASE.event.occurred_at,
  event_type:     BASE.event.event_type,
};

/**
 * Observación de `source`, con los atributos que se le pasen.
 *
 * OJO con el `??`: usarlo acá convierte un `received_at: null` EXPLÍCITO en el
 * valor por defecto, y entonces los casos de "recepción desconocida" no prueban
 * nada. Pasó — el barrido decía cubrir `received_at: null` y en realidad todas
 * las observaciones tenían fecha. Se distingue "no se especificó" de
 * "se especificó null" con `in`.
 */
function obs(source, attrs = {}) {
  const dado = (k, porDefecto) => (k in attrs ? attrs[k] : porDefecto);
  return {
    ...IDENTIDAD,
    source,
    received_at:   dado('received_at', '2026-03-11T08:05:00-03:00'),
    raw_reference: dado('raw_reference', null),
    verify_mode:   dado('verify_mode', null),
    work_code:     dado('work_code', null),
  };
}

function ok(...args) {
  const r = mergePunchObservations(...args);
  if (!r.ok) throw new Error(`merge falló: ${r.error_code} ${r.detail || ''}`);
  return r.punch;
}

// ── Casos nombrados ──────────────────────────────────────────────────

describe('un valor conocido nunca lo pisa un nulo', () => {
  test('el no-nulo gana, venga en la posición que venga', () => {
    const conValor = obs('polling', { verify_mode: 1 });
    const sinValor = obs('push', { verify_mode: null });

    expect(ok(conValor, sinValor).verify_mode).toBe(1);
    expect(ok(sinValor, conValor).verify_mode).toBe(1);
  });

  test('un nulo no genera conflicto — no discrepa, sólo no aporta', () => {
    const p = ok(obs('push', { verify_mode: 15 }), obs('att2000', { verify_mode: null }));

    expect(p.attribute_conflict).toBe(false);
    expect(p.conflicts).toEqual([]);
  });

  test('sin ninguna observación con valor, el atributo queda null', () => {
    const p = ok(obs('push'), obs('polling'));

    expect(p.verify_mode).toBeNull();
    expect(p.work_code).toBeNull();
    expect(p.attribute_conflict).toBe(false);
  });
});

describe('dos no-nulos que discrepan', () => {
  const a = obs('push',    { verify_mode: 1 });
  const b = obs('polling', { verify_mode: 4 });

  test('no crean una segunda marcación', () => {
    const p = ok(a, b);
    expect(p.event_id).toBe(IDENTIDAD.event_id);
  });

  test('gana la fuente de mayor confianza (push > polling)', () => {
    expect(ok(a, b).verify_mode).toBe(1);
    expect(ok(b, a).verify_mode).toBe(1);
  });

  test('el conflicto queda marcado y auditable, no silencioso', () => {
    const p = ok(a, b);

    expect(p.attribute_conflict).toBe(true);
    expect(p.conflicts).toHaveLength(1);
    const c = p.conflicts[0];
    expect(c.attribute).toBe('verify_mode');
    expect(c.chosen).toBe(1);
    expect(c.chosen_source).toBe('push');
    // El valor descartado NO se pierde: queda quién dijo qué.
    expect(c.observed.map(o => o.value).sort()).toEqual([1, 4]);
    expect(c.observed.map(o => o.source).sort()).toEqual(['polling', 'push']);
  });

  test('el valor perdedor sigue disponible en las observaciones', () => {
    const p = ok(a, b);
    const valores = p.observations.map(o => o.verify_mode).sort();
    expect(valores).toEqual([1, 4]);
  });
});

describe('valores falsy y recepción desconocida', () => {
  test('verify_mode 0 es un valor, no una ausencia', () => {
    // `0` es falsy: un `||` mal puesto lo trataría como "no vino".
    const p = ok(obs('push', { verify_mode: 0 }), obs('polling', { verify_mode: 4 }));

    expect(p.verify_mode).toBe(0);
    expect(p.attribute_conflict).toBe(true);
  });

  test('un 0 conocido le gana a un null', () => {
    expect(ok(obs('push', { verify_mode: null }), obs('polling', { verify_mode: 0 })).verify_mode).toBe(0);
  });

  test('work_code vacío es un valor, no una ausencia', () => {
    expect(ok(obs('push', { work_code: '' }), obs('polling', { work_code: null })).work_code).toBe('');
  });

  test('received_at nulo mezclado con no nulo no rompe el orden', () => {
    // El bug: `null < '2026-…'` y `'2026-…' < null` son AMBOS false, así que el
    // comparador devolvía 1 en los dos sentidos. Un comparador que no es orden
    // total hace que `sort` dependa del orden de entrada.
    const sinFecha = obs('polling', { verify_mode: 7, received_at: null });
    const conFecha = obs('polling', { verify_mode: 9, received_at: '2026-03-11T08:00:00-03:00' });

    expect(ok(sinFecha, conFecha)).toEqual(ok(conFecha, sinFecha));
    // La de fecha conocida gana: no puede ganar "la más temprana" algo de lo
    // que no se sabe cuándo llegó.
    expect(ok(sinFecha, conFecha).verify_mode).toBe(9);
  });

  test('el mismo instante con otro offset ordena igual', () => {
    const a = obs('polling', { verify_mode: 1, received_at: '2026-03-11T08:00:00-03:00' });
    const b = obs('polling', { verify_mode: 1, received_at: '2026-03-11T12:00:00+01:00' });
    // Mismo momento: lexicográficamente '0' < '1', por instante son iguales.
    expect(ok(a, b)).toEqual(ok(b, a));
  });

  test('first/last received_at se calculan por instante, no alfabéticamente', () => {
    const p = ok(
      obs('push',    { received_at: '2026-03-11T12:00:00+01:00' }),  // 08:00 -03
      obs('polling', { received_at: '2026-03-11T09:00:00-03:00' }),
    );

    expect(p.first_received_at).toBe('2026-03-11T12:00:00+01:00');
    expect(p.last_received_at).toBe('2026-03-11T09:00:00-03:00');
  });
});

describe('prioridad de fuente', () => {
  test('push > polling > att2000', () => {
    expect(SOURCE_PRIORITY.push).toBeGreaterThan(SOURCE_PRIORITY.polling);
    expect(SOURCE_PRIORITY.polling).toBeGreaterThan(SOURCE_PRIORITY.att2000);
  });

  test('tres fuentes en desacuerdo: gana push', () => {
    const p = ok(
      obs('att2000', { verify_mode: 3 }),
      obs('push',    { verify_mode: 1 }),
      obs('polling', { verify_mode: 2 }),
    );

    expect(p.verify_mode).toBe(1);
    expect(p.sources).toEqual(['push', 'polling', 'att2000']);   // por confianza
    expect(p.conflicts[0].observed).toHaveLength(3);
  });

  test('empate de prioridad → gana la recibida antes', () => {
    const temprana = obs('polling', { verify_mode: 9, received_at: '2026-03-11T08:05:00-03:00' });
    const tardia   = obs('polling', { verify_mode: 2, received_at: '2026-03-11T09:00:00-03:00' });

    expect(ok(temprana, tardia).verify_mode).toBe(9);
    expect(ok(tardia, temprana).verify_mode).toBe(9);
  });
});

describe('reenvío del mismo lote', () => {
  test('la observación repetida colapsa: una sola, sin conflicto', () => {
    const o = obs('push', { verify_mode: 1, raw_reference: 'lote-88#3' });
    const p = ok(o, o, o);

    expect(p.observations).toHaveLength(1);
    expect(p.attribute_conflict).toBe(false);
  });

  test('reenviar no cambia el resultado ya calculado', () => {
    const o = obs('push', { verify_mode: 1 });
    const primero = ok(o);
    expect(ok(primero, o)).toEqual(primero);
  });
});

describe('identidad', () => {
  test('exige el mismo event_id', () => {
    const otro = buildEvent({ ...IDENTIDAD, device_user_id: '0042' }).event;
    const r = mergePunchObservations(
      obs('push', { verify_mode: 1 }),
      { ...otro, source: 'polling', received_at: null, raw_reference: null },
    );

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(MERGE_ERRORS.EVENT_ID_MISMATCH);
  });

  test('rechaza un event_id que no corresponde a la identidad', () => {
    // Mismo event_id declarado, identidad distinta: sin esta comprobación se
    // fusionarían dos marcaciones diferentes.
    const falsificada = { ...obs('polling', { verify_mode: 1 }), device_user_id: '0099' };
    const r = mergePunchObservations(falsificada);

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(MERGE_ERRORS.EVENT_ID_INCONSISTENT);
  });

  test('rechaza identidades divergentes con el mismo event_id', () => {
    const r = mergePunchObservations(
      obs('push', { verify_mode: 1 }),
      { ...obs('polling'), event_type: 'out' },
    );

    expect(r.ok).toBe(false);
    expect([MERGE_ERRORS.IDENTITY_MISMATCH, MERGE_ERRORS.EVENT_ID_INCONSISTENT])
      .toContain(r.error_code);
  });

  test('rechaza una fuente desconocida', () => {
    const r = mergePunchObservations(obs('telepatia', { verify_mode: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(MERGE_ERRORS.SOURCE_INVALID);
  });

  test('rechaza la entrada vacía', () => {
    expect(mergePunchObservations().error_code).toBe(MERGE_ERRORS.NO_INPUT);
  });

  test('la identidad sale intacta del merge', () => {
    const p = ok(obs('push', { verify_mode: 1 }), obs('att2000', { work_code: 'OT' }));
    for (const [k, v] of Object.entries(IDENTIDAD)) expect(p[k]).toBe(v);
  });
});

// ── Propiedades: el barrido ──────────────────────────────────────────

/**
 * Universo de observaciones. Cubre las tres fuentes, valores presentes y
 * ausentes, coincidentes y discrepantes, y distintos `received_at`.
 */
const UNIVERSO = [
  obs('push',    { verify_mode: 1,  work_code: 'A'  }),
  obs('push',    { verify_mode: 15, work_code: null }),
  obs('push',    { verify_mode: null, work_code: 'B', received_at: '2026-03-11T08:00:00-03:00' }),
  obs('polling', { verify_mode: 1,  work_code: 'A'  }),
  obs('polling', { verify_mode: 4,  work_code: 'C'  }),
  obs('polling', { verify_mode: null, work_code: null }),
  obs('att2000', { verify_mode: 3,  work_code: 'D', received_at: '2026-03-12T10:00:00-03:00' }),
  obs('att2000', { verify_mode: null, work_code: 'A' }),
  obs('push',    { verify_mode: 1,  work_code: 'A', raw_reference: 'push#1' }),

  // Clases que la primera versión del barrido NO cubría, y que escondían una
  // violación de conmutatividad en 8 de 64 pares: `received_at` nulo mezclado
  // con no nulo hacía que el comparador no fuera un orden total.
  obs('push',    { verify_mode: 0, work_code: '',   received_at: null }),
  obs('polling', { verify_mode: 0, work_code: 'A',  received_at: null }),
  obs('att2000', { verify_mode: 15, work_code: '0', received_at: null }),
  // Mismo instante, offset distinto: no puede ordenarse lexicográficamente.
  obs('push',    { verify_mode: 2, work_code: 'E', received_at: '2026-03-11T12:00:00+01:00' }),
];

const PARES = [];
for (const a of UNIVERSO) for (const b of UNIVERSO) PARES.push([a, b]);

const TRIOS = [];
for (const a of UNIVERSO) for (const b of UNIVERSO) for (const c of UNIVERSO) TRIOS.push([a, b, c]);

describe('propiedades algebraicas', () => {
  test(`conmutativa sobre ${PARES.length} pares: merge(a,b) ≡ merge(b,a)`, () => {
    const fallos = [];
    for (const [a, b] of PARES) {
      const ab = mergePunchObservations(a, b);
      const ba = mergePunchObservations(b, a);
      if (JSON.stringify(ab) !== JSON.stringify(ba)) {
        fallos.push({ a: a.source, b: b.source, ab: ab.punch, ba: ba.punch });
      }
    }
    expect(fallos).toEqual([]);
  });

  test(`idempotente sobre ${UNIVERSO.length} entradas: merge(a,a) ≡ merge(a)`, () => {
    const fallos = [];
    for (const a of UNIVERSO) {
      const sola = mergePunchObservations(a);
      const doble = mergePunchObservations(a, a);
      if (JSON.stringify(sola) !== JSON.stringify(doble)) fallos.push(a.source);
    }
    expect(fallos).toEqual([]);
  });

  test('idempotente sobre el resultado: merge(merge(x)) ≡ merge(x)', () => {
    const fallos = [];
    for (const [a, b] of PARES) {
      const p = ok(a, b);
      if (JSON.stringify(ok(p)) !== JSON.stringify(p)) fallos.push([a.source, b.source]);
    }
    expect(fallos).toEqual([]);
  });

  test(`asociativa sobre ${TRIOS.length} tríos: (a∘b)∘c ≡ a∘(b∘c) ≡ a∘b∘c`, () => {
    const fallos = [];
    for (const [a, b, c] of TRIOS) {
      const izq   = mergePunchObservations(ok(a, b), c);
      const der   = mergePunchObservations(a, ok(b, c));
      const plano = mergePunchObservations(a, b, c);

      const ji = JSON.stringify(izq), jd = JSON.stringify(der), jp = JSON.stringify(plano);
      if (ji !== jd || ji !== jp) {
        fallos.push({ fuentes: [a.source, b.source, c.source], izq: izq.punch, der: der.punch });
      }
    }
    expect(fallos.slice(0, 3)).toEqual([]);
    expect(fallos).toHaveLength(0);
  });

  test('el orden de llegada no cambia nada: todas las permutaciones coinciden', () => {
    const tres = [
      obs('att2000', { verify_mode: 3, work_code: 'D' }),
      obs('push',    { verify_mode: 1, work_code: null }),
      obs('polling', { verify_mode: 4, work_code: 'C' }),
    ];
    const perms = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ].map(p => JSON.stringify(ok(...p.map(i => tres[i]))));

    expect(new Set(perms).size).toBe(1);
  });
});

// ── El documento no puede mentir ─────────────────────────────────────

/**
 * En el PR del contrato v1 la documentación contradijo al código cuatro veces:
 * describía una regla que el módulo ya no implementaba. Estos tests atan el
 * .md al módulo para que no vuelva a pasar.
 */
describe('docs/punch-attribute-merge.md coincide con el módulo', () => {
  const fs = require('fs');
  const path = require('path');
  const DOC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs', 'punch-attribute-merge.md'), 'utf8');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'contracts', 'punchMerge.js'), 'utf8');

  test('la tabla de prioridades dice los mismos números que el código', () => {
    for (const [fuente, prioridad] of Object.entries(SOURCE_PRIORITY)) {
      expect(DOC).toContain(`${fuente} (${prioridad})`);
    }
  });

  test('todos los error_code del módulo están documentados', () => {
    for (const code of Object.values(MERGE_ERRORS)) {
      expect(DOC).toContain(code);
    }
  });

  test('el documento no inventa error_codes que no existen', () => {
    const enDoc = [...DOC.matchAll(/`(merge_[a-z_]+)`/g)].map(m => m[1]);
    const reales = Object.values(MERGE_ERRORS);
    expect([...new Set(enDoc)].filter(c => !reales.includes(c))).toEqual([]);
  });

  test('sigue sin haber una función ganadora() aparte', () => {
    // El documento afirma que la política vive en un solo lugar.
    expect(SRC).not.toMatch(/function ganadora\s*\(/);
  });

  test('la clave de dedupe sigue teniendo los campos de política al final', () => {
    const cuerpo = SRC.slice(
      SRC.indexOf('function claveObservacion'),
      SRC.indexOf('function compararObservaciones'),
    );
    const posSource = cuerpo.indexOf('o.source');
    const posAttrs  = cuerpo.indexOf('MERGEABLE_ATTRS');
    expect(posAttrs).toBeGreaterThan(-1);
    expect(posSource).toBeGreaterThan(posAttrs);   // source DESPUÉS de los atributos
  });

  test('el módulo sigue sin escribir en ningún lado', () => {
    // El documento promete que no guarda nada. Que se note si deja de ser cierto.
    expect(SRC).not.toMatch(/require\(['"](mysql|sequelize|ioredis|redis|fs)['"]\)/);
    expect(SRC).not.toMatch(/\bINSERT\b|\bUPDATE\b\s+\w+\s+SET/i);
  });
});

describe('invariantes que se cumplen siempre', () => {
  test('el valor elegido siempre es uno de los observados, nunca inventado', () => {
    for (const [a, b, c] of TRIOS.slice(0, 200)) {
      const p = ok(a, b, c);
      for (const attr of ['verify_mode', 'work_code']) {
        if (p[attr] === null) continue;
        const observados = p.observations.map(o => o[attr]);
        expect(observados).toContain(p[attr]);
      }
    }
  });

  test('attribute_conflict ⇔ hay dos valores no nulos distintos', () => {
    for (const [a, b, c] of TRIOS.slice(0, 200)) {
      const p = ok(a, b, c);
      const hayDiscrepancia = ['verify_mode', 'work_code'].some(attr => {
        const vals = new Set(p.observations.map(o => o[attr]).filter(v => v !== null));
        return vals.size > 1;
      });
      expect(p.attribute_conflict).toBe(hayDiscrepancia);
    }
  });

  test('ninguna observación se pierde por el camino', () => {
    for (const [a, b, c] of TRIOS.slice(0, 200)) {
      const p = ok(a, b, c);
      // Cada entrada tiene que estar representada por alguna observación.
      for (const entrada of [a, b, c]) {
        expect(p.observations.some(o =>
          o.source === entrada.source &&
          o.verify_mode === entrada.verify_mode &&
          o.work_code === entrada.work_code &&
          o.received_at === entrada.received_at,
        )).toBe(true);
      }
    }
  });

  test('el merge nunca muta sus entradas', () => {
    const a = obs('push', { verify_mode: 1 });
    const b = obs('polling', { verify_mode: 4 });
    const antesA = JSON.stringify(a), antesB = JSON.stringify(b);

    ok(a, b);

    expect(JSON.stringify(a)).toBe(antesA);
    expect(JSON.stringify(b)).toBe(antesB);
  });
});
