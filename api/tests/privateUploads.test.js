/**
 * privateUploads.test.js — archivos privados y estático público (HTTP real).
 *
 * Levanta un Express real en un puerto local con los routers REALES (me,
 * employees, attendance, permissions, settings), autenticación JWT REAL,
 * requirePermission/capabilities/departmentScope/enforceEmployeeScope REALES y
 * archivos reales en un UPLOAD_DIR temporal. Sólo la base está simulada (datos
 * sintéticos). Verifica:
 *   - /uploads sirve sólo la lista positiva configurada (logo…); avatares,
 *     firmas, selfies, documentos, justificativos, carpetas desconocidas y
 *     rutas codificadas/traversal → 404; fallo de base → 404 (fail-closed);
 *   - endpoints privados: anónimo 401, autorizado 200 con
 *     Cache-Control private,no-store, fuera de alcance 404, sin capacidad 403;
 *   - carga: contenido validado (extensión/MIME falsos, imagen truncada,
 *     dimensiones, PDF sin terminador) y sin huérfanos ante rechazo o error de
 *     base tras la carga; el archivo anterior no se toca.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-private-'));
process.env.UPLOAD_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-private-uploads-0123456789';

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../src/services/audit', () => ({ log: jest.fn(), sanitizeDetails: jest.fn() }));
jest.mock('../src/services/notifications', () => ({ notifyPermissionCreated: jest.fn().mockResolvedValue() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { sequelize } = require('../src/config/database');
const { uploadsGuard, setPublicUploadHeaders, invalidatePublicAssets } = require('../src/middleware/uploadsGuard');

let world;
let failNext = null; // { match: RegExp } → la próxima query que coincida lanza

function resetWorld() {
  world = {
    users: {
      7: { id: 7, role: 'employee', active: 1, employee_id: 100, branch_id: null, photo_url: null },
      8: { id: 8, role: 'employee', active: 1, employee_id: 200, branch_id: null, photo_url: null },
      5: { id: 5, role: 'manager', active: 1, employee_id: null, branch_id: 1, photo_url: null },
      2: { id: 2, role: 'hr', active: 1, employee_id: null, branch_id: null, photo_url: null },
      1: { id: 1, role: 'admin', active: 1, employee_id: null, branch_id: null, photo_url: null },
    },
    employees: {
      100: { id: 100, department_id: 1, photo_url: '/uploads/avatar_1_aa.png' },
      200: { id: 200, department_id: 2, photo_url: '/uploads/avatar_2_bb.png' },
    },
    departmentsByBranch: { 1: [1] },
    settings: {
      system_logo_url: '/uploads/1700000000_logo.png',
      system_signature_url: '/uploads/signature_1.png',
    },
    logs: {
      900: { selfie_url: '/uploads/selfies/selfie_100_1.jpg', employee_id: 100, department_id: 1 },
      901: { selfie_url: '/uploads/selfies/selfie_200_1.jpg', employee_id: 200, department_id: 2 },
    },
    permissions: {
      10: { id: 10, employee_id: 100, department_id: 1, attachment_url: '/uploads/permissions/perm_1_aa.pdf', attachment_filename: 'certificado.pdf', attachment_mime: 'application/pdf', approval_state: 'pending' },
    },
  };
  failNext = null;
}

function installDb() {
  sequelize.query.mockImplementation(async (sql, opts = {}) => {
    const rp = opts.replacements || [];
    if (failNext && failNext.test(sql)) { failNext = null; throw new Error('ER_LOCK_WAIT_TIMEOUT'); }
    if (/FROM notification_settings\s+WHERE setting_key IN/.test(sql)) {
      return [rp.filter((k) => world.settings[k] != null).map((k) => ({ setting_key: k, setting_value: world.settings[k] }))];
    }
    if (/FROM notification_settings WHERE setting_key = \? LIMIT 1/.test(sql)) {
      const v = world.settings[rp[0]];
      return [v != null ? [{ setting_value: v }] : []];
    }
    if (/SELECT id, role, active, employee_id FROM users WHERE id = \? LIMIT 1/.test(sql)) {
      const u = world.users[rp[0]]; return [u ? [u] : []];
    }
    if (/SELECT branch_id FROM users WHERE id = \? AND active = 1/.test(sql)) {
      const u = world.users[rp[0]]; return [u && u.active ? [{ branch_id: u.branch_id }] : []];
    }
    if (/SELECT id FROM departments WHERE active = 1 AND branch_id = \?/.test(sql)) {
      return [(world.departmentsByBranch[rp[0]] || []).map((id) => ({ id }))];
    }
    if (/FROM user_permissions/.test(sql)) return [[]];
    if (/SELECT department_id FROM employees WHERE id = \? LIMIT 1/.test(sql)) {
      const e = world.employees[rp[0]]; return [e ? [{ department_id: e.department_id }] : []];
    }
    if (/SELECT photo_url FROM employees WHERE id = \? LIMIT 1/.test(sql)) {
      const e = world.employees[rp[0]]; return [e ? [{ photo_url: e.photo_url }] : []];
    }
    if (/SELECT photo_url FROM users WHERE id = \? AND active = 1/.test(sql)) {
      const u = world.users[rp[0]]; return [u ? [{ photo_url: u.photo_url }] : []];
    }
    if (/UPDATE employees SET photo_url = \? WHERE id = \?/.test(sql)) {
      world.employees[rp[1]].photo_url = rp[0]; return [{ affectedRows: 1 }];
    }
    if (/FROM attendance_logs al JOIN employees e/.test(sql)) {
      const l = world.logs[rp[0]]; return [l ? [l] : []];
    }
    if (/FROM permissions p/.test(sql) && /WHERE p\.id = \?/.test(sql)) {
      const p = world.permissions[rp[0]]; return [p ? [p] : []];
    }
    if (/UPDATE permissions SET\s+attachment_url\s+= \?/.test(sql)) return [{ affectedRows: 1 }];
    if (/INSERT INTO permission_approval_events/.test(sql)) return [{ insertId: 1 }];
    return [[]];
  });
}

let server; let base;
const token = (id) => jwt.sign({ id, role: world.users[id].role, username: `u${id}` }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
const get = (p, id) => fetch(base + p, { headers: id ? { Authorization: `Bearer ${token(id)}` } : {} });
// Petición HTTP con la ruta LITERAL (fetch normaliza %2e%2e en el cliente).
const http = require('http');
function rawGet(p) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null } }));
    });
    req.on('error', reject);
    req.end();
  });
}
const listFiles = (dir = TMP) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

async function pngBuf(w = 8, h = 8) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}
async function jpgBuf(w = 64, h = 64) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 20, b: 30 } } }).jpeg().toBuffer();
}

beforeAll(async () => {
  resetWorld();
  installDb();
  // Archivos reales en disco.
  fs.mkdirSync(path.join(TMP, 'permissions'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'selfies'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'employee-documents'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'nuevo'), { recursive: true });
  const png = await pngBuf();
  const jpg = await jpgBuf();
  for (const n of ['1700000000_logo.png', 'avatar_1_aa.png', 'avatar_2_bb.png', 'signature_1.png', 'nuevo/x.png', 'employee-documents/doc_1.png']) {
    fs.writeFileSync(path.join(TMP, n), png);
  }
  fs.writeFileSync(path.join(TMP, 'selfies', 'selfie_100_1.jpg'), jpg);
  fs.writeFileSync(path.join(TMP, 'selfies', 'selfie_200_1.jpg'), jpg);
  fs.writeFileSync(path.join(TMP, 'permissions', 'perm_1_aa.pdf'), Buffer.from('%PDF-1.7\n' + 'x'.repeat(100) + '\n%%EOF\n'));

  const app = express();
  app.use(express.json());
  app.use('/uploads', uploadsGuard, express.static(TMP, { maxAge: '7d', setHeaders: setPublicUploadHeaders }));
  app.use('/api/me', require('../src/routes/me'));
  app.use('/api/employees', require('../src/routes/employees'));
  app.use('/api/attendance', require('../src/routes/attendance'));
  app.use('/api/permissions', require('../src/routes/permissions'));
  app.use('/api/settings', require('../src/routes/settings'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Error' }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  const keep = world;
  resetWorld();
  world.employees[100].photo_url = keep.employees[100].photo_url; // conserva cambios de carga entre tests
  installDb();
  invalidatePublicAssets();
});

describe('estático /uploads — lista positiva', () => {
  test('logo configurado: anónimo 200 con caché pública acotada, nosniff y CSP sandbox', async () => {
    const r = await get('/uploads/1700000000_logo.png');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  test.each([
    ['avatar en la raíz', '/uploads/avatar_1_aa.png'],
    ['firma', '/uploads/signature_1.png'],
    ['selfie', '/uploads/selfies/selfie_100_1.jpg'],
    ['justificativo', '/uploads/permissions/perm_1_aa.pdf'],
    ['documento', '/uploads/employee-documents/doc_1.png'],
    ['carpeta desconocida', '/uploads/nuevo/x.png'],
    ['codificada', '/uploads/%70ermissions/perm_1_aa.pdf'],
    ['traversal codificado', '/uploads/nuevo/%2e%2e/1700000000_logo.png'],
    ['traversal doble codificado', '/uploads/nuevo/%252e%252e/1700000000_logo.png'],
    ['barra invertida', '/uploads/nuevo%5cx.png'],
    ['inexistente', '/uploads/nada.png'],
  ])('%s → 404 no-store (anónimo)', async (_n, p) => {
    const r = await rawGet(p);
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  test('un usuario autenticado tampoco obtiene archivos privados por /uploads', async () => {
    expect((await get('/uploads/avatar_1_aa.png', 7)).status).toBe(404);
  });

  test('error de base al leer la lista → 404 (fail-closed)', async () => {
    failNext = /FROM notification_settings\s+WHERE setting_key IN/;
    expect((await get('/uploads/1700000000_logo.png')).status).toBe(404);
  });

  test('al cambiar la configuración (invalidación) el recurso nuevo se sirve y el viejo deja de servirse', async () => {
    world.settings.system_logo_url = '/uploads/avatar_2_bb.png';
    invalidatePublicAssets();
    expect((await get('/uploads/avatar_2_bb.png')).status).toBe(200);
    expect((await get('/uploads/1700000000_logo.png')).status).toBe(404);
  });
});

describe('endpoints privados', () => {
  const privateHeaders = (r) => {
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toMatch(/sandbox/);
  };

  test('GET /api/me/photo: anónimo 401; propio 200 inline sin caché compartida', async () => {
    expect((await get('/api/me/photo')).status).toBe(401);
    const r = await get('/api/me/photo', 7);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
    privateHeaders(r);
  });

  test('GET /api/employees/:id/photo: manager en alcance 200; fuera 404; employee sin empleados.view 403', async () => {
    const inScope = await get('/api/employees/100/photo', 5);
    expect(inScope.status).toBe(200);
    privateHeaders(inScope);
    expect((await get('/api/employees/200/photo', 5)).status).toBe(404);
    expect((await get('/api/employees/100/photo', 8)).status).toBe(403);
    expect((await get('/api/employees/1e2/photo', 2)).status).toBe(400);
  });

  test('GET /api/attendance/logs/:id/selfie: hr 200; manager fuera de alcance 404; employee 403', async () => {
    const r = await get('/api/attendance/logs/900/selfie', 2);
    expect(r.status).toBe(200);
    privateHeaders(r);
    expect((await get('/api/attendance/logs/901/selfie', 5)).status).toBe(404);
    expect((await get('/api/attendance/logs/900/selfie', 7)).status).toBe(403);
    expect((await get('/api/attendance/logs/900/selfie')).status).toBe(401);
  });

  test('GET /api/settings/assets/signature: admin 200; manager 403; anónimo 401', async () => {
    const r = await get('/api/settings/assets/signature', 1);
    expect(r.status).toBe(200);
    privateHeaders(r);
    expect((await get('/api/settings/assets/signature', 5)).status).toBe(403);
    expect((await get('/api/settings/assets/signature')).status).toBe(401);
  });

  test('GET /api/permissions/:id/attachment: dueño 200 como attachment; otro empleado 404', async () => {
    const r = await get('/api/permissions/10/attachment', 7);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="certificado\.pdf"/);
    privateHeaders(r);
    expect((await get('/api/permissions/10/attachment', 8)).status).toBe(404);
  });
});

describe('carga de archivos — contenido validado y sin huérfanos', () => {
  async function postPhoto(id, buf, name, type) {
    const fd = new FormData();
    fd.append('photo', new Blob([buf], { type }), name);
    return fetch(`${base}/api/me/photo`, { method: 'POST', headers: { Authorization: `Bearer ${token(id)}` }, body: fd });
  }
  async function postAttachment(id, permId, buf, name, type) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), name);
    return fetch(`${base}/api/permissions/${permId}/attachment`, { method: 'POST', headers: { Authorization: `Bearer ${token(id)}` }, body: fd });
  }

  test('PNG válido → 200; se guarda con la extensión del contenido', async () => {
    const before = listFiles();
    const r = await postPhoto(7, await pngBuf(), 'foto.jpg', 'image/jpeg'); // nombre/MIME falsos, contenido PNG
    expect(r.status).toBe(200);
    const { url } = await r.json();
    expect(url).toMatch(/^\/uploads\/avatar_\d+_[0-9a-f]+\.png$/);
    const added = listFiles().filter((f) => !before.includes(f));
    expect(added).toEqual([path.basename(url)]);
    expect(world.employees[100].photo_url).toBe(url);
  });

  test.each([
    ['HTML con extensión y MIME de imagen', Buffer.from('<!doctype html><script>x</script>'), 'x.png', 'image/png'],
    ['PNG truncado', 'png-trunc', 'x.png', 'image/png'],
    ['JPEG truncado', 'jpg-trunc', 'x.jpg', 'image/jpeg'],
    ['dimensiones fuera de rango', 'png-huge', 'x.png', 'image/png'],
  ])('%s → 400 y ningún archivo nuevo', async (_n, input, name, type) => {
    let buf = input;
    if (input === 'png-trunc') { const b = await pngBuf(64, 64); buf = b.subarray(0, Math.floor(b.length / 2)); }
    if (input === 'jpg-trunc') { const b = await jpgBuf(256, 256); buf = b.subarray(0, Math.floor(b.length / 2)); }
    if (input === 'png-huge') buf = await pngBuf(13000, 1);
    const before = listFiles();
    const r = await postPhoto(7, buf, name, type);
    expect(r.status).toBe(400);
    expect(listFiles()).toEqual(before);
  });

  test('error de base DESPUÉS de la carga → 500, se retira el archivo nuevo y el anterior sigue', async () => {
    const previous = world.employees[100].photo_url;
    const before = listFiles();
    failNext = /UPDATE employees SET photo_url/;
    const r = await postPhoto(7, await pngBuf(), 'ok.png', 'image/png');
    expect(r.status).toBe(500);
    expect(listFiles()).toEqual(before);
    expect(world.employees[100].photo_url).toBe(previous);
    expect(fs.existsSync(path.join(TMP, path.basename(previous)))).toBe(true);
  });

  test('adjunto: PDF sin terminador → 400 sin archivo; no autorizado → 404 sin escribir nada', async () => {
    const before = listFiles();
    const bad = await postAttachment(7, 10, Buffer.from('%PDF-1.7\n' + 'x'.repeat(200)), 'a.pdf', 'application/pdf');
    expect(bad.status).toBe(400);
    const denied = await postAttachment(8, 10, Buffer.from('%PDF-1.7\n' + 'x'.repeat(100) + '\n%%EOF\n'), 'a.pdf', 'application/pdf');
    expect(denied.status).toBe(404);
    expect(listFiles()).toEqual(before);
  });

  test('adjunto: error de base al persistir → 500 y el archivo nuevo se retira; el adjunto anterior sigue', async () => {
    const before = listFiles();
    failNext = /UPDATE permissions SET\s+attachment_url\s+= \?/;
    const r = await postAttachment(7, 10, Buffer.from('%PDF-1.7\n' + 'x'.repeat(100) + '\n%%EOF\n'), 'a.pdf', 'application/pdf');
    expect(r.status).toBe(500);
    expect(listFiles()).toEqual(before);
    expect(fs.existsSync(path.join(TMP, 'permissions', 'perm_1_aa.pdf'))).toBe(true);
  });
});
