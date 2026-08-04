/**
 * netMetricsRoute.test.js — endpoint de diagnóstico de red.
 *
 * Es una vista de infraestructura: sólo super_admin, y su respuesta no puede
 * arrastrar marcaciones, empleados ni secretos.
 */

jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// El router monta muchos servicios pesados; sólo interesa esta ruta.
jest.mock('../src/services/zktecoReader', () => ({
  backupDeviceDirect: jest.fn(), backupAllDevices: jest.fn(), tableExists: jest.fn(),
}));
jest.mock('../src/services/deviceMapping', () => ({
  reprocessUnmapped: jest.fn(), linkEmployeeDevice: jest.fn(),
}));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const guards = [];
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requireSuperAdmin: (req, res, next) => {
    guards.push('requireSuperAdmin');
    if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Prohibido' });
    next();
  },
}));

const netMetrics = require('../src/services/netMetrics');
const router = require('../src/routes/devices');

/** Handler final de una ruta del router, junto con sus middlewares. */
function layerFor(method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  return layer.route.stack;
}

function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this });
  res.json   = jest.fn().mockImplementation(function () { return this });
  return res;
}

/** Corre la cadena completa (guard + handler) como lo haría Express. */
async function call(req, res) {
  const stack = layerFor('get', '/network-metrics')
  for (const l of stack) {
    let siguiente = false
    await l.handle(req, res, () => { siguiente = true })
    if (!siguiente) return
  }
}

const SUPER = { id: 1, role: 'super_admin' };

beforeEach(() => {
  jest.clearAllMocks()
  guards.length = 0
  jest.spyOn(netMetrics, 'fetchRuns').mockResolvedValue([])
  jest.spyOn(netMetrics, 'availableColumns').mockResolvedValue(
    ['mode', 'bytes_from_device', 'bytes_estimated', 'error_code']
  )
  jest.spyOn(netMetrics, 'queueSnapshot').mockResolvedValue(
    { pending: 0, running: 0, locks: 0, oldest_pending_age_sec: null }
  )
})

afterEach(() => jest.restoreAllMocks())

describe('GET /api/devices/network-metrics — autorización', () => {
  it('la ruta está protegida por requireSuperAdmin', () => {
    const stack = layerFor('get', '/network-metrics')
    expect(stack.length).toBeGreaterThan(1)
  })

  it('un admin común recibe 403', async () => {
    const res = mkRes()
    await call({ query: {}, user: { id: 2, role: 'admin' } }, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(netMetrics.fetchRuns).not.toHaveBeenCalled()
  })

  it('un gestor recibe 403', async () => {
    const res = mkRes()
    await call({ query: {}, user: { id: 3, role: 'gestor' } }, res)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('super_admin pasa', async () => {
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)
    expect(res.status).not.toHaveBeenCalledWith(403)
    expect(netMetrics.fetchRuns).toHaveBeenCalled()
  })
})

describe('GET /api/devices/network-metrics — parámetros', () => {
  it('sin rango usa las últimas 24 horas', async () => {
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)

    const { from, to } = netMetrics.fetchRuns.mock.calls[0][0]
    expect(to - from).toBe(24 * 60 * 60 * 1000)
  })

  it('una fecha inválida devuelve 400', async () => {
    const res = mkRes()
    await call({ query: { from: 'no-es-fecha' }, user: SUPER }, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('un rango invertido devuelve 400', async () => {
    const res = mkRes()
    await call({
      query: { from: '2026-08-03T10:00:00Z', to: '2026-08-03T09:00:00Z' }, user: SUPER,
    }, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('un device_id no numérico devuelve 400', async () => {
    const res = mkRes()
    await call({ query: { device_id: 'abc' }, user: SUPER }, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('device_id válido se pasa al filtro', async () => {
    const res = mkRes()
    await call({ query: { device_id: '7' }, user: SUPER }, res)
    expect(netMetrics.fetchRuns.mock.calls[0][0].deviceId).toBe(7)
  })
})

describe('GET /api/devices/network-metrics — respuesta', () => {
  it('agrega por reloj e incluye la ventana consultada', async () => {
    netMetrics.fetchRuns.mockResolvedValue([
      { device_id: 1, device_name: 'Comedor', started_at: '2026-08-03T10:00:00Z',
        status: 'success', mode: 'polling_auto', raw_count: 1000, imported_count: 5,
        duplicate_count: 995, bytes_from_device: 100000, bytes_estimated: 1,
        attempts: 1, duration_ms: 3000 },
    ])
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)

    const body = res.json.mock.calls[0][0]
    expect(body.window.from).toBeDefined()
    expect(body.devices).toHaveLength(1)
    expect(body.devices[0].saving.wasted_ratio).toBeCloseTo(0.995, 3)
  })

  it('avisa cuando la migración de métricas no está aplicada', async () => {
    netMetrics.availableColumns.mockResolvedValue([])
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)

    const body = res.json.mock.calls[0][0]
    // Sin esto, "0 bytes" se leería como una medición real.
    expect(body.metrics_available).toBe(false)
    expect(body.missing_columns).toContain('bytes_from_device')
  })

  it('declara que los bytes son una estimación, no bytes de cable', async () => {
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)
    expect(res.json.mock.calls[0][0].notes.bytes).toMatch(/estimad/i)
  })

  it('la respuesta no contiene datos personales ni secretos', async () => {
    netMetrics.fetchRuns.mockResolvedValue([
      { device_id: 1, device_name: 'Comedor', started_at: '2026-08-03T10:00:00Z',
        status: 'success', mode: 'polling_auto', raw_count: 10, imported_count: 1 },
    ])
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)

    const json = JSON.stringify(res.json.mock.calls[0][0]).toLowerCase()
    for (const prohibida of ['password', 'token', 'descriptor', 'document_number', 'salary']) {
      expect(json).not.toContain(prohibida)
    }
  })

  it('un fallo interno responde 500 sin filtrar el error', async () => {
    netMetrics.fetchRuns.mockRejectedValue(new Error('SELECT ... FROM /var/lib/mysql'))
    const res = mkRes()
    await call({ query: {}, user: SUPER }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/var\/lib|SELECT/)
  })
})
