/**
 * Modo sombra enganchado al servidor PUSH.
 *
 * La garantía central de este archivo es negativa: encender la sombra no puede
 * cambiar NADA de lo que el PUSH ya hacía, y romperla tampoco. Un observador
 * que puede tirar abajo lo observado no es un observador, es un riesgo nuevo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');

const { createShadow } = require('../src/shadow');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const RELOJES = [
  { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-0001', test: false },
  { id: 2, name: 'Comedor',  ip: '10.0.0.12', port: 4370, serial: 'COM-0002', test: false },
];

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-shadow-push-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

/** Arranca el pushServer sin bindear puerto (misma técnica que pushServer.test.js). */
function bootApp(opts = {}) {
  const originalListen = express.application.listen;
  let capturedApp;
  express.application.listen = function () { capturedApp = this; return { close() {} }; };

  const publishAttendance = jest.fn();
  const { startPushServer } = require('../src/pushServer');
  startPushServer(publishAttendance, logger, opts);

  express.application.listen = originalListen;
  return { app: capturedApp, publishAttendance };
}

function sombraEncendida(extra = {}) {
  const s = createShadow({
    env: {
      BRIDGE_SHADOW_ENABLED: 'true',
      BRIDGE_SHADOW_PATH: path.join(dir, 'shadow.db'),
      BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia',
      ...extra,
    },
    devices: RELOJES,
    logger,
  });
  s.start();
  return s;
}

/** Línea ATTLOG: UserID \t DateTime \t Status \t Verify \t WorkCode */
const ATTLOG = (userId, ts, status = '0', verify = '1', work = '0') =>
  `${userId}\t${ts}\t${status}\t${verify}\t${work}`;

async function enviar(app, body, sn = 'GER-0001') {
  return request(app)
    .post(`/iclock/cdata?SN=${sn}&table=ATTLOG`)
    .set('Content-Type', 'text/plain')
    .send(body);
}

// ── Sin sombra: nada cambia ──────────────────────────────────────────

describe('sin sombra en las opciones', () => {
  test('el PUSH funciona igual que siempre', async () => {
    const { app, publishAttendance } = bootApp();
    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(publishAttendance).toHaveBeenCalledTimes(1);
  });

  test('no se crea ningún archivo', async () => {
    const { app } = bootApp();
    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// ── Con la flag apagada ──────────────────────────────────────────────

describe('con la sombra apagada', () => {
  test('el PUSH no cambia y no se escribe nada', async () => {
    const apagada = createShadow({
      env: { BRIDGE_SHADOW_ENABLED: 'false', BRIDGE_SHADOW_PATH: path.join(dir, 'shadow.db') },
      devices: RELOJES, logger,
    });
    apagada.start();

    const { app, publishAttendance } = bootApp({ shadow: apagada });
    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(res.status).toBe(200);
    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(apagada.metrics.events_received).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// ── Con la sombra encendida ──────────────────────────────────────────

describe('con la sombra encendida', () => {
  test('el PUSH sigue publicando exactamente lo mismo', async () => {
    const s = sombraEncendida();
    const { app, publishAttendance } = bootApp({ shadow: s });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(publishAttendance).toHaveBeenCalledTimes(1);
    const evento = publishAttendance.mock.calls[0][0];
    expect(evento.employeeCode).toBe('1042');
    expect(evento.type).toBe('in');
    expect(evento.deviceSn).toBe('GER-0001');
    s.stop();
  });

  test('y además observa el marcaje', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(s.metrics.persisted).toBe(1);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('un lote de varias líneas se observa entero', async () => {
    const s = sombraEncendida();
    const { app, publishAttendance } = bootApp({ shadow: s });

    await enviar(app, [
      ATTLOG('1', '2026-03-11 08:00:00'),
      ATTLOG('2', '2026-03-11 08:01:00'),
      ATTLOG('3', '2026-03-11 08:02:00'),
    ].join('\n'));

    expect(publishAttendance).toHaveBeenCalledTimes(3);
    expect(s.metrics.persisted).toBe(3);
    s.stop();
  });

  test('un reloj fuera de la allowlist se publica pero no se observa', async () => {
    const s = sombraEncendida();
    const { app, publishAttendance } = bootApp({ shadow: s });

    await enviar(app, ATTLOG('2001', '2026-03-11 08:15:00'), 'COM-0002');

    expect(publishAttendance).toHaveBeenCalledTimes(1);   // el PUSH no se toca
    expect(s.metrics.skipped_not_allowed).toBe(1);
    expect(s.store.stats().stored).toBe(0);
    s.stop();
  });

  test('la hora observada no depende de la zona del proceso', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    const fila = s.store.db.prepare('SELECT occurred_at FROM shadow_events').get();
    expect(fila.occurred_at).toBe('2026-03-11T11:15:00Z');
    s.stop();
  });

  test('el verify y el work_code del ATTLOG llegan a la observación', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00', '0', '15', '77'));

    const p = JSON.parse(s.store.db.prepare('SELECT payload FROM shadow_events').get().payload);
    expect(p.verify_mode).toBe(15);
    expect(p.work_code).toBe('77');
    s.stop();
  });
});

// ── El fallo de la sombra no escala ──────────────────────────────────

describe('una sombra rota no rompe el PUSH', () => {
  function sombraQueRevienta() {
    const s = sombraEncendida();
    s.capture = () => { throw new Error('sombra reventada'); };
    return s;
  }

  test('el reloj sigue recibiendo 200 OK', async () => {
    const { app } = bootApp({ shadow: sombraQueRevienta() });
    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });

  test('la marcación se publica igual', async () => {
    const { app, publishAttendance } = bootApp({ shadow: sombraQueRevienta() });
    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(publishAttendance).toHaveBeenCalledTimes(1);
  });

  test('un lote entero se procesa aunque la sombra falle en cada línea', async () => {
    const { app, publishAttendance } = bootApp({ shadow: sombraQueRevienta() });

    await enviar(app, [
      ATTLOG('1', '2026-03-11 08:00:00'),
      ATTLOG('2', '2026-03-11 08:01:00'),
      ATTLOG('3', '2026-03-11 08:02:00'),
    ].join('\n'));

    expect(publishAttendance).toHaveBeenCalledTimes(3);
  });

  test('con el almacén caído tampoco se pierde una marcación', async () => {
    const s = sombraEncendida();
    s.store.record = () => { throw new Error('disco lleno'); };
    const { app, publishAttendance } = bootApp({ shadow: s });

    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(res.status).toBe(200);
    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(s.metrics.errors).toBe(1);
    s.stop();
  });

  test('sin SQLite disponible el PUSH tampoco se entera', async () => {
    const s = createShadow({
      env: {
        BRIDGE_SHADOW_ENABLED: 'true',
        BRIDGE_SHADOW_DEVICE_ALLOWLIST: 'Gerencia',
        // sin BRIDGE_SHADOW_PATH: la sombra no puede abrir nada
      },
      devices: RELOJES, logger,
    });
    s.start();

    const { app, publishAttendance } = bootApp({ shadow: s });
    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(res.status).toBe(200);
    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(s.opened).toBe(false);
  });
});

// ── Duplicados ───────────────────────────────────────────────────────

describe('reenvíos del reloj', () => {
  test('el mismo lote dos veces no duplica la observación', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });
    const lote = ATTLOG('1042', '2026-03-11 08:15:00');

    await enviar(app, lote);
    await enviar(app, lote);

    expect(s.metrics.persisted).toBe(1);
    expect(s.metrics.duplicates).toBe(1);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('la sombra observa el reenvío aunque el dedupe de Redis lo descarte', async () => {
    // La sombra mide lo que el reloj EMITIÓ. Filtrar acá la volvería ciega a
    // los reenvíos, que es una de las cosas que se quiere cuantificar.
    const s = sombraEncendida();
    const visto = new Set();
    const redisFalso = {
      isReady: true,
      set: async (k) => (visto.has(k) ? null : (visto.add(k), 'OK')),
    };
    const { app, publishAttendance } = bootApp({ shadow: s, redis: redisFalso });
    const lote = ATTLOG('1042', '2026-03-11 08:15:00');

    await enviar(app, lote);
    await enviar(app, lote);

    expect(publishAttendance).toHaveBeenCalledTimes(1);   // el dedupe hizo su trabajo
    expect(s.metrics.events_received).toBe(2);            // la sombra vio las dos
    expect(s.metrics.duplicates).toBe(1);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });
});

// ── Ningún efecto colateral ──────────────────────────────────────────

describe('la sombra no produce efectos hacia afuera', () => {
  test('no publica en Redis por su cuenta', async () => {
    const s = sombraEncendida();
    const redisFalso = { isReady: true, set: jest.fn(async () => 'OK'), publish: jest.fn(), xAdd: jest.fn() };
    const { app } = bootApp({ shadow: s, redis: redisFalso });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    // El único uso de Redis es el dedupe que ya existía.
    expect(redisFalso.publish).not.toHaveBeenCalled();
    expect(redisFalso.xAdd).not.toHaveBeenCalled();
    expect(redisFalso.set).toHaveBeenCalledTimes(1);
    s.stop();
  });

  test('no llama a publishAttendance de más', async () => {
    const s = sombraEncendida();
    const { app, publishAttendance } = bootApp({ shadow: s });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    // Una marcación, una publicación: la sombra no es un productor nuevo.
    expect(publishAttendance).toHaveBeenCalledTimes(1);
    s.stop();
  });

  test('la respuesta al reloj es la de siempre, sin rastro de la sombra', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });

    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'));

    expect(res.text).toBe('OK');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    s.stop();
  });

  test('el registro del reloj (GET) no toca la sombra', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });

    await request(app).get('/iclock/cdata?SN=GER-0001&options=all');

    expect(s.metrics.events_received).toBe(0);
    s.stop();
  });

  test('el heartbeat no toca la sombra', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s });

    await request(app).get('/iclock/getrequest?SN=GER-0001');

    expect(s.metrics.events_received).toBe(0);
    s.stop();
  });
});
