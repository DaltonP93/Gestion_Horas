'use strict';

/**
 * uploadSniff.js — el tipo de un archivo subido se decide por su CONTENIDO
 * (magic bytes), nunca por el nombre ni por el Content-Type que declara el
 * cliente.
 *
 * `finalizeUpload(file, allowed)` se llama después de que multer guardó el
 * archivo con un nombre neutro (sin extensión del cliente):
 *   - lee la cabecera del archivo y detecta el tipo real;
 *   - si no está en `allowed`, borra el archivo y lanza un error 400;
 *   - si está permitido, lo renombra con la extensión canónica del tipo real
 *     y devuelve { filename, path, mime, ext }.
 */

const fs = require('fs');
const path = require('path');

const TYPES = {
  jpg:  { mime: 'image/jpeg',      test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png:  { mime: 'image/png',       test: (b) => b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: 'image/webp',      test: (b) => b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  pdf:  { mime: 'application/pdf', test: (b) => b.length >= 5 && b.slice(0, 5).toString('latin1') === '%PDF-' },
};

/** Devuelve la extensión canónica del tipo detectado, o null. */
function sniffType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  for (const [ext, t] of Object.entries(TYPES)) {
    if (t.test(buf)) return ext;
  }
  return null;
}

function mimeFor(ext) {
  return TYPES[ext] ? TYPES[ext].mime : null;
}

function uploadError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'UPLOAD_TYPE_NOT_ALLOWED';
  return err;
}

async function readHead(filePath, n = 16) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.slice(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * @param {{path:string, filename:string}} file  objeto de multer (diskStorage)
 * @param {string[]} allowed  extensiones canónicas permitidas (p. ej. ['jpg','png'])
 */
async function finalizeUpload(file, allowed) {
  if (!file || !file.path) throw uploadError('Archivo requerido');
  let ext = null;
  try {
    ext = sniffType(await readHead(file.path));
  } catch {
    ext = null;
  }
  if (!ext || !allowed.includes(ext)) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw uploadError('Tipo de archivo no permitido');
  }
  const base = path.basename(file.filename, path.extname(file.filename));
  const filename = `${base}.${ext}`;
  const dest = path.join(path.dirname(file.path), filename);
  await fs.promises.rename(file.path, dest);
  return { filename, path: dest, mime: mimeFor(ext), ext };
}

module.exports = { sniffType, mimeFor, finalizeUpload, TYPES };
