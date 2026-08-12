/**
 * Recepción de ATTLOG cuando el firmware NO envía Content-Type.
 *
 * ── El caso real ─────────────────────────────────────────────────────
 *
 * Un reloj ZKTeco en producción emite este POST:
 *
 *   POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=9999 HTTP/1.1
 *   User-Agent: iClock Proxy/1.09
 *   Connection: close
 *   Accept: * / *
 *   Content-Length: 35
 *
 *   <PIN>\t2026-08-12 09:55:55\t0\t1\t\t0\t0\t\n
 *
 * Sin `Content-Type`. `express.text({ type: '* / *' })` resuelve su `type`
 * contra ese header, así que sin él NO parsea: `req.body` queda en `{}`, el
 * `.toString()` que había lo convertía en la cadena `"[object Object]"`, y esa
 * cadena se contaba como UNA línea ATTLOG ilegible. Resultado en producción:
 * "1 línea recibida, 0 observados", sombra en cero, ningún error en el log.
 *
 * Los tests que ya existían no lo atrapaban porque TODOS mandan
 * `Content-Type: text/plain` explícito — justo el header que el reloj no manda.
 * De ahí que la ausencia del header sea el eje de este archivo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');

const { createShadow } = require('../src/shadow');
const { parseAttlogLine, timestampValido, cuerpoATexto, lineasDe } = require('../src/attlog');
const { pushMetrics, resetPushMetrics, pushState } = require('../src/pushServer');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Relojes de prueba. Ni el serial ni la IP del equipo real van al repositorio.
const GERENCIA = { id: 1, name: 'Gerencia', ip: '10.0.0.11', port: 4370, serial: 'GER-0001', test: false };
const COMEDOR  = { id: 2, name: 'Comedor',  ip: '10.0.0.12', port: 4370, serial: 'COM-0002', test: false };
const RELOJES = [GERENCIA, COMEDOR];

/** La línea exacta del firmware: workCode vacío y TAB final. */
const LINEA_REAL = '1234\t2026-08-12 09:55:55\t0\t1\t\t0\t0\t';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-attlog-'));
  delete process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST;
  resetPushMetrics();
  for (const k of Object.keys(pushState)) delete pushState[k];
});
afterEach(() => {
  delete process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

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

/**
 * Envía SIN Content-Type, como el reloj real.
 *
 * ── El orden importa y no es intercambiable ──────────────────────────
 *
 * `.unset()` va DESPUÉS de `.send()`. Al revés no funciona: `send()` le pone
 * un Content-Type por defecto a lo que se le pasa, así que un `.unset()`
 * anterior queda pisado y la petición sale con
 * `application/x-www-form-urlencoded`.
 *
 * Eso importa porque con el parser nuevo ese caso TAMBIÉN parsea bien — los
 * tests pasarían igual sin estar probando lo que dicen probar. El primer test
 * del archivo existe para clavar que la forma enviada es la real.
 */
function enviarSinContentType(app, body, sn) {
  return request(app)
    .post(`/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=9999`)
    .set('User-Agent', 'iClock Proxy/1.09')
    .send(body)
    .unset('Content-Type');
}

/** Envía declarando text/plain, como hacían los tests anteriores. */
function enviarConContentType(app, body, sn) {
  return request(app)
    .post(`/iclock/cdata?SN=${sn}&table=ATTLOG`)
    .set('Content-Type', 'text/plain')
    .send(body);
}

// ─────────────────────────────────────────────────────────────────────
describe('el POST del firmware llega sin Content-Type', () => {
  test('supertest reproduce la forma real: sin Content-Type, con Content-Length', async () => {
    // Si este test dejara de valer, los de abajo estarían probando otra cosa.
    const app = express();
    let visto = null;
    app.post('/x', (req, res) => {
      visto = {
        ct: req.headers['content-type'] ?? null,
        cl: req.headers['content-length'] ?? null,
      };
      res.send('OK');
    });
    await request(app).post('/x').send(LINEA_REAL).unset('Content-Type');

    expect(visto.ct).toBeNull();
    expect(visto.cl).toBe(String(Buffer.byteLength(LINEA_REAL)));
  });
});

// ── El test crítico ──────────────────────────────────────────────────

describe('ATTLOG sin Content-Type, reloj observe-only', () => {
  beforeEach(() => { process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'GER-0001'; });

  test('se recibe, se observa y no se publica por ningún camino', async () => {
    const s = sombraEncendida();
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: s, redis });

    const res = await enviarSinContentType(app, LINEA_REAL + '\n', 'GER-0001');

    // 1. el reloj recibe el protocolo de siempre
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');

    // 2. la línea se leyó y se entendió — lo que antes fallaba
    expect(pushMetrics.attlog_lines_received).toBe(1);
    expect(pushMetrics.attlog_lines_valid).toBe(1);
    expect(pushMetrics.attlog_malformed_fields).toBe(0);
    expect(pushMetrics.attlog_invalid_timestamp).toBe(0);

    // 3. quedó observada
    expect(s.store.stats().stored).toBe(1);
    expect(pushMetrics.observe_only_received).toBe(1);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(1);

    // 4. y NO se publicó por ningún camino
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();

    s.stop();
  });

  test('la observación guardada tiene los campos del marcaje, no basura', async () => {
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s, redis: redisFalso() });

    await enviarSinContentType(app, LINEA_REAL + '\n', 'GER-0001');

    const fila = s.store.db.prepare('SELECT * FROM shadow_events').get();
    const p = JSON.parse(fila.payload);
    expect(p.device_user_id).toBe('1234');
    // El PIN llegó como PIN y no corrido un campo: el bug del TAB inicial.
    expect(p.device_user_id).not.toContain('2026');
    // `occurred_at` es el instante normalizado del contrato v1: la hora de
    // pared del reloj anclada al offset civil FIJO de -03:00 (Paraguay no
    // tiene DST). Por eso el valor es el mismo corra donde corra el test, y
    // se puede fijar literal — la suite pasa en UTC, America/Asuncion y
    // Asia/Tokyo con esta misma cadena.
    //
    // Compararlo contra `new Date('…09:55:55')` sería un error: eso lo
    // interpretaría en la zona del PROCESO, que es exactamente la dependencia
    // que el contrato existe para eliminar.
    expect(fila.occurred_at).toBe('2026-08-12T12:55:55Z');

    s.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('el cuerpo no parseado nunca se convierte en una línea', () => {
  test('un objeto no se vuelve "[object Object]"', () => {
    // La regresión exacta: `{}.toString()` da una cadena no vacía que
    // sobrevivía al chequeo de cuerpo vacío y se contaba como una línea.
    expect(cuerpoATexto({})).toBe('');
    expect(lineasDe({})).toEqual([]);
    expect(cuerpoATexto({ a: 1 })).toBe('');
    expect(cuerpoATexto(null)).toBe('');
    expect(cuerpoATexto(undefined)).toBe('');
  });

  test('un Buffer sí se decodifica', () => {
    expect(cuerpoATexto(Buffer.from(LINEA_REAL, 'utf8'))).toBe(LINEA_REAL);
    expect(lineasDe(Buffer.from(LINEA_REAL + '\n', 'utf8'))).toHaveLength(1);
  });

  test('con un cuerpo objeto no se cuenta ninguna línea ni se publica', async () => {
    // Se fuerza el estado viejo: un handler que recibe `{}` en req.body.
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    // Un POST sin cuerpo y sin Content-Type: body-parser no llega a parsear.
    const res = await request(app)
      .post('/iclock/cdata?SN=COM-0002&table=ATTLOG')
      .send('')
      .unset('Content-Type');

    expect(res.status).toBe(200);
    expect(pushMetrics.attlog_lines_received).toBe(0);
    expect(pushMetrics.attlog_lines_valid).toBe(0);
    expect(publishAttendance).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('Content-Type declarado sigue funcionando', () => {
  test('text/plain se procesa igual que antes', async () => {
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    const res = await enviarConContentType(app, LINEA_REAL + '\n', 'COM-0002');

    expect(res.status).toBe(200);
    expect(pushMetrics.attlog_lines_valid).toBe(1);
    expect(publishAttendance).toHaveBeenCalledTimes(1);
  });

  test('los dos caminos producen la misma marcación', async () => {
    const a = bootApp({ redis: redisFalso() });
    await enviarConContentType(a.app, LINEA_REAL + '\n', 'COM-0002');
    const conHeader = a.publishAttendance.mock.calls[0][0];

    resetPushMetrics();
    const b = bootApp({ redis: redisFalso() });
    await enviarSinContentType(b.app, LINEA_REAL + '\n', 'COM-0002');
    const sinHeader = b.publishAttendance.mock.calls[0][0];

    expect(sinHeader).toEqual(conHeader);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('varias líneas en un POST', () => {
  test('se procesan todas', async () => {
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    const cuerpo = [
      '1001\t2026-08-12 08:00:00\t0\t1\t\t0\t0\t',
      '1002\t2026-08-12 08:01:00\t1\t1\t\t0\t0\t',
      '1003\t2026-08-12 08:02:00\t0\t1\t\t0\t0\t',
    ].join('\n') + '\n';

    await enviarSinContentType(app, cuerpo, 'COM-0002');

    expect(pushMetrics.attlog_lines_received).toBe(3);
    expect(pushMetrics.attlog_lines_valid).toBe(3);
    expect(publishAttendance).toHaveBeenCalledTimes(3);
  });

  test('una línea corrupta no arrastra a las buenas', async () => {
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    const cuerpo = [
      '1001\t2026-08-12 08:00:00\t0\t1\t\t0\t0\t',
      'basura sin tabs',
      '1003\t2026-08-12 08:02:00\t0\t1\t\t0\t0\t',
    ].join('\n') + '\n';

    await enviarSinContentType(app, cuerpo, 'COM-0002');

    expect(pushMetrics.attlog_lines_received).toBe(3);
    expect(pushMetrics.attlog_lines_valid).toBe(2);
    expect(pushMetrics.attlog_malformed_fields).toBe(1);
    expect(publishAttendance).toHaveBeenCalledTimes(2);
  });

  test('CRLF también se separa bien', async () => {
    const { app } = bootApp({ redis: redisFalso() });
    const cuerpo = '1001\t2026-08-12 08:00:00\t0\t1\t\t0\t0\t\r\n' +
                   '1002\t2026-08-12 08:01:00\t0\t1\t\t0\t0\t\r\n';

    await enviarSinContentType(app, cuerpo, 'COM-0002');

    expect(pushMetrics.attlog_lines_valid).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('el parser de una línea', () => {
  test('acepta la línea real, con workCode vacío', () => {
    const r = parseAttlogLine(LINEA_REAL);

    expect(r.ok).toBe(true);
    expect(r.deviceUserId).toBe('1234');
    expect(r.occurredAtRaw).toBe('2026-08-12 09:55:55');
    expect(r.status).toBe('0');
    expect(r.verify).toBe('1');
    // Vacío es un valor válido, no una señal de corrupción.
    expect(r.workCode).toBe('');
  });

  test('acepta el mínimo: PIN y fecha', () => {
    const r = parseAttlogLine('1234\t2026-08-12 09:55:55');
    expect(r.ok).toBe(true);
    expect(r.workCode).toBe('');
  });

  test('rechaza campos insuficientes', () => {
    expect(parseAttlogLine('1234').ok).toBe(false);
    expect(parseAttlogLine('1234').motivo).toBe('campos_insuficientes');
    expect(parseAttlogLine('').motivo).toBe('campos_insuficientes');
    expect(parseAttlogLine('basura sin tabs').motivo).toBe('campos_insuficientes');
  });

  test('rechaza el PIN vacío', () => {
    expect(parseAttlogLine('\t2026-08-12 09:55:55\t0\t1').motivo).toBe('pin_vacio');
  });

  test('rechaza timestamps inválidos', () => {
    const malos = [
      '1234\tno-es-fecha\t0\t1',
      '1234\t2026-13-01 09:55:55\t0\t1',   // mes 13
      '1234\t2026-08-32 09:55:55\t0\t1',   // día 32
      '1234\t2026-08-12 25:00:00\t0\t1',   // hora 25
      '1234\t2026-08-12 09:60:00\t0\t1',   // minuto 60
      '1234\t2026-02-30 09:55:55\t0\t1',   // febrero no tiene 30
      '1234\t2026\t0\t1',                  // Date lo aceptaría; acá no
    ];
    for (const m of malos) {
      const r = parseAttlogLine(m);
      expect(r.ok).toBe(false);
      expect(r.motivo).toBe('timestamp_invalido');
    }
  });

  test('el 29 de febrero vale sólo en año bisiesto', () => {
    expect(timestampValido('2024-02-29 10:00:00')).toBe(true);
    expect(timestampValido('2026-02-29 10:00:00')).toBe(false);
    expect(timestampValido('2000-02-29 10:00:00')).toBe(true);   // divisible por 400
    expect(timestampValido('1900-02-29 10:00:00')).toBe(false);  // divisible por 100
  });

  test('acepta T como separador además del espacio', () => {
    expect(parseAttlogLine('1234\t2026-08-12T09:55:55\t0\t1').ok).toBe(true);
  });

  test('nunca lanza, cualquiera sea la entrada', () => {
    for (const v of [null, undefined, 42, {}, [], '\t\t\t', ' \t ']) {
      expect(() => parseAttlogLine(v)).not.toThrow();
      expect(parseAttlogLine(v).ok).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('las métricas cuentan cada motivo por separado', () => {
  test('timestamp inválido y campos faltantes no se mezclan', async () => {
    const { app } = bootApp({ redis: redisFalso() });

    const cuerpo = [
      '1001\t2026-08-12 08:00:00\t0\t1\t\t0\t0\t',  // válida
      '1002\t2026-13-45 99:99:99\t0\t1\t\t0\t0\t',  // timestamp inválido
      'una sola columna',                            // campos insuficientes
      '\t2026-08-12 08:00:00\t0\t1',                 // PIN vacío
    ].join('\n') + '\n';

    await enviarSinContentType(app, cuerpo, 'COM-0002');

    expect(pushMetrics.attlog_lines_received).toBe(4);
    expect(pushMetrics.attlog_lines_valid).toBe(1);
    expect(pushMetrics.attlog_invalid_timestamp).toBe(1);
    expect(pushMetrics.attlog_malformed_fields).toBe(2);
  });

  test('no llevan PIN, ni IP, ni payload', () => {
    // Los contadores son números y nada más.
    for (const [, v] of Object.entries(pushMetrics)) {
      expect(typeof v).toBe('number');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('lastPunch sólo cuando se entendió un marcaje', () => {
  test('un ATTLOG ilegible NO deja el reloj con cara de sano', async () => {
    const { app } = bootApp({ redis: redisFalso() });

    await enviarSinContentType(app, 'basura sin tabs\n', 'COM-0002');

    // El estado imposible de producción: lastPunch con fecha y punches en 0.
    expect(pushState['COM-0002'].lastPunch).toBeUndefined();
    expect(pushState['COM-0002'].punches ?? 0).toBe(0);

    // Pero sí consta que el reloj habló y que mandó un ATTLOG.
    expect(pushState['COM-0002'].lastSeen).toBeTruthy();
    expect(pushState['COM-0002'].lastAttlogReceived).toBeTruthy();
  });

  test('un ATTLOG legible sí lo marca', async () => {
    const { app } = bootApp({ redis: redisFalso() });

    await enviarSinContentType(app, LINEA_REAL + '\n', 'COM-0002');

    expect(pushState['COM-0002'].lastPunch).toBeTruthy();
    expect(pushState['COM-0002'].punches).toBe(1);
  });

  test('en observe-only también se marca: observar no es no ver nada', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'GER-0001';
    const s = sombraEncendida();
    const { app } = bootApp({ shadow: s, redis: redisFalso() });

    await enviarSinContentType(app, LINEA_REAL + '\n', 'GER-0001');

    expect(pushState['GER-0001'].lastPunch).toBeTruthy();
    expect(pushState['GER-0001'].punches).toBe(1);
    expect(pushState['GER-0001'].observeOnly).toBe(true);

    s.stop();
  });

  test('un cuerpo vacío no inventa un marcaje', async () => {
    const { app } = bootApp({ redis: redisFalso() });

    const res = await enviarSinContentType(app, '', 'COM-0002');

    expect(res.status).toBe(200);
    expect(pushState['COM-0002'].lastPunch).toBeUndefined();
    expect(pushMetrics.attlog_lines_received).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('la sombra rota no convierte al observado en productor', () => {
  test('si capture() lanza, igual no se publica', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'GER-0001';
    const sombraRota = { capture: () => { throw new Error('disco lleno'); } };
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ shadow: sombraRota, redis });

    const res = await enviarSinContentType(app, LINEA_REAL + '\n', 'GER-0001');

    expect(res.status).toBe(200);
    expect(publishAttendance).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(pushMetrics.observe_only_suppressed_publish).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('los relojes que no son observe-only conservan su comportamiento', () => {
  test('con allowlist vacía se publica, sin Content-Type incluido', async () => {
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ redis });

    await enviarSinContentType(app, LINEA_REAL + '\n', 'GER-0001');

    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);   // el dedupe corre
    expect(pushMetrics.observe_only_received).toBe(0);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(0);
  });

  test('un reloj no nombrado publica aunque otro sí esté nombrado', async () => {
    process.env.BRIDGE_PUSH_OBSERVE_ONLY_ALLOWLIST = 'GER-0001';
    const redis = redisFalso();
    const { app, publishAttendance } = bootApp({ redis });

    await enviarSinContentType(app, LINEA_REAL + '\n', 'COM-0002');

    expect(publishAttendance).toHaveBeenCalledTimes(1);
    expect(pushMetrics.observe_only_suppressed_publish).toBe(0);
  });

  test('la marcación publicada lleva los campos de siempre', async () => {
    const { app, publishAttendance } = bootApp({ redis: redisFalso() });

    await enviarSinContentType(app, LINEA_REAL + '\n', 'COM-0002');

    const arg = publishAttendance.mock.calls[0][0];
    expect(arg.employeeCode).toBe('1234');
    expect(arg.deviceSn).toBe('COM-0002');
    expect(arg.type).toBe('in');            // status 0
    expect(arg.raw.userId).toBe('1234');
    expect(arg.raw.timestamp).toBe('2026-08-12 09:55:55');
    expect(arg.raw.workCode).toBe('');
  });
});
