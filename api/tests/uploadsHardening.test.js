/**
 * uploadsHardening.test.js — contención de archivos subidos.
 *
 *  - el tipo se decide por contenido (magic bytes), no por nombre/mimetype;
 *  - un archivo no permitido se borra y responde 400;
 *  - el estático /uploads sólo sirve imágenes públicas: los subdirectorios
 *    privados y las no-imágenes responden 404 (también con codificación,
 *    mayúsculas o traversal);
 *  - lo servido lleva nosniff + CSP sandbox;
 *  - los justificativos se descargan sólo por endpoint autenticado con alcance.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-uploads-'));
process.env.UPLOAD_DIR = TMP;

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/departmentScope', () => {
  const actual = jest.requireActual('../src/services/departmentScope');
  return { ...actual, getVisibleDepartmentIds: jest.fn() };
});
jest.mock('../src/services/permissionWorkflow', () => ({
  computeNeedsForNewPermission: jest.fn(), logEvent: jest.fn().mockResolvedValue(),
  getInboxFor: jest.fn(), canUserActOn: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({ notifyPermissionCreated: jest.fn() }));

const { sniffType, finalizeUpload } = require('../src/utils/uploadSniff');
const {
  uploadsGuard, setPublicUploadHeaders, isPublicUploadPath, UPLOADS_CSP,
} = require('../src/middleware/uploadsGuard');
const { sequelize } = require('../src/config/database');
const departmentScope = require('../src/services/departmentScope');
const permissionsRouter = require('../src/routes/permissions');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n');
const HTML = Buffer.from('<!doctype html><p>x</p>');

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('sniffType — tipo por contenido', () => {
  test.each([['png', PNG], ['jpg', JPG], ['webp', WEBP], ['pdf', PDF]])('%s detectado', (ext, buf) => {
    expect(sniffType(buf)).toBe(ext);
  });
  test('texto/HTML no se reconoce como ningún tipo permitido', () => {
    expect(sniffType(HTML)).toBeNull();
    expect(sniffType(Buffer.from(''))).toBeNull();
    expect(sniffType('no-buffer')).toBeNull();
  });
});

describe('finalizeUpload', () => {
  function writeTmp(name, buf) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, buf);
    return { path: p, filename: name };
  }

  test('permitido: renombra con la extensión del contenido real', async () => {
    const f = writeTmp('avatar_1_abc.upload', PNG);
    const out = await finalizeUpload(f, ['jpg', 'png', 'webp']);
    expect(out.filename).toBe('avatar_1_abc.png');
    expect(out.mime).toBe('image/png');
    expect(fs.existsSync(path.join(TMP, 'avatar_1_abc.png'))).toBe(true);
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test('contenido no permitido: borra el archivo y lanza 400', async () => {
    const f = writeTmp('avatar_2_def.upload', HTML);
    await expect(finalizeUpload(f, ['jpg', 'png', 'webp'])).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(f.path)).toBe(false);
  });

  test('tipo real válido pero fuera de la lista del endpoint: rechazado', async () => {
    const f = writeTmp('avatar_3_ghi.upload', PDF);
    await expect(finalizeUpload(f, ['jpg', 'png', 'webp'])).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(f.path)).toBe(false);
  });
});

describe('uploadsGuard — qué sirve el estático público', () => {
  test.each([
    '/logo.png', '/favicon.ico', '/bg.jpg', '/firma_1.png', '/avatar_1_abc.webp', '/logo.svg',
  ])('público permitido: %s', (p) => expect(isPublicUploadPath(p)).toBe(true));

  test.each([
    '/permissions/perm_1.pdf',
    '/permissions/perm_1.png',
    '/Permissions/perm_1.png',
    '/%70ermissions/perm_1.png',
    '/selfies/selfie_1_2.jpg',
    '/employee-documents/doc_1.pdf',
    '/x/../permissions/perm_1.png',
    '/../secret.png',
    '/page.html',
    '/script.js',
    '/doc.pdf',
    '/noext',
    '/%E0%A4%A.png',
    '/a.png%00.html',
  ])('bloqueado: %s', (p) => expect(isPublicUploadPath(p)).toBe(false));

  test('middleware: 404 en ruta privada, next() en pública', () => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json: jest.fn() };
    const next = jest.fn();
    uploadsGuard({ path: '/permissions/perm_1.pdf' }, res, next);
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
    uploadsGuard({ path: '/logo.png' }, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('lo servido lleva nosniff y CSP sandbox', () => {
    const headers = {};
    setPublicUploadHeaders({ setHeader: (k, v) => { headers[k] = v; } });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toBe(UPLOADS_CSP);
    expect(UPLOADS_CSP).toMatch(/sandbox/);
    expect(UPLOADS_CSP).toMatch(/default-src 'none'/);
  });

  test('index.js monta el guard ANTES del estático y con setHeaders', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(src).toMatch(/app\.use\('\/uploads',\s*uploadsGuard,\s*express\.static\(UPLOAD_DIR,\s*\{[^}]*setHeaders:\s*setPublicUploadHeaders/);
    expect(src).not.toMatch(/app\.use\('\/uploads',\s*express\.static/);
  });

  test('los uploads de foto y justificativo ya no usan la extensión del cliente', () => {
    const me = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'me.js'), 'utf8');
    const perm = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'permissions.js'), 'utf8');
    expect(me).not.toMatch(/extname\(file\.originalname\)/);
    expect(perm).not.toMatch(/file\.originalname\.replace/);
    expect(me).toMatch(/finalizeUpload\(req\.file, \['jpg', 'png', 'webp'\]\)/);
    expect(perm).toMatch(/finalizeUpload\(req\.file, \['pdf', 'jpg', 'png', 'webp'\]\)/);
  });
});

describe('GET /api/permissions/:id/attachment — descarga autenticada', () => {
  const PERM_DIR = path.join(TMP, 'permissions');
  let rows;

  beforeAll(() => {
    fs.mkdirSync(PERM_DIR, { recursive: true });
    fs.writeFileSync(path.join(PERM_DIR, 'perm_1_aaaa.pdf'), PDF);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    rows = {
      10: { id: 10, employee_id: 100, department_id: 1, attachment_url: '/uploads/permissions/perm_1_aaaa.pdf', attachment_filename: 'certificado.pdf', attachment_mime: 'application/pdf' },
      11: { id: 11, employee_id: 100, department_id: 1, attachment_url: '/uploads/other/perm_1_aaaa.pdf', attachment_filename: 'x.pdf', attachment_mime: 'application/pdf' },
      12: { id: 12, employee_id: 100, department_id: 1, attachment_url: '/uploads/permissions/perm_1_aaaa.pdf', attachment_filename: 'x.html', attachment_mime: 'text/html' },
    };
    sequelize.query.mockImplementation(async (sql, opts = {}) => {
      const rp = opts.replacements || [];
      if (/FROM users WHERE id = \? LIMIT 1/.test(sql)) {
        const usersById = {
          7: { id: 7, role: 'employee', active: 1, employee_id: 100 },
          5: { id: 5, role: 'manager', active: 1, employee_id: null },
          1: { id: 1, role: 'hr', active: 1, employee_id: null },
        };
        const row = usersById[rp[0]];
        return [row ? [row] : []];
      }
      if (/FROM user_permissions/.test(sql)) return [[]];
      if (/FROM permissions p/.test(sql)) { const r = rows[rp[0]]; return [r ? [r] : []]; }
      return [[]];
    });
  });

  function handler() {
    const layer = permissionsRouter.stack.find((l) => l.route && l.route.path === '/:id/attachment' && l.route.methods.get);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function call(req) {
    return new Promise((resolve) => {
      const res = new PassThrough();
      res.statusCode = 200; res.headers = {}; res.body = undefined;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, data: Buffer.concat(chunks) }));
      res.status = (c) => { res.statusCode = c; return res; };
      res.setHeader = (k, v) => { res.headers[k] = v; };
      res.json = (b) => { res.body = b; res.end(); return res; };
      handler()(req, res);
    });
  }

  test('fuera de alcance → 404 (igual que inexistente)', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [2], branchIds: [1] });
    const a = await call({ user: { id: 5, role: 'manager' }, params: { id: '10' } });
    const b = await call({ user: { id: 5, role: 'manager' }, params: { id: '999' } });
    expect(a.res.statusCode).toBe(404);
    expect(b.res.statusCode).toBe(404);
    expect(a.res.body).toEqual(b.res.body);
  });

  test('dueño: descarga como attachment con tipo cerrado y nosniff', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: false, ids: [], branchIds: [] });
    const { res, data } = await call({ user: { id: 7, role: 'employee' }, params: { id: '10' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="certificado\.pdf"$/);
    expect(data.toString('latin1').startsWith('%PDF-')).toBe(true);
  });

  test('mime almacenado fuera de la lista → octet-stream', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    const { res } = await call({ user: { id: 1, role: 'hr' }, params: { id: '12' } });
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
  });

  test('attachment_url fuera del directorio de justificativos → 404', async () => {
    departmentScope.getVisibleDepartmentIds.mockResolvedValue({ unrestricted: true });
    const { res } = await call({ user: { id: 1, role: 'hr' }, params: { id: '11' } });
    expect(res.statusCode).toBe(404);
  });
});
