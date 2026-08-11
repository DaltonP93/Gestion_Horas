/**
 * Endpoints de sombra en la API del Bridge.
 *
 * Lo que se prueba acá es sobre todo el control de acceso: la sombra acumula
 * observaciones y su vaciado es destructivo, así que ninguna de estas rutas
 * puede quedar del lado abierto de la API —el de `/health`—, y borrar tiene
 * que costar más que acertarle a la URL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { execFileSync } = require('child_process');

const { createShadow } = require('../src/shadow');

const RELOJES = [
  { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-0001', test: false },
];

const RESOLUCION = {
  devices: RELOJES,
  source: 'zkteco_devices_env',
  degraded: false,
  problems: [],
};

const CLAVE = 'clave-de-prueba';

let dir;
let envOriginal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-shadow-api-'));
  envOriginal = { ...process.env };
  process.env.BRIDGE_API_KEY = CLAVE;
});

afterEach(() => {
  process.env = envOriginal;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  // Sin jest.resetModules(): reiniciar el registro le daría a index.js una
  // instancia de express DISTINTA de la que parchea este test, y app.listen
  // volvería a ser el real — que intenta bindear 8081 de verdad.
});

/** Levanta la API del Bridge sin bindear puerto. */
function bootApi(shadow) {
  const originalListen = express.application.listen;
  let capturada;
  express.application.listen = function () { capturada = this; return { close() {} }; };

  const { startBridgeApi } = require('../src/index');
  startBridgeApi(RELOJES, RESOLUCION, shadow);

  express.application.listen = originalListen;
  return capturada;
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
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  s.start();
  return s;
}

function obs(extra = {}) {
  return {
    sn: 'GER-0001',
    ip: '10.0.0.11',
    deviceUserId: '1042',
    occurredAtRaw: '2026-03-11 08:15:00',
    eventType: 'in',
    verifyMode: '1',
    ...extra,
  };
}

// ── Autenticación ────────────────────────────────────────────────────

describe('las rutas de sombra exigen la clave de la API', () => {
  test('GET /shadow/status sin clave responde 401', async () => {
    const s = sombraEncendida();
    const res = await request(bootApi(s)).get('/shadow/status');

    expect(res.status).toBe(401);
    s.stop();
  });

  test('GET /shadow/compare sin clave responde 401', async () => {
    const s = sombraEncendida();
    const res = await request(bootApi(s)).get('/shadow/compare');

    expect(res.status).toBe(401);
    s.stop();
  });

  test('POST /shadow/purge sin clave responde 401', async () => {
    const s = sombraEncendida();
    s.capture(obs());

    const res = await request(bootApi(s)).post('/shadow/purge').send({ confirm: true });

    expect(res.status).toBe(401);
    expect(s.store.stats().stored).toBe(1);   // no borró nada
    s.stop();
  });

  test('con clave equivocada tampoco', async () => {
    const s = sombraEncendida();
    s.capture(obs());

    const res = await request(bootApi(s))
      .post('/shadow/purge')
      .set('x-api-key', 'otra')
      .send({ confirm: true });

    expect(res.status).toBe(401);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('/health sigue abierto y no menciona la sombra', async () => {
    const s = sombraEncendida();
    const res = await request(bootApi(s)).get('/health');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/shadow|sombra/i);
    s.stop();
  });
});

// ── Estado ───────────────────────────────────────────────────────────

describe('GET /shadow/status', () => {
  test('devuelve conteos y nada más', async () => {
    const s = sombraEncendida();
    s.capture(obs({ deviceUserId: '1042' }));

    const res = await request(bootApi(s)).get('/shadow/status').set('x-api-key', CLAVE);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.runtime.persisted).toBe(1);
    expect(res.body.stored.stored).toBe(1);
    // El código de empleado no puede viajar en un informe de métricas.
    expect(JSON.stringify(res.body)).not.toContain('1042');
    s.stop();
  });

  test('con la sombra apagada lo dice sin fallar', async () => {
    const apagada = createShadow({ env: { BRIDGE_SHADOW_ENABLED: 'false' }, devices: RELOJES });
    const res = await request(bootApi(apagada)).get('/shadow/status').set('x-api-key', CLAVE);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  test('sin sombra construida tampoco falla', async () => {
    const res = await request(bootApi(null)).get('/shadow/status').set('x-api-key', CLAVE);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});

// ── Comparación ──────────────────────────────────────────────────────

describe('GET /shadow/compare', () => {
  test('informa que el polling todavía no está conectado', async () => {
    const s = sombraEncendida();
    s.capture(obs());

    const res = await request(bootApi(s)).get('/shadow/compare').set('x-api-key', CLAVE);

    expect(res.status).toBe(200);
    expect(res.body.polling_connected).toBe(false);
    expect(res.body.totals.push).toBe(1);
    expect(res.body.totals.polling).toBe(0);
    s.stop();
  });

  test('acepta ventana y reloj', async () => {
    const s = sombraEncendida();
    s.capture(obs({ occurredAtRaw: '2026-03-11 08:00:00', deviceUserId: '1' }));
    s.capture(obs({ occurredAtRaw: '2026-03-11 17:00:00', deviceUserId: '2' }));

    const res = await request(bootApi(s))
      .get('/shadow/compare?from=2026-03-11T10:00:00Z&to=2026-03-11T12:00:00Z&device_key=sn:GER-0001')
      .set('x-api-key', CLAVE);

    expect(res.body.totals.push).toBe(1);
    s.stop();
  });

  test('es de sólo lectura', async () => {
    const s = sombraEncendida();
    s.capture(obs());

    await request(bootApi(s)).get('/shadow/compare').set('x-api-key', CLAVE);

    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('con la sombra apagada responde 503, no un informe vacío', async () => {
    const apagada = createShadow({ env: { BRIDGE_SHADOW_ENABLED: 'false' }, devices: RELOJES });
    const res = await request(bootApi(apagada)).get('/shadow/compare').set('x-api-key', CLAVE);

    // Un 200 con todo en cero se leería como "no hay diferencias", que es un
    // diagnóstico distinto de "la sombra no está corriendo".
    expect(res.status).toBe(503);
  });
});

// ── Vaciado ──────────────────────────────────────────────────────────

describe('POST /shadow/purge', () => {
  test('sin confirm no borra', async () => {
    const s = sombraEncendida();
    s.capture(obs());

    const res = await request(bootApi(s)).post('/shadow/purge').set('x-api-key', CLAVE).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('shadow_purge_unconfirmed');
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('confirm en texto no alcanza', async () => {
    const s = sombraEncendida();
    s.capture(obs());

    const res = await request(bootApi(s)).post('/shadow/purge').set('x-api-key', CLAVE).send({ confirm: 'true' });

    expect(res.status).toBe(400);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('con clave y confirm vacía', async () => {
    const s = sombraEncendida();
    s.capture(obs({ deviceUserId: '1' }));
    s.capture(obs({ deviceUserId: '2' }));

    const res = await request(bootApi(s)).post('/shadow/purge').set('x-api-key', CLAVE).send({ confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(s.store.stats().stored).toBe(0);
    s.stop();
  });

  test('puede acotarse por fecha', async () => {
    const s = sombraEncendida();
    s.capture(obs({ occurredAtRaw: '2026-03-11 08:00:00', deviceUserId: '1' }));
    s.capture(obs({ occurredAtRaw: '2026-03-11 17:00:00', deviceUserId: '2' }));

    const res = await request(bootApi(s))
      .post('/shadow/purge')
      .set('x-api-key', CLAVE)
      .send({ confirm: true, before: '2026-03-11T12:00:00Z' });

    expect(res.body.deleted).toBe(1);
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });

  test('no existe ninguna otra ruta que borre', async () => {
    const s = sombraEncendida();
    s.capture(obs());
    const app = bootApi(s);

    for (const ruta of ['/shadow/clear', '/shadow/reset', '/shadow/events']) {
      const res = await request(app).delete(ruta).set('x-api-key', CLAVE);
      expect(res.status).toBe(404);
    }
    expect(s.store.stats().stored).toBe(1);
    s.stop();
  });
});

// ── Importar el módulo no arranca el Bridge ──────────────────────────

describe('importar index.js no levanta nada', () => {
  test('requerirlo en un proceso limpio termina solo, sin bindear ni conectar', () => {
    // En un proceso aparte, sin parches: si `main()` corriera al importar,
    // el proceso intentaría abrir Redis y escuchar en 8080/8081, y no
    // terminaría por su cuenta. Que salga con 0 e imprima OK es la prueba de
    // que la guarda `require.main === module` está haciendo su trabajo.
    const salida = execFileSync(
      process.execPath,
      ['-e', "require('./src/index'); console.log('OK');"],
      { cwd: path.join(__dirname, '..'), timeout: 20000, encoding: 'utf8' },
    );

    expect(salida.trim().split('\n').pop()).toBe('OK');
  });

  test('el arranque sigue colgando de require.main', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    expect(fuente).toMatch(/require\.main === module/);
  });
});
