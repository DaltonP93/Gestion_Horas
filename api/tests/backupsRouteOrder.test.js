/**
 * Orden de resolución de las rutas de backups.
 *
 * Bug corregido: `GET /:filename` estaba registrada ANTES que
 * `GET /offsite-config`. Express resuelve por orden de registro, así que la
 * paramétrica se quedaba con la literal, el nombre no pasaba el regex y la
 * pantalla de configuración off-site recibía 400 «Nombre inválido».
 *
 * El test que importa no es el del caso puntual sino el último: ninguna ruta
 * literal puede quedar tapada por una paramétrica del mismo método.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-rutas-'));
process.env.BACKUP_DIR = DIR;

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn().mockResolvedValue([[]]) } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/backupUpload', () => ({
  getUploadConfig: jest.fn().mockResolvedValue({ provider: 'none', s3: {}, sftp: {} }),
  uploadBackup: jest.fn(),
}));

const router = require('../src/routes/backups');

/** Las capas de ruta del router, en orden de registro. */
function capas() {
  return router.stack
    .filter(l => l.route)
    .map(l => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
      esParametrica: l.route.path.includes(':'),
      handler: l.route.stack[l.route.stack.length - 1].handle,
    }));
}

/** Primera capa que Express usaría para (método, path) — misma regla de orden. */
function resuelve(method, url) {
  return capas().find(c => {
    if (!c.methods.includes(method)) return false;
    if (!c.esParametrica) return c.path === url;
    // `/:x` matchea cualquier segmento único
    const segmentos = url.split('/').filter(Boolean);
    return segmentos.length === c.path.split('/').filter(Boolean).length;
  });
}

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

afterAll(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ } });

describe('la ruta literal ya no cae en la paramétrica', () => {
  test('GET /offsite-config llega a su propio handler', () => {
    const c = resuelve('get', '/offsite-config');
    expect(c.path).toBe('/offsite-config');
    expect(c.esParametrica).toBe(false);
  });

  test('y responde su configuración, no un 400', async () => {
    const c = resuelve('get', '/offsite-config');
    const res = fakeRes();
    await c.handler({ params: {}, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.error).toBeUndefined();
  });
});

describe('lo que ya funcionaba sigue funcionando', () => {
  test('un nombre de backup válido resuelve a /:filename', () => {
    expect(resuelve('get', '/asistencia_20260804_020000.sql.gz').path).toBe('/:filename');
  });

  test('descarga un archivo existente', async () => {
    const nombre = 'asistencia_20260804_020000.sql.gz';
    fs.writeFileSync(path.join(DIR, nombre), 'contenido');
    const c = resuelve('get', `/${nombre}`);

    // El handler hace `createReadStream(fp).pipe(res)`. El destino tiene que
    // ser un Writable de verdad y hay que esperar su 'finish': con un objeto
    // falso, el ReadStream abre el archivo DESPUÉS de que termina el test y el
    // ENOENT del afterAll llega como 'error' sin listener → tumba el proceso.
    const leido = [];
    const res = Object.assign(new (require('stream').Writable)({
      write(chunk, _enc, cb) { leido.push(chunk); cb(); },
    }), { statusCode: 200, headers: {} });
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };

    const terminado = new Promise((ok, fail) => {
      res.on('finish', ok);
      res.on('error', fail);
    });
    await c.handler({ params: { filename: nombre } }, res);
    await terminado;

    expect(res.headers['Content-Type']).toBe('application/gzip');
    expect(res.headers['Content-Disposition']).toBe(`attachment; filename="${nombre}"`);
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(leido).toString()).toBe('contenido');
  });

  test('un nombre inválido sigue dando 400', async () => {
    const c = resuelve('get', '/cualquier-cosa');
    const res = fakeRes();
    await c.handler({ params: { filename: 'cualquier-cosa' } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Nombre inválido');
  });

  test('el path traversal sigue rechazado', async () => {
    for (const malo of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/etc/passwd', 'asistencia_../x.sql.gz']) {
      const res = fakeRes();
      const c = capas().find(l => l.path === '/:filename' && l.methods.includes('get'));
      await c.handler({ params: { filename: malo } }, res);

      expect(res.statusCode).toBe(400);
    }
  });

  test('un backup inexistente da 404, no 400', async () => {
    const c = resuelve('get', '/asistencia_19990101_000000.sql.gz');
    const res = fakeRes();
    await c.handler({ params: { filename: 'asistencia_19990101_000000.sql.gz' } }, res);

    expect(res.statusCode).toBe(404);
  });
});

describe('la regla, no el caso', () => {
  test('ninguna ruta literal queda tapada por una paramétrica del mismo método', () => {
    const todas = capas();
    const tapadas = [];

    todas.forEach((literal, i) => {
      if (literal.esParametrica) return;
      const segmentosLit = literal.path.split('/').filter(Boolean).length;
      if (segmentosLit === 0) return;                 // '/' no colisiona

      for (let j = 0; j < i; j++) {
        const previa = todas[j];
        if (!previa.esParametrica) continue;
        const segmentosPar = previa.path.split('/').filter(Boolean).length;
        const mismoMetodo = previa.methods.some(m => literal.methods.includes(m));
        if (mismoMetodo && segmentosPar === segmentosLit) {
          tapadas.push(`${literal.methods.join('/')} ${literal.path} tapada por ${previa.path}`);
        }
      }
    });

    expect(tapadas).toEqual([]);
  });

  test('todas las paramétricas están al final del archivo', () => {
    const todas = capas();
    const primeraParametrica = todas.findIndex(c => c.esParametrica);
    if (primeraParametrica === -1) return;

    const despues = todas.slice(primeraParametrica);
    expect(despues.every(c => c.esParametrica)).toBe(true);
  });

  test('el archivo declara la convención por escrito', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'backups.js'), 'utf8');
    expect(src).toContain('Rutas paramétricas — SIEMPRE al final');
  });
});
