/**
 * uploadsHardening.test.js — unidades de la contención de archivos subidos.
 *
 *  - tipo por contenido (magic bytes), no por nombre/mimetype;
 *  - validación de contenido completa (sharp decodifica la imagen entera;
 *    PDF con cabecera y terminador); el archivo rechazado se borra;
 *  - uploadsGuard: lista positiva desde los ajustes de marca; todo lo demás
 *    (incluidas carpetas nuevas y rutas codificadas/traversal) → no público;
 *    fallo de base → no público;
 *  - resolvePrivatePath: sólo rutas dentro del subdirectorio esperado.
 * Las descargas/cabeceras por HTTP real están en privateUploads.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-uploads-'));
process.env.UPLOAD_DIR = TMP;

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));

const sharp = require('sharp');
const { sequelize } = require('../src/config/database');
const { sniffType, finalizeUpload } = require('../src/utils/uploadSniff');
const {
  uploadsGuard, setPublicUploadHeaders, isPublicUploadPath, invalidatePublicAssets,
  publicNameFromSetting, UPLOADS_CSP,
} = require('../src/middleware/uploadsGuard');
const { resolvePrivatePath } = require('../src/utils/privateFile');

const HTML = Buffer.from('<!doctype html><p>x</p>');
const PDF_OK = Buffer.from('%PDF-1.7\n' + 'x'.repeat(100) + '\n%%EOF\n');
const png = (w = 8, h = 8) => sharp({ create: { width: w, height: h, channels: 3, background: '#123456' } }).png().toBuffer();
const jpg = (w = 32, h = 32) => sharp({ create: { width: w, height: h, channels: 3, background: '#654321' } }).jpeg().toBuffer();
const webp = (w = 8, h = 8) => sharp({ create: { width: w, height: h, channels: 3, background: '#abcdef' } }).webp().toBuffer();

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('sniffType — tipo por contenido', () => {
  test('png/jpg/webp/pdf reales se detectan', async () => {
    expect(sniffType(await png())).toBe('png');
    expect(sniffType(await jpg())).toBe('jpg');
    expect(sniffType(await webp())).toBe('webp');
    expect(sniffType(PDF_OK)).toBe('pdf');
  });
  test('texto/HTML u otros → null', () => {
    expect(sniffType(HTML)).toBeNull();
    expect(sniffType(Buffer.from(''))).toBeNull();
    expect(sniffType('no-buffer')).toBeNull();
  });
});

describe('finalizeUpload — validación completa', () => {
  function writeTmp(name, buf) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, buf);
    return { path: p, filename: name };
  }

  test('imagen válida: renombra con la extensión real y devuelve dimensiones', async () => {
    const f = writeTmp('avatar_1_abc.upload', await png(10, 6));
    const out = await finalizeUpload(f, ['jpg', 'png', 'webp']);
    expect(out).toMatchObject({ filename: 'avatar_1_abc.png', mime: 'image/png', width: 10, height: 6 });
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test.each([
    ['HTML', async () => HTML],
    ['PNG con firma válida pero truncado', async () => { const b = await png(64, 64); return b.subarray(0, Math.floor(b.length / 2)); }],
    ['JPEG truncado', async () => { const b = await jpg(256, 256); return b.subarray(0, Math.floor(b.length / 2)); }],
    ['sólo la firma PNG', async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ['imagen demasiado ancha', async () => png(13000, 1)],
  ])('%s → 400 y archivo borrado', async (_n, make) => {
    const f = writeTmp(`bad_${Math.random().toString(16).slice(2)}.upload`, await make());
    await expect(finalizeUpload(f, ['jpg', 'png', 'webp'])).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test('tipo real válido pero fuera de la lista del endpoint → 400', async () => {
    const f = writeTmp('avatar_3.upload', PDF_OK);
    await expect(finalizeUpload(f, ['jpg', 'png', 'webp'])).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test('PDF: exige terminador %%EOF', async () => {
    const ok = writeTmp('perm_ok.upload', PDF_OK);
    expect((await finalizeUpload(ok, ['pdf'])).filename).toBe('perm_ok.pdf');
    const bad = writeTmp('perm_bad.upload', Buffer.from('%PDF-1.7\n' + 'x'.repeat(200)));
    await expect(finalizeUpload(bad, ['pdf'])).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(bad.path)).toBe(false);
  });
});

describe('uploadsGuard — lista positiva desde ajustes de marca', () => {
  let settings;
  beforeEach(() => {
    invalidatePublicAssets();
    settings = { system_logo_url: '/uploads/1700_logo.png', system_favicon_url: '/uploads/1700_fav.ico' };
    sequelize.query.mockReset();
    sequelize.query.mockImplementation(async (_sql, opts) => [
      (opts.replacements || []).filter((k) => settings[k]).map((k) => ({ setting_key: k, setting_value: settings[k] })),
    ]);
  });

  test.each(['/1700_logo.png', '/1700_fav.ico'])('configurado → público: %s', async (p) => {
    expect(await isPublicUploadPath(p)).toBe(true);
  });

  test.each([
    '/avatar_1_abc.png', '/signature_1.png', '/otro.png',
    '/permissions/1700_logo.png', '/nuevo/1700_logo.png', '/Permissions/x.png',
    '/%70ermissions/x.png', '/x/../1700_logo.png', '/../1700_logo.png', '/./1700_logo.png/',
    '/1700_logo.png%00.html', '/%E0%A4%A.png', '/1700_logo.html',
  ])('no configurado o ruta no canónica → no público: %s', async (p) => {
    expect(await isPublicUploadPath(p)).toBe(false);
  });

  test('error de base → nada es público (fail-closed)', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await isPublicUploadPath('/1700_logo.png')).toBe(false);
  });

  test('publicNameFromSetting sólo acepta /uploads/<archivo-imagen> de un segmento', () => {
    expect(publicNameFromSetting('/uploads/a.png')).toBe('a.png');
    expect(publicNameFromSetting('/uploads/sub/a.png')).toBeNull();
    expect(publicNameFromSetting('https://cdn/x.png')).toBeNull();
    expect(publicNameFromSetting('/uploads/a.html')).toBeNull();
    expect(publicNameFromSetting('/uploads/.a.png')).toBeNull();
    expect(publicNameFromSetting(null)).toBeNull();
  });

  test('middleware: 404 no-store en no público; next() en público', async () => {
    const mk = () => ({ statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json: jest.fn() });
    const res = mk(); const next = jest.fn();
    await uploadsGuard({ path: '/avatar_1_abc.png' }, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(next).not.toHaveBeenCalled();
    await uploadsGuard({ path: '/1700_logo.png' }, mk(), next);
    expect(next).toHaveBeenCalled();
  });

  test('cabeceras públicas: nosniff, CSP sandbox y caché acotada', () => {
    const h = {};
    setPublicUploadHeaders({ setHeader: (k, v) => { h[k] = v; } });
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe(UPLOADS_CSP);
    expect(h['Cache-Control']).toBe('public, max-age=3600');
  });
});

describe('resolvePrivatePath', () => {
  test('sólo dentro del subdirectorio y patrón esperados', () => {
    expect(resolvePrivatePath('/uploads/permissions/p.pdf', { subdir: 'permissions' })).toBe(path.join(TMP, 'permissions', 'p.pdf'));
    expect(resolvePrivatePath('/uploads/p.pdf', { subdir: 'permissions' })).toBeNull();
    expect(resolvePrivatePath('/uploads/permissions/../x.pdf', { subdir: 'permissions' })).toBeNull();
    expect(resolvePrivatePath('/uploads/permissions/.hidden', { subdir: 'permissions' })).toBeNull();
    expect(resolvePrivatePath('/uploads/avatar_1_ab.png', { namePattern: /^avatar_/ })).toBe(path.join(TMP, 'avatar_1_ab.png'));
    expect(resolvePrivatePath('/uploads/logo.png', { namePattern: /^avatar_/ })).toBeNull();
    expect(resolvePrivatePath('https://x/a.png')).toBeNull();
    expect(resolvePrivatePath(null)).toBeNull();
  });
});

describe('cableado', () => {
  test('index.js monta el guard ANTES del estático y con setHeaders', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(src).toMatch(/app\.use\('\/uploads',\s*uploadsGuard,\s*express\.static\(UPLOAD_DIR,\s*\{[^}]*setHeaders:\s*setPublicUploadHeaders/);
    expect(src).not.toMatch(/app\.use\('\/uploads',\s*express\.static/);
  });

  test('foto y justificativo usan finalizeUpload y no la extensión del cliente', () => {
    const me = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'me.js'), 'utf8');
    const perm = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'permissions.js'), 'utf8');
    expect(me).not.toMatch(/extname\(file\.originalname\)/);
    expect(perm).not.toMatch(/file\.originalname\.replace/);
    expect(me).toMatch(/finalizeUpload\(req\.file, \['jpg', 'png', 'webp'\]\)/);
    expect(perm).toMatch(/finalizeUpload\(req\.file, \['pdf', 'jpg', 'png', 'webp'\]\)/);
  });

  test('nginx no agrega caché pública propia a /uploads', () => {
    const conf = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'nginx-sishoras.conf'), 'utf8');
    const block = conf.slice(conf.indexOf('location /uploads/'), conf.indexOf('}', conf.indexOf('location /uploads/')));
    expect(block).not.toMatch(/expires|Cache-Control|public|immutable/i);
    expect(block).toMatch(/proxy_pass/);
    expect(conf).not.toMatch(/alias\s+[^;]*uploads/);
  });
});
