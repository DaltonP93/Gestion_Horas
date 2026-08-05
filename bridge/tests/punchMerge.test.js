/**
 * Reconciliación de atributos, lado Bridge.
 *
 * Es el mismo archivo de contrato para los dos procesos (contracts/), pero eso
 * por sí solo no garantiza nada: lo que hay que probar es que el Bridge y la
 * API, viendo las MISMAS observaciones, resuelven la misma marcación. Si
 * divergieran, el Bridge podría deduplicar un reenvío que la API considera dos
 * marcaciones distintas, o al revés.
 *
 * El escenario real que motiva esto: el reloj manda un lote por PUSH, el Bridge
 * no recibe el ACK a tiempo y lo reenvía; en el medio el polling ya leyó la
 * misma marcación de la memoria del reloj, con verify_mode distinto porque la
 * lectura tardía trae otro valor. Las tres observaciones son la misma marcación.
 */
const { mergePunchObservations, SOURCE_PRIORITY } = require('../../contracts/punchMerge');
const { buildEvent } = require('../../contracts/punchContractV1');

const BASE = buildEvent({
  device_id: 3,
  device_user_id: '0117',
  occurred_at: '2026-03-11T17:45:02-03:00',
  event_type: 'out',
});

const IDENTIDAD = {
  event_id:       BASE.event.event_id,
  device_id:      BASE.event.device_id,
  device_user_id: BASE.event.device_user_id,
  occurred_at:    BASE.event.occurred_at,
  event_type:     BASE.event.event_type,
};

/** Lo que emitiría el Bridge desde una línea ATTLOG del PUSH. */
function observacionPush(verify, workCode, recibidoEn) {
  return {
    ...IDENTIDAD,
    source: 'push',
    verify_mode: verify,
    work_code: workCode,
    raw_reference: 'attlog:lote-4#12',
    received_at: recibidoEn,
  };
}

/** Lo que emitiría el lector node-zklib al barrer la memoria del reloj. */
function observacionPolling(verify, workCode, recibidoEn) {
  return {
    ...IDENTIDAD,
    source: 'polling',
    verify_mode: verify,
    work_code: workCode,
    raw_reference: 'zklib:offset-891',
    received_at: recibidoEn,
  };
}

/** Lo que emitiría la importación desde att2000. */
function observacionAtt2000(verify, workCode, recibidoEn) {
  return {
    ...IDENTIDAD,
    source: 'att2000',
    verify_mode: verify,
    work_code: workCode,
    raw_reference: 'CHECKINOUT:8812',
    received_at: recibidoEn,
  };
}

describe('el Bridge y la API resuelven igual', () => {
  const observaciones = [
    observacionPush(1, null, '2026-03-11T17:45:04-03:00'),
    observacionPolling(4, 'OT', '2026-03-11T18:00:00-03:00'),
    observacionAtt2000(3, 'OT', '2026-03-12T02:00:00-03:00'),
  ];

  test('el resultado no depende del orden en que llegaron', () => {
    // El Bridge las ve en orden de recepción; la API puede procesarlas en
    // cualquier orden al drenar la cola.
    const ordenBridge = mergePunchObservations(...observaciones);
    const ordenApi    = mergePunchObservations(...[...observaciones].reverse());

    expect(ordenBridge).toEqual(ordenApi);
  });

  test('una sola marcación, no tres', () => {
    const { punch } = mergePunchObservations(...observaciones);
    expect(punch.event_id).toBe(IDENTIDAD.event_id);
    expect(punch.sources).toEqual(['push', 'polling', 'att2000']);
  });

  test('gana el verify_mode del PUSH, que es lo que emitió el reloj', () => {
    const { punch } = mergePunchObservations(...observaciones);
    expect(punch.verify_mode).toBe(1);
    expect(punch.attribute_conflict).toBe(true);
  });

  test('el work_code que el PUSH no traía se toma del polling, sin conflicto', () => {
    const { punch } = mergePunchObservations(...observaciones);
    expect(punch.work_code).toBe('OT');
    // polling y att2000 coinciden en 'OT' y el push no aporta: no hay discrepancia
    expect(punch.conflicts.map(c => c.attribute)).toEqual(['verify_mode']);
  });

  test('el reenvío del lote PUSH no duplica ni cambia nada', () => {
    const unaVez  = mergePunchObservations(...observaciones);
    const conReenvio = mergePunchObservations(...observaciones, observaciones[0]);

    expect(conReenvio).toEqual(unaVez);
  });

  test('fusionar por partes da lo mismo que fusionar de una', () => {
    const porPartes = mergePunchObservations(
      mergePunchObservations(observaciones[0], observaciones[1]).punch,
      observaciones[2],
    );
    const deUna = mergePunchObservations(...observaciones);

    expect(porPartes).toEqual(deUna);
  });
});

describe('el conflicto queda auditable del lado del Bridge', () => {
  test('se conserva quién dijo qué', () => {
    const { punch } = mergePunchObservations(
      observacionPush(1, null, '2026-03-11T17:45:04-03:00'),
      observacionPolling(4, null, '2026-03-11T18:00:00-03:00'),
    );

    const c = punch.conflicts[0];
    expect(c.chosen).toBe(1);
    expect(c.chosen_source).toBe('push');
    expect(c.observed).toEqual([
      { source: 'push',    value: 1, received_at: '2026-03-11T17:45:04-03:00' },
      { source: 'polling', value: 4, received_at: '2026-03-11T18:00:00-03:00' },
    ]);
  });

  test('la observación descartada sigue completa', () => {
    const { punch } = mergePunchObservations(
      observacionPush(1, null, '2026-03-11T17:45:04-03:00'),
      observacionPolling(4, null, '2026-03-11T18:00:00-03:00'),
    );

    const descartada = punch.observations.find(o => o.source === 'polling');
    expect(descartada.verify_mode).toBe(4);
    expect(descartada.raw_reference).toBe('zklib:offset-891');
  });
});

describe('la prioridad es la misma en los dos procesos', () => {
  test('push > polling > att2000', () => {
    expect(SOURCE_PRIORITY).toEqual({ push: 3, polling: 2, att2000: 1 });
  });
});
