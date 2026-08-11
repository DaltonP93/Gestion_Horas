/**
 * PUSH en modo OBSERVE-ONLY, por reloj.
 *
 * La garantía central es negativa y muy concreta: para un reloj nombrado en
 * `BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST`, un ATTLOG válido se guarda en la
 * sombra y se responde OK al reloj, pero NO se publica asistencia por ningún
 * camino — ni `publishAttendance`, ni `xAdd`, ni `publish`, ni siquiera la
 * escritura de dedupe en Redis.
 *
 * La otra mitad importa igual: para cualquier reloj que NO esté nombrado, y
 * con la allowlist vacía, el comportamiento tiene que ser byte por byte el de
 * siempre. Una flag que apaga de más la publicación perdería marcaciones en
 * silencio: el reloj recibe OK, el operador ve tráfico, y la asistencia
 * simplemente no aparece.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');

const { createShadow } = require('../src/shadow');
const { pushMetrics, resetPushMetrics, getObserveOnlyAllowlist } = require('../src/pushServer');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const GERENCIA = { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-0001', test: false };
const COMEDOR  = { id: 2, name: 'Comedor',  ip: '10.0.0.12', port: 4370, serial: 'COM-0002', test: false };
const LAVADERO = { id: 3, name: 'Lavadero', ip: '10.0.0.13', port: 4370, serial: 'LAV-0003', test: false };
const RELOJES = [GERENCIA, COMEDOR, LAVADERO];

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-observe-'));
  delete process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST;
  resetPushMetrics();
  for (const k of Object.keys(require('../src/pushServer').pushState)) {
    delete require('../src/pushServer').pushState[k];
  }
});
afterEach(() => {
  delete process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Redis falso que registra TODO lo que se le pide. */
function redisFalso() {
  return {
    isReady: true,
    set: jest.fn(async () => 'OK'),
    publish: jest.fn(async () => 1),
    xAdd: jest.fn(async () => '1-1'),
  };
}

function bootApp(opts = {}) {
  const originalListen = express.application.listen;
  let capturedApp;
  express.application.listen = function () { capturedApp = this; return { close() {} }; };

  const publishAttendance = jest.fn();
  const { startPushServer } = require('../src/pushServer');
  startPushServer(publishAttendance, opts.logger || logger, { devices: RELOJES, ...opts });

  express.application.listen = originalListen;
  return { app: capturedApp, publishAttendance, redis: opts.redis };
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

const ATTLOG = (userId, ts, status = '0', verify = '1', work = '0') =>
  `${userId}\t${ts}\t${status}\t${verify}\t${work}`;

async function enviar(app, body, sn) {
  return request(app)
    .post(`/iclock/cdata?SN=${sn}&table=ATTLOG`)
    .set('Content-Type', 'text/plain')
    .send(body);
}

// ── El test crítico ──────────────────────────────────────────────────

describe('un reloj observe-only se observa y NO se publica', () => {
  beforeEach(() => { process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia'; });

  test('guarda en la sombra, responde OK y no publica por ningún camino', async () => {
    const s = sombraEncendida();
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });

    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    // 1. el reloj recibe el protocolo de siempre
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');

    // 2. la observación se guardó
    expect(s.store.stats().stored).toBe(1);

    // 3. y NADA salió hacia asistencia
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();

    // 4. ni siquiera la escritura de dedupe: SET NX escribe en Redis, y la
    //    sombra ya es idempotente por event_id.
    expect(redis.set).not.toHaveBeenCalled();

    s.stop();
  });

  test('las métricas cuentan lo observado y lo suprimido', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s, redis: redisFalso() });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(pushMetrics.observe_only_received).toBe(1);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(1);
    s.stop();
  });

  test('varios eventos en un POST se observan todos y no se publica ninguno', async () => {
    const s = sombraEncendida();
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });

    await enviar(app, [
      ATTLOG('1', '2026-03-11 08:00:00'),
      ATTLOG('2', '2026-03-11 08:01:00'),
      ATTLOG('3', '2026-03-11 08:02:00'),
    ].join('\n'), 'GER-0001');

    expect(s.store.stats().stored).toBe(3);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(3);
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    s.stop();
  });

  test('un ATTLOG duplicado no publica ni duplica la observación', async () => {
    const s = sombraEncendida();
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });
    const lote = ATTLOG('1042', '2026-03-11 08:15:00');

    await enviar(app, lote, 'GER-0001');
    await enviar(app, lote, 'GER-0001');

    expect(s.store.stats().stored).toBe(1);
    expect(s.metrics.duplicates).toBe(1);
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();   // el dedupe nunca corrió
    s.stop();
  });
});

// ── Identidad ────────────────────────────────────────────────────────

describe('a quién se le aplica', () => {
  test('el serial en otra capitalización sigue siendo el mismo reloj', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'GER-0001';
    const s = sombraEncendida();
    const { app, publishAttendance } = bootApp({ shadow: s, redis: redisFalso() });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'ger-0001');

    expect(publishAttendance).not.toHaveBeenCalled();
    s.stop();
  });

  test('y al revés: allowlist en minúsculas, reloj en mayúsculas', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'ger-0001';
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(publishAttendance).not.toHaveBeenCalled();
  });

  test('se puede nombrar por nombre de ZKTECO_DEVICES', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'gerencia';
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(publishAttendance).not.toHaveBeenCalled();
  });

  test('la identidad la resuelve el mismo módulo que usa la sombra', () => {
    // Si las reglas divergieran, un reloj podría quedar observado por la
    // sombra y publicado por el PUSH a la vez.
    const identidad = fs.readFileSync(path.join(__dirname, '../src/deviceIdentity.js'), 'utf8');
    const push = fs.readFileSync(path.join(__dirname, '../src/pushServer.js'), 'utf8');
    const shadow = fs.readFileSync(path.join(__dirname, '../src/shadow.js'), 'utf8');

    expect(push).toContain("require('./deviceIdentity')");
    expect(shadow).toContain("require('./deviceIdentity')");
    // Y ninguno de los dos redefine la canonización por su cuenta.
    expect(push).not.toMatch(/function canonicalSerial/);
    expect(shadow).not.toMatch(/function canonicalSerial/);
    expect(identidad).toMatch(/function canonicalSerial/);
  });
});

// ── Los demás relojes no se tocan ────────────────────────────────────

describe('un reloj NO nombrado conserva el comportamiento actual', () => {
  beforeEach(() => { process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia'; });

  test('Comedor publica normalmente', async () => {
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ redis });

    const res = await enviar(app, ATTLOG('2001', '2026-03-11 08:15:00'), 'COM-0002');

    expect(res.status).toBe(200);
    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);   // el dedupe sí corre
    expect(pushMetrics.observe_only_suppressed_publish).toBe(0);
  });

  test('en el mismo lote, sólo el reloj nombrado queda suprimido', async () => {
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ redis });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');
    await enviar(app, ATTLOG('2001', '2026-03-11 08:16:00'), 'COM-0002');
    await enviar(app, ATTLOG('3001', '2026-03-11 08:17:00'), 'LAV-0003');

    // Sólo Comedor y Lavadero publicaron.
    expect(publishAttendance).toHaveBeenCalledTimes(2);
    const codigos = publishAttendance.mock.calls.map(([e]) => e.employeeCode);
    expect(codigos).toEqual(['2001', '3001']);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(1);
  });

  test('un reloj desconocido, que ni está configurado, publica igual', async () => {
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    await enviar(app, ATTLOG('9001', '2026-03-11 08:15:00'), 'DESCONOCIDO-9');

    expect(publishAttendance).toHaveBeenCalledTimes(1);
  });
});

// ── Allowlist vacía: comportamiento histórico ────────────────────────

describe('con la allowlist vacía nada cambia', () => {
  test('todos los relojes publican, incluido Gerencia', async () => {
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ redis });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(pushMetrics.observe_only_received).toBe(0);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(0);
  });

  test('la variable sin definir se lee como lista vacía', () => {
    delete process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST;
    expect(getObserveOnlyAllowlist()).toEqual([]);
  });

  test('una lista de sólo comas y espacios también es vacía', () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = ' , ,, ';
    expect(getObserveOnlyAllowlist()).toEqual([]);
  });

  test('con la sombra encendida pero la allowlist vacía, se publica igual', async () => {
    // Ésta es la distinción que el PR existe para hacer explícita:
    // BRIDGE_SHADOW_ENABLED=true NO implica observe-only.
    const s = sombraEncendida();
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(s.store.stats().stored).toBe(1);        // se observó
    expect(publishAttendance).toHaveBeenCalledTimes(1);   // Y ADEMÁS se publicó
    s.stop();
  });
});

// ── Independencia de la sombra ───────────────────────────────────────

describe('observe-only no depende de que la sombra funcione', () => {
  beforeEach(() => { process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia'; });

  test('con la sombra APAGADA, tampoco se publica', async () => {
    // Sin esto, apagar la sombra convertiría al reloj en productor de golpe.
    const apagada = createShadow({
      env: { BRIDGE_SHADOW_ENABLED: 'false' },
      devices: RELOJES, logger,
    });
    apagada.start();
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: apagada, redis });

    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(res.status).toBe(200);
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  test('sin sombra en las opciones, tampoco se publica', async () => {
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ redis });

    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(res.status).toBe(200);
    expect(publishAttendance).not.toHaveBeenCalled();
  });

  test('con el almacén roto, tampoco se publica', async () => {
    const s = sombraEncendida();
    s.store.record = () => { throw new Error('disco lleno'); };
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });

    const res = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    expect(res.status).toBe(200);
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(s.metrics.errors).toBe(1);
    s.stop();
  });

  test('con capture() reventando, tampoco se publica ni se pierde el protocolo', async () => {
    const s = sombraEncendida();
    s.capture = () => { throw new Error('sombra reventada'); };
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });

    const res = await enviar(app, [
      ATTLOG('1', '2026-03-11 08:00:00'),
      ATTLOG('2', '2026-03-11 08:01:00'),
    ].join('\n'), 'GER-0001');

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(pushMetrics.observe_only_suppressed_publish).toBe(2);
    s.stop();
  });
});

// ── Protocolo del reloj ──────────────────────────────────────────────

describe('el reloj no nota la diferencia', () => {
  beforeEach(() => { process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia'; });

  test('el registro inicial responde la misma configuración', async () => {
    const { app } = bootApp({ redis: redisFalso() });
    const res = await request(app).get('/iclock/cdata?SN=GER-0001&options=all');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Realtime=1');
    expect(res.text).toContain('TransFlag=TransData AttLog OpLog');
  });

  test('el heartbeat responde OK y no cuenta como observación', async () => {
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });
    const res = await request(app).get('/iclock/getrequest?SN=GER-0001');

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(pushMetrics.observe_only_received).toBe(0);
    expect(publishAttendance).not.toHaveBeenCalled();
  });

  test('la respuesta al ATTLOG es idéntica a la de un reloj normal', async () => {
    const { app } = bootApp({ redis: redisFalso() });

    const observado = await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');
    const normal    = await enviar(app, ATTLOG('2001', '2026-03-11 08:15:00'), 'COM-0002');

    expect(observado.status).toBe(normal.status);
    expect(observado.text).toBe(normal.text);
    expect(observado.headers['content-type']).toBe(normal.headers['content-type']);
  });

  test('devicecmd sigue respondiendo OK', async () => {
    const { app } = bootApp({ redis: redisFalso() });
    const res = await request(app).post('/iclock/devicecmd?SN=GER-0001').send('');
    expect(res.status).toBe(200);
  });
});

// ── Diagnóstico ──────────────────────────────────────────────────────

describe('pushState sigue sirviendo para diagnosticar', () => {
  beforeEach(() => { process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia'; });

  test('lastSeen, lastPunch y el conteo se mantienen', async () => {
    const { app } = bootApp({ redis: redisFalso() });
    const { pushState } = require('../src/pushServer');

    await enviar(app, [
      ATTLOG('1', '2026-03-11 08:00:00'),
      ATTLOG('2', '2026-03-11 08:01:00'),
    ].join('\n'), 'GER-0001');

    const estado = pushState['GER-0001'];
    expect(estado.lastSeen).toBeTruthy();
    expect(estado.lastPunch).toBeTruthy();
    expect(estado.punches).toBe(2);
    // Un reloj en observación no puede verse igual que uno desconectado.
    expect(estado.observeOnly).toBe(true);
  });

  test('un reloj normal no queda marcado como observe-only', async () => {
    const { app } = bootApp({ redis: redisFalso() });
    const { pushState } = require('../src/pushServer');

    await enviar(app, ATTLOG('2001', '2026-03-11 08:15:00'), 'COM-0002');

    expect(pushState['COM-0002'].observeOnly).toBeUndefined();
    expect(pushState['COM-0002'].punches).toBe(1);
  });
});

// ── Sin datos personales ─────────────────────────────────────────────

describe('nada personal en métricas ni logs', () => {
  test('las métricas son sólo números', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia';
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s, redis: redisFalso() });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    for (const v of Object.values(pushMetrics)) expect(typeof v).toBe('number');
    expect(JSON.stringify(pushMetrics)).not.toContain('1042');
    s.stop();
  });

  test('el log de observe-only no lleva IP ni código de empleado', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia';
    const lineas = [];
    const espia = { info: m => lineas.push(m), warn: m => lineas.push(m), error: m => lineas.push(m), debug: () => {} };
    const { app } = bootApp({ redis: redisFalso(), logger: espia });

    await enviar(app, ATTLOG('1042', '2026-03-11 08:15:00'), 'GER-0001');

    const salida = lineas.join('\n');
    expect(salida).toContain('observe-only');
    expect(salida).not.toContain('1042');
    expect(salida).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });
});

// ── Ambigüedad ───────────────────────────────────────────────────────

describe('un reloj no identificable no entra en observe-only', () => {
  // La ambigüedad se ejercita a nivel de la regla —en deviceIdentity.test.js—
  // porque por HTTP la petición llega siempre desde loopback y la IP del
  // cliente no se puede fijar de forma determinista. Acá se prueba lo que sí
  // depende del servidor: que un PUSH sin serial no quede suprimido por
  // accidente.

  test('un PUSH sin serial no cae en observe-only por casualidad', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'Gerencia';
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    await request(app)
      .post('/iclock/cdata?SN=&table=ATTLOG')
      .set('Content-Type', 'text/plain')
      .send(ATTLOG('1042', '2026-03-11 08:15:00'));

    // No se pudo identificar como Gerencia, así que se procesa normal: la
    // dirección de fallo segura es publicar, no perder la marcación.
    expect(publishAttendance).toHaveBeenCalledTimes(1);
  });
});
