/**
 * Compatibilidad cruzada del contrato v1: lo que genera el Bridge tiene que
 * validarlo la API, y ambos tienen que calcular el MISMO event_id.
 *
 * Es el mismo archivo de contrato para los dos lados (contracts/), justamente
 * para que no puedan divergir: un event_id distinto entre procesos duplicaría
 * marcaciones en silencio.
 */
const path = require('path');
const fs = require('fs');

const C = require('../../contracts/punchContractV1');
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'fixtures', 'punches-v1.json'), 'utf8')
);

/** Lo que haría el Bridge con una línea ATTLOG del PUSH, sin tocar el pipeline real. */
function eventoDesdeAttlog(linea, deviceId) {
  const [userId, ts, status, verify, workCode] = linea.split('\t');
  const tipos = ['in', 'out', 'break_start', 'break_end', 'in', 'out'];
  return C.buildEvent({
    device_id: deviceId,
    device_user_id: userId,
    occurred_at: ts,
    event_type: tipos[Number(status)] || 'unknown',
    verify_mode: verify,
    work_code: workCode,
  });
}

describe('el Bridge genera y la API valida', () => {
  const { origen_push_attlog } = FIXTURES;

  test('un lote armado desde ATTLOG pasa la validación completa', () => {
    const eventos = origen_push_attlog.lineas.map(l => eventoDesdeAttlog(l, origen_push_attlog.device_id));
    expect(eventos.every(e => e.ok)).toBe(true);

    const { batch } = C.buildBatch({
      bridge_id: 'bridge-demo',
      device_id: origen_push_attlog.device_id,
      events: eventos.map(e => e.event),
    });

    const r = C.validateBatch(batch, { now: Date.parse('2026-08-04T18:00:00Z') });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3);
  });

  test('el lote no arrastra el SN ni la IP del reloj', () => {
    const eventos = origen_push_attlog.lineas.map(l => eventoDesdeAttlog(l, 1));
    const { batch } = C.buildBatch({ bridge_id: 'b', device_id: 1, events: eventos.map(e => e.event) });
    const json = JSON.stringify(batch);

    expect(json).not.toContain(origen_push_attlog.device_ip);
    expect(json).not.toContain(origen_push_attlog.device_sn);
  });

  test('el event_id sobrevive a serializar y volver a leer', () => {
    const original = eventoDesdeAttlog(origen_push_attlog.lineas[0], 1).event;
    const ida = JSON.parse(JSON.stringify(original));

    expect(C.computeEventId(ida)).toBe(original.event_id);
  });

  test('reenviar el mismo marcaje en otro lote da el mismo event_id', () => {
    const uno = C.buildBatch({ bridge_id: 'b1', device_id: 1, events: [eventoDesdeAttlog(origen_push_attlog.lineas[0], 1).event] });
    const dos = C.buildBatch({ bridge_id: 'b2', device_id: 1, events: [eventoDesdeAttlog(origen_push_attlog.lineas[0], 1).event] });

    // batch_id, bridge_id y generated_at cambian; la identidad del evento no.
    expect(uno.batch.batch_id).not.toBe(dos.batch.batch_id);
    expect(uno.batch.events[0].event_id).toBe(dos.batch.events[0].event_id);
  });

  test('el orden dentro del lote no afecta a ningún event_id', () => {
    const eventos = origen_push_attlog.lineas.map(l => eventoDesdeAttlog(l, 1).event);
    const alReves = [...eventos].reverse();

    expect(alReves.map(e => e.event_id).sort()).toEqual(eventos.map(e => e.event_id).sort());
  });

  test('dos marcajes distintos en el mismo segundo conservan identidades distintas', () => {
    // Dos usuarios fichando a la vez: mismo segundo, distinto empleado.
    const [a, b] = [origen_push_attlog.lineas[0], origen_push_attlog.lineas[2]]
      .map(l => eventoDesdeAttlog(l, 1).event);

    expect(a.occurred_at).toBe(b.occurred_at);
    expect(a.event_id).not.toBe(b.event_id);
  });
});

describe('un lote de otro emisor no se acepta a ciegas', () => {
  const AHORA = Date.parse('2026-08-04T18:00:00Z');

  test('un event_id calculado con otras reglas se rechaza', () => {
    const evento = eventoDesdeAttlog(FIXTURES.origen_push_attlog.lineas[0], 1).event;
    const { batch } = C.buildBatch({ bridge_id: 'b', device_id: 1, events: [evento] });
    // Un emisor que no quitara los ceros a la izquierda calcularía otro hash.
    batch.events[0].event_id = C.computeEventId({ ...batch.events[0], device_user_id: '0042' });

    expect(C.validateBatch(batch, { now: AHORA }).error_code).toBe(C.REJECT_CODES.EVENT_ID_MISMATCH);
  });

  test('un lote sin eventos se rechaza', () => {
    const { batch } = C.buildBatch({ bridge_id: 'b', device_id: 1, events: [eventoDesdeAttlog(FIXTURES.origen_push_attlog.lineas[0], 1).event] });
    expect(C.validateBatch({ ...batch, events: [] }, { now: AHORA }).error_code).toBe(C.REJECT_CODES.BATCH_EMPTY);
  });
});

describe('el contrato no toca el pipeline', () => {
  test('el módulo no depende de nada del Bridge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'punchContractV1.js'), 'utf8');
    for (const prohibido of ['node-zklib', 'redis', 'express', './pushServer', './zkManager']) {
      expect(src).not.toContain(`require('${prohibido}`);
    }
  });

  test('el Bridge no lo importa todavía: el contrato está definido, no conectado', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const push  = fs.readFileSync(path.join(__dirname, '..', 'src', 'pushServer.js'), 'utf8');

    expect(index).not.toContain('punchContractV1');
    expect(push).not.toContain('punchContractV1');
  });
});
