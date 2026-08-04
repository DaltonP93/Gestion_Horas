/**
 * GET /api/devices/:id/push-status — respuesta normalizada.
 *
 * El estado del reloj (online / stale / never_seen) es un dato y va con 200.
 * Sólo los problemas de infraestructura llevan 4xx/5xx, y cada causa el suyo:
 * antes todo terminaba en un 502 indistinguible.
 */
const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/zktecoReader', () => ({
  backupDeviceDirect: jest.fn(), backupAllDevices: jest.fn(), tableExists: jest.fn(),
}));
jest.mock('../src/services/deviceMapping', () => ({ reprocessUnmapped: jest.fn(), linkEmployeeDevice: jest.fn() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requireSuperAdmin: (_req, _res, next) => next(),
}));

const mockFetchPushStatus = jest.fn();
jest.mock('../src/services/bridgeClient', () => {
  const real = jest.requireActual('../src/services/bridgeClient');
  return { ...real, fetchPushStatus: (...a) => mockFetchPushStatus(...a), logBridgeFailure: jest.fn() };
});

const { BRIDGE_ERROR_CODES } = require('../src/services/bridgeClient');
const { PUSH_STATUS_CONTRACT_VERSION } = require('../src/services/pushStatusContract');
const router = require('../src/routes/devices');

function handlerFor(method, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const handler = handlerFor('get', '/:id/push-status');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const RELOJ = { id: 7, name: 'Reloj Recepción', serial_no: 'SN-123', ip_address: '10.0.0.5' };

async function llamar({ device = RELOJ, bridge } = {}) {
  mockQuery.mockResolvedValueOnce([[device].filter(Boolean)]);
  mockFetchPushStatus.mockResolvedValueOnce(bridge);
  const res = fakeRes();
  await handler({ params: { id: '7' }, user: { role: 'admin' } }, res);
  return res;
}

const bridgeOk = (extra = {}) => ({
  ok: true,
  correlation_id: 'sh-test',
  data: {
    contract_version: PUSH_STATUS_CONTRACT_VERSION,
    found: true, serial: 'SN-123',
    last_push_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    matched_by: 'serial',
    ...extra,
  },
});

beforeEach(() => { mockQuery.mockReset(); mockFetchPushStatus.mockReset(); });

describe('estados del reloj (todos con 200)', () => {
  test('contacto reciente → online', async () => {
    const res = await llamar({ bridge: bridgeOk() });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('online');
    expect(res.body.available).toBe(true);
    expect(res.body.device_id).toBe(7);
    expect(res.body.serial).toBe('SN-123');
    expect(res.body.correlation_id).toBeTruthy();
  });

  test('contacto viejo → stale, no un error', async () => {
    const viejo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await llamar({ bridge: bridgeOk({ last_push_at: viejo, last_event_at: viejo }) });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('stale');
    expect(res.body.available).toBe(true);
  });

  test('el Bridge responde bien pero no conoce el reloj → never_seen', async () => {
    const res = await llamar({
      bridge: bridgeOk({ found: false, serial: null, last_push_at: null, last_event_at: null, matched_by: 'none' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('never_seen');
    expect(res.body.available).toBe(true);
  });

  test('sin fechas aunque found sea true → never_seen', async () => {
    const res = await llamar({ bridge: bridgeOk({ last_push_at: null, last_event_at: null }) });
    expect(res.body.status).toBe('never_seen');
  });

  test('se usa la fecha más reciente de las dos', async () => {
    const viejo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await llamar({ bridge: bridgeOk({ last_push_at: viejo, last_event_at: new Date().toISOString() }) });
    expect(res.body.status).toBe('online');
  });
});

describe('cada fallo con su código', () => {
  const casos = [
    [BRIDGE_ERROR_CODES.NOT_CONFIGURED, 503],
    [BRIDGE_ERROR_CODES.UNAUTHORIZED,   503],
    [BRIDGE_ERROR_CODES.ROUTE_MISSING,  502],
    [BRIDGE_ERROR_CODES.TIMEOUT,        504],
    [BRIDGE_ERROR_CODES.UNREACHABLE,    502],
    [BRIDGE_ERROR_CODES.BAD_CONTRACT,   502],
  ];

  test.each(casos)('%s → HTTP %i', async (code, http) => {
    const res = await llamar({
      bridge: { ok: false, error_code: code, http_status: http, message: 'mensaje fijo', detail: 'interno', correlation_id: 'sh-x' },
    });

    expect(res.statusCode).toBe(http);
    expect(res.body.error_code).toBe(code);
    expect(res.body.status).toBe('unavailable');
    expect(res.body.available).toBe(false);
  });

  test('reloj inexistente en la base → 404, no 502', async () => {
    mockQuery.mockResolvedValueOnce([[]]);
    const res = fakeRes();
    await handler({ params: { id: '999' }, user: { role: 'admin' } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error_code).toBe('DEVICE_NOT_FOUND');
    expect(mockFetchPushStatus).not.toHaveBeenCalled();
  });
});

describe('identidad y privacidad', () => {
  test('consulta al Bridge por serial e IP, nunca por el id de MySQL', async () => {
    await llamar({ bridge: bridgeOk() });

    const args = mockFetchPushStatus.mock.calls[0][0];
    expect(args.serial).toBe('SN-123');
    expect(args.ip).toBe('10.0.0.5');
    expect(args).not.toHaveProperty('id');
  });

  test('la respuesta no expone la IP del reloj', async () => {
    const res = await llamar({ bridge: bridgeOk() });
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });

  test('tampoco en el camino de error', async () => {
    const res = await llamar({
      bridge: {
        ok: false, error_code: BRIDGE_ERROR_CODES.UNREACHABLE, http_status: 502,
        message: 'No se pudo contactar al servicio de relojes.',
        detail: 'connect ECONNREFUSED 127.0.0.1:8081', correlation_id: 'sh-x',
      },
    });

    const json = JSON.stringify(res.body);
    expect(json).not.toContain('10.0.0.5');
    expect(json).not.toContain('127.0.0.1');
    expect(json).not.toContain('ECONNREFUSED');   // el detalle queda en el log
  });

  test('un reloj sin serial se resuelve igual por IP', async () => {
    await llamar({ device: { ...RELOJ, serial_no: null }, bridge: bridgeOk() });

    const args = mockFetchPushStatus.mock.calls[0][0];
    expect(args.serial).toBeNull();
    expect(args.ip).toBe('10.0.0.5');
  });

  test('todas las respuestas traen correlation_id', async () => {
    const ok = await llamar({ bridge: bridgeOk() });
    const fallo = await llamar({
      bridge: { ok: false, error_code: BRIDGE_ERROR_CODES.TIMEOUT, http_status: 504, message: 'm', correlation_id: 'sh-y' },
    });

    expect(ok.body.correlation_id).toMatch(/^sh-/);
    expect(fallo.body.correlation_id).toMatch(/^sh-/);
  });
});

describe('fechas futuras (hallazgo de Codex)', () => {
  test('un timestamp del futuro no deja el reloj "online" indefinidamente', async () => {
    const futuro = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const res = await llamar({ bridge: bridgeOk({ last_push_at: futuro, last_event_at: futuro }) });

    // Antes: ahora - futuro < ventana siempre → online durante tres horas.
    expect(res.body.status).toBe('never_seen');
  });

  test('un desfasaje chico de reloj se tolera y cuenta como online', async () => {
    const casiAhora = new Date(Date.now() + 30 * 1000).toISOString();
    const res = await llamar({ bridge: bridgeOk({ last_push_at: casiAhora, last_event_at: casiAhora }) });

    expect(res.body.status).toBe('online');
  });

  test('una fecha futura no tapa a una pasada válida', async () => {
    const futuro = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const reciente = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await llamar({ bridge: bridgeOk({ last_push_at: futuro, last_event_at: reciente }) });

    expect(res.body.status).toBe('online');
  });
});
