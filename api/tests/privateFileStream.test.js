/**
 * privateFileStream.test.js — sendPrivateFile ante errores de E/S (HTTP real).
 *
 *   - archivo que desaparece entre la comprobación y la apertura → 404
 *     no-store controlado;
 *   - ruta que no es un archivo regular → 404;
 *   - error de lectura ANTES del primer byte → 500 JSON controlado;
 *   - error de lectura DURANTE la transferencia → conexión cortada (sin
 *     respuesta "completa" truncada) y descriptor cerrado;
 *   - cliente que cancela → stream destruido y descriptor cerrado;
 * en todos los casos sin excepciones globales ni solicitudes colgadas, y
 * manteniendo las cabeceras privadas en el caso feliz.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sishoras-stream-'));
const express = require('express');
const { sendPrivateFile } = require('../src/utils/privateFile');

const uncaught = [];
const onUncaught = (e) => uncaught.push(e);
let server; let port;
let target; // ruta que sirve el handler de prueba
let beforeSend = null; // hook: se ejecuta entre la "comprobación" y el envío
let handlerDone;

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  const app = express();
  app.get('/f', async (req, res) => {
    // Simula la ruta real: comprobación previa y luego envío.
    const exists = fs.existsSync(target);
    if (beforeSend) await beforeSend();
    if (!exists) return res.status(404).end();
    await sendPrivateFile(res, target, { inline: true });
    handlerDone();
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  uncaught.length = 0;
  beforeSend = null;
  jest.restoreAllMocks();
});

/** GET con timeout; resuelve {status, headers, body, aborted} o {error}. */
function get({ abortAfterFirstChunk = false, timeoutMs = 3000 } = {}) {
  const done = new Promise((r) => { handlerDone = r; });
  const reqP = new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/f' }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (abortAfterFirstChunk) { req.destroy(); resolve({ status: res.statusCode, aborted: true }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
      res.on('aborted', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: false }));
      res.on('error', (error) => resolve({ status: res.statusCode, error, complete: false }));
    });
    req.on('error', (error) => resolve({ error }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ timeout: true }); });
  });
  return { reqP, done };
}

/** Espía fs.promises.open para capturar el FileHandle y su stream. */
function captureHandle({ streamFactory } = {}) {
  const real = fs.promises.open.bind(fs.promises);
  const captured = {};
  jest.spyOn(fs.promises, 'open').mockImplementation(async (...a) => {
    const fh = await real(...a);
    captured.fh = fh;
    if (streamFactory) {
      fh.createReadStream = () => { captured.stream = streamFactory(fh); return captured.stream; };
    } else {
      const orig = fh.createReadStream.bind(fh);
      fh.createReadStream = (o) => { captured.stream = orig(o); return captured.stream; };
    }
    return fh;
  });
  return captured;
}
const fdClosed = (fh) => fh.fd === -1;
const waitClose = (s) => new Promise((r) => (s.closed ? r() : s.once('close', r)));

test('caso feliz: 200 con cuerpo completo y cabeceras privadas', async () => {
  target = path.join(TMP, 'ok.png');
  fs.writeFileSync(target, Buffer.alloc(1000, 7));
  const cap = captureHandle();
  const { reqP, done } = get();
  const r = await reqP;
  await done;
  expect(r.status).toBe(200);
  expect(r.body.length).toBe(1000);
  expect(r.headers['content-length']).toBe('1000');
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
  await waitClose(cap.stream);
  expect(fdClosed(cap.fh)).toBe(true);
  expect(uncaught).toHaveLength(0);
});

test('el archivo desaparece entre la comprobación y la apertura → 404 controlado', async () => {
  target = path.join(TMP, 'gone.png');
  fs.writeFileSync(target, Buffer.alloc(10));
  beforeSend = async () => fs.unlinkSync(target);
  const { reqP, done } = get();
  const r = await reqP;
  await done;
  expect(r.status).toBe(404);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(r.body.toString())).toEqual({ error: 'Archivo no encontrado' });
  expect(uncaught).toHaveLength(0);
});

test('ruta que es un directorio → 404 y descriptor cerrado', async () => {
  target = path.join(TMP, 'dir.png');
  fs.mkdirSync(target);
  const cap = captureHandle();
  const { reqP, done } = get();
  const r = await reqP;
  await done;
  expect(r.status).toBe(404);
  expect(fdClosed(cap.fh)).toBe(true);
  expect(uncaught).toHaveLength(0);
});

test('error de lectura antes del primer byte → 500 JSON, sin cabeceras de archivo', async () => {
  target = path.join(TMP, 'eio.png');
  fs.writeFileSync(target, Buffer.alloc(100));
  const cap = captureHandle({
    streamFactory: (fh) => {
      const s = new Readable({ read() { this.destroy(Object.assign(new Error('EIO'), { code: 'EIO' })); } });
      s.on('close', () => fh.close().catch(() => {}));
      return s;
    },
  });
  const { reqP, done } = get();
  const r = await reqP;
  await done;
  expect(r.status).toBe(500);
  expect(r.headers['content-disposition']).toBeUndefined();
  expect(r.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(r.body.toString())).toEqual({ error: 'No se pudo leer el archivo' });
  await waitClose(cap.stream);
  expect(fdClosed(cap.fh)).toBe(true);
  expect(uncaught).toHaveLength(0);
});

test('error de lectura durante la transferencia → conexión cortada, respuesta incompleta', async () => {
  target = path.join(TMP, 'mid.png');
  fs.writeFileSync(target, Buffer.alloc(100000));
  let sent = false;
  const cap = captureHandle({
    streamFactory: (fh) => {
      const s = new Readable({
        read() {
          if (!sent) { sent = true; this.push(Buffer.alloc(1024, 1)); return; }
          setTimeout(() => this.destroy(Object.assign(new Error('EIO'), { code: 'EIO' })), 20);
        },
      });
      s.on('close', () => fh.close().catch(() => {}));
      return s;
    },
  });
  const { reqP, done } = get();
  const r = await reqP;
  await done;
  expect(r.status).toBe(200);            // las cabeceras ya habían salido
  expect(r.complete).toBe(false);        // pero la respuesta NO terminó bien
  expect(r.timeout).toBeUndefined();
  await waitClose(cap.stream);
  expect(fdClosed(cap.fh)).toBe(true);
  expect(uncaught).toHaveLength(0);
});

test('el cliente cancela a mitad de la descarga → stream destruido y descriptor cerrado', async () => {
  target = path.join(TMP, 'big.png');
  fs.writeFileSync(target, Buffer.alloc(8 * 1024 * 1024, 3));
  const cap = captureHandle();
  const { reqP, done } = get({ abortAfterFirstChunk: true });
  const r = await reqP;
  expect(r.aborted).toBe(true);
  await done; // el handler termina (no queda colgado)
  await waitClose(cap.stream);
  expect(cap.stream.destroyed).toBe(true);
  expect(fdClosed(cap.fh)).toBe(true);
  expect(uncaught).toHaveLength(0);
});

test('archivo vacío → 200 con Content-Length 0 y descriptor cerrado', async () => {
  target = path.join(TMP, 'empty.png');
  fs.writeFileSync(target, Buffer.alloc(0));
  const cap = captureHandle();
  const { reqP, done } = get();
  const r = await reqP;
  await done;
  expect(r.status).toBe(200);
  expect(r.headers['content-length']).toBe('0');
  expect(r.body.length).toBe(0);
  await waitClose(cap.stream);
  expect(fdClosed(cap.fh)).toBe(true);
  expect(uncaught).toHaveLength(0);
});
