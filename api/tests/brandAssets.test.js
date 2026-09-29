/**
 * brandAssets.test.js — recursos de marca administrables desde la aplicación
 * sin tocar nginx, sin publicar archivos privados (HTTP real).
 *
 * Router REAL de ajustes, authenticate/authorize/requirePermission reales,
 * uploadsGuard + estático reales y archivos reales en un UPLOAD_DIR temporal.
 * La base es simulada en memoria (tests/helpers/memorySettingsDb).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-brand-'));
process.env.UPLOAD_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-brand-assets-0123456789';

jest.mock('../src/config/database', () => {
  const { createMemorySettingsDb } = require('./helpers/memorySettingsDb');
  const db = createMemorySettingsDb({
    users: {
      1: { id: 1, role: 'admin', active: 1, employee_id: null },
      7: { id: 7, role: 'employee', active: 1, employee_id: 100 },
    },
  });
  return { sequelize: db.sequelize, __db: db };
});
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { __db: db } = require('../src/config/database');
const { uploadsGuard, setPublicUploadHeaders, invalidatePublicAssets } = require('../src/middleware/uploadsGuard');

let server; let base;
const token = (id) => jwt.sign({ id, role: db.state.users[id].role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
const auth = (id) => ({ Authorization: `Bearer ${token(id)}` });
const png = (r = 10) => sharp({ create: { width: 4, height: 4, channels: 3, background: { r, g: 2, b: 3 } } }).png().toBuffer();

async function upload(kind, buf, name = 'img.png', type = 'image/png', user = 1) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  return fetch(`${base}/api/settings/upload?kind=${kind}`, { method: 'POST', headers: auth(user), body: fd });
}
const put = (body, user = 1) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { ...auth(user), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const publicSettings = async () => (await fetch(`${base}/api/settings`)).json();
const getBytes = async (url) => {
  const r = await fetch(base + url);
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
const rootFiles = () => fs.readdirSync(TMP).filter((f) => f !== 'brand').sort();
const brandFiles = () => (fs.existsSync(path.join(TMP, 'brand')) ? fs.readdirSync(path.join(TMP, 'brand')).sort() : []);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/uploads', uploadsGuard, express.static(TMP, { setHeaders: setPublicUploadHeaders }));
  app.use('/api/settings', require('../src/routes/settings'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  db.state.settings.clear();
  invalidatePublicAssets();
});

describe('cambio de marca desde la aplicación (sin intervenir nginx)', () => {
  test.each([
    ['logo', 'system_logo_url'], ['favicon', 'system_favicon_url'],
    ['pwa_icon', 'system_pwa_icon_url'], ['login_bg', 'system_login_bg_image'],
  ])('%s: subir → URL anunciada sirve la imagen; reemplazar; restablecer', async (kind, key) => {
    const a = await png(10);
    const r1 = await upload(kind, a);
    expect(r1.status).toBe(200);
    const u1 = (await r1.json()).url;
    expect(u1).toMatch(/^\/uploads\/brand\/\d+_[0-9a-f]{12}\.png$/);
    expect((await publicSettings())[key]).toBe(u1);
    const g1 = await getBytes(u1);
    expect(g1.status).toBe(200);
    expect(g1.body.equals(a)).toBe(true);
    expect(g1.headers.get('x-content-type-options')).toBe('nosniff');

    const b = await png(200);
    const u2 = (await (await upload(kind, b)).json()).url;
    expect(u2).not.toBe(u1);
    expect((await publicSettings())[key]).toBe(u2);
    expect((await getBytes(u2)).body.equals(b)).toBe(true);

    expect((await fetch(`${base}/api/settings/reset`, { method: 'POST', headers: auth(1) })).status).toBe(200);
    expect((await publicSettings())[key]).toBe('');
  });

  test('guardar la pantalla completa devuelve la URL anunciada sin alterarla', async () => {
    const u = (await (await upload('logo', await png())).json()).url;
    const admin = await (await fetch(`${base}/api/settings/admin`, { headers: auth(1) })).json();
    expect((await put({ ...admin, system_name: 'Otra' })).status).toBe(200);
    expect(db.state.settings.get('system_logo_url')).toBe(u);
    expect(db.state.settings.get('system_name')).toBe('Otra');
  });
});

describe('valores heredados en la raíz (antes de uploads/brand)', () => {
  test('se anuncian por /api/settings/brand/:kind, que sirve el archivo; guardar no los cambia', async () => {
    const legacy = await png(77);
    fs.writeFileSync(path.join(TMP, '1700000000_ab12cd.png'), legacy);
    db.state.settings.set('system_logo_url', '/uploads/1700000000_ab12cd.png');
    const announced = (await publicSettings()).system_logo_url;
    expect(announced).toMatch(/^\/api\/settings\/brand\/logo\?v=[0-9a-f]{12}$/);
    const g = await getBytes(announced);
    expect(g.status).toBe(200);
    expect(g.body.equals(legacy)).toBe(true);
    expect(g.headers.get('cache-control')).toBe('public, max-age=3600');

    const admin = await (await fetch(`${base}/api/settings/admin`, { headers: auth(1) })).json();
    expect(admin.system_logo_url).toBe(announced);
    expect((await put(admin)).status).toBe(200);
    expect(db.state.settings.get('system_logo_url')).toBe('/uploads/1700000000_ab12cd.png');
  });
});

describe('lo privado sigue privado', () => {
  test('firma y sello se guardan fuera de uploads/brand y no se publican', async () => {
    const r = await upload('signature', await png(5));
    const url = (await r.json()).url;
    expect(url).toMatch(/^\/uploads\/\d+_[0-9a-f]{12}\.png$/);
    expect(brandFiles().some((f) => url.endsWith(f))).toBe(false);
    expect((await getBytes(url)).status).toBe(404);
    expect((await getBytes('/api/settings/brand/signature')).status).toBe(404);
    expect((await getBytes('/api/settings/brand/seal')).status).toBe(404);
  });

  test('PUT no puede apuntar el logo a un archivo privado ni fuera de uploads/brand', async () => {
    const sig = (await (await upload('signature', await png(6))).json()).url;
    for (const bad of [
      sig,
      '/uploads/avatar_7_aa.png',
      '/uploads/brand/../' + sig.split('/').pop(),
      '/uploads/brand/no-existe.png',
      '/uploads/selfies/selfie_1_1.jpg',
      '//uploads/brand/x.png',
      '/uploads/brand%2F..%2Fx.png',
      '/api/settings/brand/favicon',
    ]) {
      const r = await put({ system_logo_url: bad });
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect(db.state.settings.has('system_logo_url')).toBe(false);
  });

  test('un PUT con un valor inválido no escribe NINGUNO de los ajustes del lote', async () => {
    expect((await put({ system_name: 'Nuevo', system_logo_url: '/uploads/x.png' })).status).toBe(400);
    expect(db.state.settings.has('system_name')).toBe(false);
  });

  test('valores admitidos: vacío, archivo existente de uploads/brand, recurso de la web o externo', async () => {
    const u = (await (await upload('favicon', await png())).json()).url;
    db.state.settings.clear();
    for (const ok of [u, '', '/icons/icon-192.png', 'https://cdn.example.invalid/logo.png']) {
      expect((await put({ system_favicon_url: ok })).status).toBe(200);
      expect(db.state.settings.get('system_favicon_url')).toBe(ok);
    }
  });

  test('uploadsGuard: brand/ con recorrido, subcarpetas o extensión no imagen → 404', async () => {
    fs.mkdirSync(path.join(TMP, 'brand', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'brand', 'sub', 'a.png'), await png());
    fs.writeFileSync(path.join(TMP, 'brand', 'nota.txt'), 'x');
    for (const p of ['/uploads/brand/sub/a.png', '/uploads/brand/nota.txt', '/uploads/brand/..%2F1700000000_ab12cd.png']) {
      expect((await getBytes(p)).status).toBe(404);
    }
  });

  test('sin permiso no se puede cambiar la marca (ni se escribe archivo)', async () => {
    const before = [rootFiles(), brandFiles()];
    expect((await upload('logo', await png(), 'a.png', 'image/png', 7)).status).toBe(403);
    expect((await put({ system_logo_url: '' }, 7)).status).toBe(403);
    expect([rootFiles(), brandFiles()]).toEqual(before);
    expect(db.state.settings.size).toBe(0);
  });

  test('error de base al guardar la carga de marca → 500 y se retira el archivo nuevo', async () => {
    const before = brandFiles();
    db.state.failOn = /INSERT INTO notification_settings/;
    expect((await upload('logo', await png(9))).status).toBe(500);
    expect(brandFiles()).toEqual(before);
  });

  test('extensión que no es imagen para marca → 400 sin archivo', async () => {
    const before = [rootFiles(), brandFiles()];
    expect((await upload('logo', await png(), 'logo.html', 'image/png')).status).toBe(400);
    expect([rootFiles(), brandFiles()]).toEqual(before);
  });
});
