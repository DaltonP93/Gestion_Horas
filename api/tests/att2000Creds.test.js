/**
 * Endurecimiento de credenciales de la integración legada att2000.
 *
 * El navegador NUNCA envía credenciales ni destino: la conexión usa siempre las
 * variables protegidas del servidor (.env). Se verifica que:
 *   - /status devuelve host ENMASCARADO y ninguna credencial.
 *   - /test-conn usa el .env e IGNORA cualquier user/password/host del body.
 *   - /full IGNORA `conn` y sólo pasa el rango de fechas.
 *   - un usuario no super_admin es rechazado.
 */
const mockQueryAtt2000 = jest.fn();
const mockFullSync = jest.fn();

jest.mock('../src/config/att2000', () => ({
  queryAtt2000: (...a) => mockQueryAtt2000(...a),
  testAtt2000Connection: jest.fn(async () => ({ ok: true, totalRecords: 1 })),
  writeCheckinOut: jest.fn(),
}));
jest.mock('../src/config/zkAdapter', () => ({
  fetchCheckInOut: jest.fn(), fetchUserInfo: jest.fn(), fetchDepartments: jest.fn(),
  fetchShifts: jest.fn(), fetchMachines: jest.fn(),
  syncDepartments: jest.fn(), syncEmployees: jest.fn(),
  syncAttendance: jest.fn(async () => ({ imported: 0 })),
  syncMachines: jest.fn(), syncHolidays: jest.fn(),
  fullSync: (...a) => mockFullSync(...a),
}));
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(async () => [[]]) } }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

// Auth mockeada: inyecta el rol desde una cabecera de prueba (sin JWT/DB reales).
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    const role = req.headers['x-test-role'];
    if (!role) return res.status(401).json({ error: 'Token requerido' });
    req.user = { id: 1, role };
    next();
  },
  requireSuperAdmin: (req, res, next) =>
    req.user && req.user.role === 'super_admin'
      ? next()
      : res.status(403).json({ error: 'Requiere super-admin' }),
}));

const express = require('express');
const http = require('http');
const syncRouter = require('../src/routes/sync');

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter);
  server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections?.(); server.close(() => done()); });

// .env protegido del servidor (lo único que debe usarse para conectar).
const ENV = { ATT_HOST: '10.20.30.40', ATT_PORT: '1433', ATT_DATABASE: 'att2000', ATT_USER: 'sa', ATT_PASSWORD: 'super-secreta' };
beforeEach(() => {
  Object.assign(process.env, ENV);
  mockQueryAtt2000.mockReset();
  mockFullSync.mockReset();
  // /test-conn dispara 4 consultas: count checkinout, count userinfo, machines, recientes.
  mockQueryAtt2000
    .mockResolvedValueOnce([{ total: 42 }])
    .mockResolvedValueOnce([{ total: 7 }])
    .mockResolvedValueOnce([{ MACHINE_ALIAS: 'Reloj1', IP_ADDRESS: '10.0.0.9' }])
    .mockResolvedValueOnce([{ USERID: 1, nombre: 'X', CHECKTIME: 't', CHECKTYPE: 'I' }]);
  mockFullSync.mockResolvedValue({ attendance: { imported: 5, duplicate: 1, unmapped: 0 } });
});

const req = (method, path, { role, body } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

describe('GET /api/sync/status', () => {
  test('devuelve host ENMASCARADO, base, pull automático y última comprobación — sin credenciales', async () => {
    const r = await req('GET', '/api/sync/status', { role: 'super_admin' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.available).toBe(true);
    expect(body.host_masked).toBe('10.•••.•••.40');
    expect(body.database).toBe('att2000');
    expect(body).toHaveProperty('auto_pull_enabled');
    expect(body).toHaveProperty('last_check');
    expect(body).toHaveProperty('last_run');
    // Nunca host completo, usuario ni contraseña.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('super-secreta');
    expect(raw).not.toContain('10.20.30.40');
    expect(raw).not.toMatch(/"user"|"password"/);
  });

  test('rechaza a un usuario que no es super_admin', async () => {
    expect((await req('GET', '/api/sync/status', { role: 'admin' })).status).toBe(403);
    expect((await req('GET', '/api/sync/status')).status).toBe(401);
  });
});

describe('POST /api/sync/test-conn', () => {
  test('funciona usando el .env (sin cuerpo)', async () => {
    const r = await req('POST', '/api/sync/test-conn', { role: 'super_admin' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.totalRecords).toBe(42);
    expect(body.totalEmployees).toBe(7);
    expect(mockQueryAtt2000).toHaveBeenCalled();
  });

  test('IGNORA credenciales/host enviados en el body: no altera el .env', async () => {
    const r = await req('POST', '/api/sync/test-conn', {
      role: 'super_admin',
      body: { host: 'servidor-atacante', user: 'atacante', password: 'robada', database: 'evil' },
    });
    expect(r.status).toBe(200);
    // El .env protegido permanece intacto.
    expect(process.env.ATT_HOST).toBe(ENV.ATT_HOST);
    expect(process.env.ATT_USER).toBe(ENV.ATT_USER);
    expect(process.env.ATT_PASSWORD).toBe(ENV.ATT_PASSWORD);
    expect(process.env.ATT_DATABASE).toBe(ENV.ATT_DATABASE);
  });
});

describe('POST /api/sync/full', () => {
  test('sincroniza usando el .env y sólo pasa el rango de fechas', async () => {
    const r = await req('POST', '/api/sync/full', {
      role: 'super_admin',
      body: { dateFrom: '2026-07-01', dateTo: '2026-07-10' },
    });
    expect(r.status).toBe(200);
    expect(mockFullSync).toHaveBeenCalledWith({ dateFrom: '2026-07-01', dateTo: '2026-07-10' });
  });

  test('una petición con conn (user/password) es IGNORADA: no llega al sync ni altera el .env', async () => {
    const r = await req('POST', '/api/sync/full', {
      role: 'super_admin',
      body: { dateFrom: '2026-07-01', dateTo: '2026-07-10', conn: { host: 'evil', user: 'x', password: 'y' } },
    });
    expect(r.status).toBe(200);
    // fullSync recibe SÓLO el rango; nunca el conn.
    expect(mockFullSync).toHaveBeenCalledWith({ dateFrom: '2026-07-01', dateTo: '2026-07-10' });
    const arg = mockFullSync.mock.calls[0][0];
    expect(arg).not.toHaveProperty('conn');
    // El .env protegido permanece intacto.
    expect(process.env.ATT_HOST).toBe(ENV.ATT_HOST);
    expect(process.env.ATT_PASSWORD).toBe(ENV.ATT_PASSWORD);
  });

  test('rechaza a un usuario que no es super_admin', async () => {
    const r = await req('POST', '/api/sync/full', { role: 'admin', body: { dateFrom: 'a', dateTo: 'b' } });
    expect(r.status).toBe(403);
    expect(mockFullSync).not.toHaveBeenCalled();
  });
});
