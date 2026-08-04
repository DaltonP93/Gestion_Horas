/**
 * Cliente del Bridge.
 *
 * El 502 de push-status con el Bridge sano venía de no mandar `x-api-key`:
 * el Bridge respondía 401 y la ruta lo aplanaba a un 502 genérico. Estos
 * tests fijan que la clave viaje siempre y que cada causa quede distinguible.
 */
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { fetchPushStatus, BRIDGE_ERROR_CODES, newCorrelationId } = require('../src/services/bridgeClient');
const { PUSH_STATUS_CONTRACT_VERSION } = require('../src/services/pushStatusContract');

const payloadOk = (extra = {}) => ({
  contract_version: PUSH_STATUS_CONTRACT_VERSION,
  found: true,
  serial: 'SN-123',
  last_push_at: '2026-08-04T18:00:00.000Z',
  last_event_at: '2026-08-04T17:55:00.000Z',
  matched_by: 'serial',
  ...extra,
});

const respuesta = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let fetchMock;
beforeEach(() => {
  process.env.BRIDGE_API_KEY = 'clave-de-prueba';
  process.env.BRIDGE_URL = 'http://bridge-interno:8081';
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => { delete process.env.BRIDGE_API_KEY; delete process.env.BRIDGE_URL; });

describe('la petición', () => {
  test('manda x-api-key — la cabecera que faltaba', async () => {
    fetchMock.mockResolvedValue(respuesta(200, payloadOk()));
    await fetchPushStatus({ serial: 'SN-123' });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['x-api-key']).toBe('clave-de-prueba');
  });

  test('identifica por serial e IP, no por id', async () => {
    fetchMock.mockResolvedValue(respuesta(200, payloadOk()));
    await fetchPushStatus({ serial: 'SN-123', ip: '10.0.0.5' });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/push-status?');
    expect(url).toContain('serial=SN-123');
    expect(url).toContain('ip=10.0.0.5');
    expect(url).not.toMatch(/\/devices\/\d+\//);
  });

  test('propaga el correlation_id al Bridge', async () => {
    fetchMock.mockResolvedValue(respuesta(200, payloadOk()));
    const cid = newCorrelationId();
    const r = await fetchPushStatus({ serial: 'SN-1', correlationId: cid });

    expect(fetchMock.mock.calls[0][1].headers['x-correlation-id']).toBe(cid);
    expect(r.correlation_id).toBe(cid);
  });

  test('lleva timeout', async () => {
    fetchMock.mockResolvedValue(respuesta(200, payloadOk()));
    await fetchPushStatus({ serial: 'SN-1' });
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });
});

describe('causas distinguibles', () => {
  test('sin BRIDGE_API_KEY ni se llama al Bridge', async () => {
    delete process.env.BRIDGE_API_KEY;
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.NOT_CONFIGURED);
    expect(r.http_status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('401 del Bridge → UNAUTHORIZED (503), no un 502 genérico', async () => {
    fetchMock.mockResolvedValue(respuesta(401, { error: 'No autorizado' }));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.UNAUTHORIZED);
    expect(r.http_status).toBe(503);
  });

  test('403 también', async () => {
    fetchMock.mockResolvedValue(respuesta(403, {}));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.UNAUTHORIZED);
  });

  test('404 → ROUTE_MISSING: Bridge viejo, no reloj inexistente', async () => {
    fetchMock.mockResolvedValue(respuesta(404, {}));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.ROUTE_MISSING);
    expect(r.http_status).toBe(502);
  });

  test('timeout → TIMEOUT (504)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.TIMEOUT);
    expect(r.http_status).toBe(504);
  });

  test('Bridge apagado → UNREACHABLE (502)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.UNREACHABLE);
    expect(r.http_status).toBe(502);
  });

  test('500 del Bridge → BRIDGE_ERROR', async () => {
    fetchMock.mockResolvedValue(respuesta(500, {}));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BRIDGE_ERROR);
  });

  test('sin serial ni ip no se llama al Bridge', async () => {
    const r = await fetchPushStatus({});
    expect(r.error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('validación del contrato', () => {
  test('respuesta que no es JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); } });
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('versión de contrato no soportada', async () => {
    fetchMock.mockResolvedValue(respuesta(200, payloadOk({ contract_version: 99 })));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('campos ausentes o mal tipados', async () => {
    for (const malo of [
      { ...payloadOk(), found: 'sí' },
      { ...payloadOk(), last_push_at: 'no-es-fecha' },
      { ...payloadOk(), serial: 42 },
      null,
      [],
      'texto',
    ]) {
      fetchMock.mockResolvedValue(respuesta(200, malo));
      expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
    }
  });

  test('un payload válido pasa', async () => {
    fetchMock.mockResolvedValue(respuesta(200, payloadOk()));
    const r = await fetchPushStatus({ serial: 'SN-123' });

    expect(r.ok).toBe(true);
    expect(r.data.serial).toBe('SN-123');
    expect(r.data.found).toBe(true);
  });

  test('found: false con fechas nulas también es válido', async () => {
    fetchMock.mockResolvedValue(respuesta(200, {
      contract_version: PUSH_STATUS_CONTRACT_VERSION,
      found: false, serial: null, last_push_at: null, last_event_at: null, matched_by: 'none',
    }));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.ok).toBe(true);
    expect(r.data.found).toBe(false);
  });
});

describe('no filtra secretos', () => {
  test('el mensaje publicable no trae la clave, la URL ni el estado interno', async () => {
    fetchMock.mockResolvedValue(respuesta(401, {}));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.message).not.toContain('clave-de-prueba');
    expect(r.message).not.toContain('bridge-interno');
    expect(r.message).not.toContain('401');
  });

  test('el detalle técnico existe pero va aparte del mensaje', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8081'));
    const r = await fetchPushStatus({ serial: 'SN-1' });

    expect(r.detail).toContain('ECONNREFUSED');      // para el log
    expect(r.message).not.toContain('ECONNREFUSED'); // no para el cliente
  });
});

describe('el validador es exacto (hallazgo de Codex)', () => {
  test('una clave de más rompe el contrato — un Bridge que filtre la IP no pasa', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { ...payloadOk(), ip: '10.0.0.5' }));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('una clave ausente también', async () => {
    const { last_event_at, ...incompleto } = payloadOk();
    fetchMock.mockResolvedValue(respuesta(200, incompleto));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('undefined no cuela por donde debía ir null', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { ...payloadOk(), last_push_at: undefined }));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('matched_by fuera del enum', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { ...payloadOk(), matched_by: 'magia' }));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('un objeto con prototipo raro no pasa por objeto plano', async () => {
    const raro = Object.create({ heredado: true });
    Object.assign(raro, payloadOk());
    fetchMock.mockResolvedValue(respuesta(200, raro));
    expect((await fetchPushStatus({ serial: 'SN-1' })).error_code).toBe(BRIDGE_ERROR_CODES.BAD_CONTRACT);
  });

  test('matched_by "ambiguous" sí es válido', async () => {
    fetchMock.mockResolvedValue(respuesta(200, {
      contract_version: PUSH_STATUS_CONTRACT_VERSION, found: false, serial: null,
      last_push_at: null, last_event_at: null, matched_by: 'ambiguous',
    }));
    expect((await fetchPushStatus({ serial: 'SN-1' })).ok).toBe(true);
  });
});

describe('las dos copias del contrato no pueden divergir', () => {
  test('api/src/services y bridge/src tienen exactamente el mismo archivo', () => {
    const fs = require('fs'), path = require('path');
    const raiz = path.join(__dirname, '..', '..');
    const a = fs.readFileSync(path.join(raiz, 'api', 'src', 'services', 'pushStatusContract.js'), 'utf8');
    const b = fs.readFileSync(path.join(raiz, 'bridge', 'src', 'pushStatusContract.js'), 'utf8');

    // Una divergencia silenciosa acá haría que la API rechace payloads
    // válidos del Bridge, o peor, que acepte los inválidos.
    expect(a).toBe(b);
  });
});
