/**
 * La API distingue "el Bridge no tiene relojes" de "el Bridge está roto".
 *
 * Sin esto, un Bridge sano pero sin ZKTECO_DEVICES caía en BRIDGE_ERROR → 502,
 * que es el mismo síntoma que un Bridge caído y manda a investigar una falla de
 * red que no existe. Es la misma clase de error que motivó el PR #116: no
 * convertir todo en un 502 genérico.
 */
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));

const { fetchPushStatus, BRIDGE_ERROR_CODES, HTTP_FOR_CODE } = require('../src/services/bridgeClient');

const CLAVE = 'clave-de-prueba';
let fetchOriginal;

beforeAll(() => { fetchOriginal = global.fetch; });
afterAll(() => { global.fetch = fetchOriginal; });

beforeEach(() => { process.env.BRIDGE_API_KEY = CLAVE; });

/** Respuesta falsa con el mínimo que usa bridgeClient (incluido `clone`). */
function respuesta(status, body) {
  const texto = typeof body === 'string' ? body : JSON.stringify(body);
  const hacer = () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(texto),
    clone: hacer,
  });
  return hacer();
}

describe('Bridge vivo pero sin relojes configurados', () => {
  const cuerpo = {
    error: 'Bridge sin configurar',
    code: 'bridge_not_configured',
    device_source: 'none',
    configured_devices: 0,
    config_problems: 0,
  };

  test('no se reporta como error del Bridge', async () => {
    global.fetch = async () => respuesta(503, cuerpo);
    const r = await fetchPushStatus({ ip: '10.0.0.11' });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.DEVICES_UNCONFIGURED);
    expect(r.error_code).not.toBe(BRIDGE_ERROR_CODES.BRIDGE_ERROR);
  });

  test('responde 503, no 502 — no es una falla de red', async () => {
    global.fetch = async () => respuesta(503, cuerpo);
    const r = await fetchPushStatus({ ip: '10.0.0.11' });

    expect(r.http_status).toBe(503);
    expect(HTTP_FOR_CODE[BRIDGE_ERROR_CODES.DEVICES_UNCONFIGURED]).toBe(503);
  });

  test('el mensaje dice qué pasa, sin exponer IP ni la URL del Bridge', async () => {
    global.fetch = async () => respuesta(503, cuerpo);
    const r = await fetchPushStatus({ ip: '10.0.0.11' });

    expect(r.message).toMatch(/no tiene ningún reloj configurado/i);
    expect(r.message).not.toContain('10.0.0.11');
    expect(r.message).not.toMatch(/localhost|8081|http/i);
  });

  test('se distingue de la falta de BRIDGE_API_KEY de nuestro lado', async () => {
    delete process.env.BRIDGE_API_KEY;
    const r = await fetchPushStatus({ ip: '10.0.0.11' });

    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.NOT_CONFIGURED);
    expect(r.error_code).not.toBe(BRIDGE_ERROR_CODES.DEVICES_UNCONFIGURED);
  });
});

describe('los demás 503 siguen siendo error del Bridge', () => {
  test('un 503 sin código propio no se confunde con "sin configurar"', async () => {
    global.fetch = async () => respuesta(503, { error: 'algo se rompió' });
    const r = await fetchPushStatus({ ip: '10.0.0.11' });

    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.BRIDGE_ERROR);
  });

  test('un 503 con cuerpo no-JSON tampoco rompe el cliente', async () => {
    global.fetch = async () => ({
      status: 503, ok: false,
      json: async () => { throw new Error('no es JSON'); },
      clone() { return this; },
    });
    const r = await fetchPushStatus({ ip: '10.0.0.11' });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.BRIDGE_ERROR);
  });

  test('el 401 sigue siendo UNAUTHORIZED y el 404 ROUTE_MISSING', async () => {
    global.fetch = async () => respuesta(401, {});
    expect((await fetchPushStatus({ ip: '1.1.1.1' })).error_code).toBe(BRIDGE_ERROR_CODES.UNAUTHORIZED);

    global.fetch = async () => respuesta(404, {});
    expect((await fetchPushStatus({ ip: '1.1.1.1' })).error_code).toBe(BRIDGE_ERROR_CODES.ROUTE_MISSING);
  });
});

describe('cada causa conserva su propio HTTP', () => {
  test('ningún código quedó sin mapear', () => {
    for (const code of Object.values(BRIDGE_ERROR_CODES)) {
      expect(HTTP_FOR_CODE[code]).toBeGreaterThanOrEqual(500);
    }
  });

  test('no todos son 502 — ésa era exactamente la falla anterior', () => {
    const distintos = new Set(Object.values(HTTP_FOR_CODE));
    expect(distintos.size).toBeGreaterThan(1);
  });
});

describe('health/detailed no pinta el Bridge en verde estando degradado', () => {
  // checkBridge() sólo miraba `res.ok`. Como el Bridge responde 200 aun sin
  // relojes, la pantalla de salud mostraba OK justo cuando falta configuración
  // — el diagnóstico principal del operador escondiendo el problema.
  const { checkBridgeForTest } = require('../src/routes/health');

  test('degradado ⇒ ok:false, y se propagan los campos seguros', async () => {
    global.fetch = async () => respuesta(200, {
      status: 'degraded', degraded: true, configured_devices: 0,
      device_source: 'none', config_problems: 2,
    });

    const r = await checkBridgeForTest();

    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.configured_devices).toBe(0);
    expect(r.device_source).toBe('none');
  });

  test('sano ⇒ ok:true', async () => {
    global.fetch = async () => respuesta(200, {
      status: 'ok', degraded: false, configured_devices: 3, device_source: 'zkteco_devices_env',
    });

    const r = await checkBridgeForTest();

    expect(r.ok).toBe(true);
    expect(r.configured_devices).toBe(3);
  });

  test('un cuerpo no-JSON no rompe el chequeo', async () => {
    global.fetch = async () => ({
      status: 200, ok: true,
      json: async () => { throw new Error('no es JSON'); },
      clone() { return this; },
    });

    const r = await checkBridgeForTest();
    expect(r.ok).toBe(true);
  });

  test('no propaga IP ni serial aunque el Bridge los mandara', async () => {
    global.fetch = async () => respuesta(200, {
      status: 'ok', degraded: false, configured_devices: 1,
      ip: '10.0.0.11', serial: 'SN-SECRETO',
    });

    const serializado = JSON.stringify(await checkBridgeForTest());
    expect(serializado).not.toContain('10.0.0.11');
    expect(serializado).not.toContain('SN-SECRETO');
  });
});
