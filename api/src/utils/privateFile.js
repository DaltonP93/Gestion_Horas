'use strict';

/**
 * privateFile.js — servir archivos privados (fotos personales, firmas,
 * selfies, documentos, justificativos) SÓLO desde handlers autenticados que ya
 * hicieron el control de capacidad y alcance.
 *
 *  - resolvePrivatePath: convierte una URL lógica `/uploads/...` guardada en la
 *    base en una ruta de disco dentro de UPLOAD_DIR (sin traversal) y,
 *    opcionalmente, restringida a un subdirectorio o a un patrón de nombre.
 *  - sendPrivateFile: responde con `Cache-Control: private, no-store`,
 *    nosniff, CSP sandbox y tipo de una lista cerrada.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const UPLOADS_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const SAFE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  // Documentos de oficina: siempre como descarga (Content-Disposition attachment).
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf',
};

function uploadDir() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
}

/**
 * @param {string} url     valor guardado, p. ej. '/uploads/avatar_1_ab.png'
 * @param {{subdir?:string|null, namePattern?:RegExp}} opts
 * @returns {string|null}  ruta absoluta segura o null
 */
function resolvePrivatePath(url, { subdir = null, namePattern = null } = {}) {
  if (typeof url !== 'string') return null;
  const m = /^\/uploads\/(.+)$/.exec(url.trim());
  if (!m) return null;
  const rel = m[1];
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) return null;
  const parts = rel.split('/');
  if (subdir === null ? parts.length !== 1 : (parts.length !== 2 || parts[0] !== subdir)) return null;
  const name = parts[parts.length - 1];
  if (namePattern && !namePattern.test(name)) return null;
  const base = uploadDir();
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * Envía el archivo con manejo completo de errores (sin depender del manejador
 * global de excepciones):
 *   - se ABRE antes de fijar cabeceras: si desapareció entre la comprobación
 *     y la apertura, o no es un archivo regular → 404 no-store;
 *   - error de lectura antes del primer byte → 500 controlado (JSON);
 *   - error o cancelación del cliente durante la transferencia → se corta la
 *     conexión y se cierra el descriptor (stream.pipeline).
 * Nunca rechaza: resuelve cuando la respuesta terminó o se abortó.
 *
 * @param {object} res
 * @param {string} fullPath
 * @param {{mime?:string, downloadName?:string, inline?:boolean}} opts
 * @returns {Promise<void>}
 */
async function sendPrivateFile(res, fullPath, { mime, downloadName, inline = false } = {}) {
  const notFound = () => {
    if (res.headersSent) return;
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'Archivo no encontrado' });
  };
  if (!fullPath) return notFound();

  let fh;
  let size;
  try {
    fh = await fs.promises.open(fullPath, 'r');
    const st = await fh.stat();
    if (!st.isFile()) throw Object.assign(new Error('no es un archivo'), { code: 'ENOTFILE' });
    size = st.size;
  } catch {
    if (fh) await fh.close().catch(() => {});
    return notFound();
  }

  const guessed = MIME_BY_EXT[path.extname(fullPath).toLowerCase()];
  const type = SAFE_MIMES.has(mime) ? mime : (guessed || 'application/octet-stream');
  const name = String(downloadName || path.basename(fullPath)).replace(/[^\w.\- ]/g, '_').slice(-120);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', UPLOADS_CSP);
  const disposition = inline && type.startsWith('image/') ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);

  // autoClose: el FileHandle se cierra al terminar o al destruirse el stream.
  const stream = fh.createReadStream();
  // Un error nunca queda sin listener (pipeline agrega el suyo después).
  stream.on('error', () => {});

  // Primer bloque ANTES de enviar cabeceras: si la lectura falla acá se
  // responde de forma controlada en vez de cortar la conexión.
  let first;
  try {
    first = await new Promise((resolve, reject) => {
      const done = (fn, v) => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onErr); fn(v); };
      const onData = (chunk) => { stream.pause(); done(resolve, chunk); };
      const onEnd = () => done(resolve, null);
      const onErr = (e) => done(reject, e);
      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onErr);
    });
  } catch {
    stream.destroy();
    if (!res.headersSent) {
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).json({ error: 'No se pudo leer el archivo' });
    }
    return undefined;
  }
  if (first === null) { res.end(); return undefined; }

  res.write(first);
  return new Promise((resolve) => {
    pipeline(stream, res, (err) => {
      // Con la transferencia ya empezada, pipeline destruye la respuesta: el
      // cliente ve una respuesta incompleta, nunca un archivo "completo"
      // truncado. La cancelación del cliente destruye el stream (cierra el fd).
      if (err && !res.destroyed) res.destroy();
      resolve();
    });
  });
}

module.exports = { resolvePrivatePath, sendPrivateFile, uploadDir, SAFE_MIMES };
