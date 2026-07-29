/**
 * GET /api/settings — el endpoint PÚBLICO sólo devuelve la allowlist de branding
 * del login; el endpoint /admin (autenticado) devuelve la config completa.
 * Se levanta el router real en Express y se firman JWT reales.
 */
process.env.JWT_SECRET = 'test-secret-settings';

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('http');
const settingsRouter = require('../src/routes/settings');
const { PUBLIC_KEYS, SIGNATURE_KEYS, EMPLOYER_KEYS } = settingsRouter;

// Valores "sensibles" que NUNCA deben salir por el endpoint público.
const SECRET_VALUES = {
  employer_ruc: '80012345-6',
  employer_ips_patronal: 'IPS-PATRONAL-SECRETO',
  employer_representante: 'Juan Pérez (representante legal)',
  system_signer_doc_id: 'CI-1234567',
  system_signer_name: 'Firmante Confidencial',
};

function dbRows() {
  // Fila por cada key: pública con prefijo 'pub_', restringida con su valor secreto.
  const rows = [];
  for (const k of PUBLIC_KEYS) rows.push({ setting_key: k, setting_value: `pub_${k}` });
  for (const k of [...SIGNATURE_KEYS, ...EMPLOYER_KEYS]) {
    rows.push({ setting_key: k, setting_value: SECRET_VALUES[k] || `secret_${k}` });
  }
  return rows;
}

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections?.(); server.close(() => done()); });

beforeEach(() => {
  mockQuery.mockReset();
  // El handler filtra por WHERE setting_key IN (...); devolvemos sólo las filas
  // cuyas keys estén en la lista pedida (simula el filtro SQL real).
  mockQuery.mockImplementation(async (_sql, opts) => {
    const asked = new Set(opts?.replacements || []);
    return [dbRows().filter(r => asked.has(r.setting_key))];
  });
});

const token = (role) => jwt.sign({ id: 1, role, email: 'a@b.c' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
const get = (path, tok) => fetch(base + path, tok ? { headers: { Authorization: `Bearer ${tok}` } } : undefined);

describe('GET /api/settings (público, sin token)', () => {
  test('responde 200 sin autenticación (branding del login funciona)', async () => {
    const r = await get('/api/settings');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.system_name).toBeDefined();
    expect(body.system_logo_url).toBeDefined();
    expect(body.system_login_title).toBeDefined();
    expect(body.system_primary_color).toBeDefined();
  });

  test('SÓLO devuelve claves de la allowlist pública', async () => {
    const body = await (await get('/api/settings')).json();
    for (const k of Object.keys(body)) expect(PUBLIC_KEYS).toContain(k);
  });

  test('AUSENCIA explícita de SIGNATURE_KEYS y EMPLOYER_KEYS', async () => {
    const body = await (await get('/api/settings')).json();
    for (const k of [...SIGNATURE_KEYS, ...EMPLOYER_KEYS]) expect(body).not.toHaveProperty(k);
  });

  test('ningún valor sensible aparece en el cuerpo público', async () => {
    const raw = await (await get('/api/settings')).text();
    for (const v of Object.values(SECRET_VALUES)) expect(raw).not.toContain(v);
    expect(raw).not.toMatch(/IPS-PATRONAL|representante legal|CI-1234567/);
  });
});

describe('GET /api/settings/admin (autenticado)', () => {
  test('sin token → 401', async () => {
    expect((await get('/api/settings/admin')).status).toBe(401);
  });

  test('rol insuficiente (employee) → 403', async () => {
    expect((await get('/api/settings/admin', token('employee'))).status).toBe(403);
  });

  test('admin autenticado → 200 con la config completa (incluye firma/empleador)', async () => {
    const r = await get('/api/settings/admin', token('admin'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.system_signer_doc_id).toBe(SECRET_VALUES.system_signer_doc_id);
    expect(body.employer_ruc).toBe(SECRET_VALUES.employer_ruc);
    expect(body.system_name).toBeDefined(); // también el branding
  });
});
