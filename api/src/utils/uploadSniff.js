'use strict';

/**
 * uploadSniff.js — el tipo de un archivo subido se decide por su CONTENIDO
 * (magic bytes), nunca por el nombre ni por el Content-Type que declara el
 * cliente.
 *
 * `finalizeUpload(file, allowed)` se llama después de que multer guardó el
 * archivo con un nombre neutro (sin extensión del cliente):
 *   - lee la cabecera del archivo y detecta el tipo real;
 *   - valida el CONTENIDO completo (validateContent): las imágenes se
 *     decodifican enteras con sharp (una firma inicial válida no basta) con
 *     límites de dimensiones; los PDF deben tener cabecera y terminador; los
 *     DOCX/XLSX se validan como paquete completo (utils/ooxml: lectura ZIP
 *     con límites y CRC, XML bien formado, estructura OPC y sin macros);
 *   - si algo falla, borra el archivo nuevo y lanza un error 400;
 *   - si está permitido, lo renombra con la extensión canónica del tipo real
 *     y devuelve { filename, path, mime, ext, width?, height? }.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { validateOoxmlPackage, OoxmlError } = require('./ooxml');

// Límites razonables para fotos/justificativos (una foto de celular moderna
// ronda 12–50 MP; se admite hasta 50 MP y 12.000 px por lado).
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_SIDE = 12_000;
const SHARP_FORMAT = { jpg: 'jpeg', png: 'png', webp: 'webp' };

const TYPES = {
  jpg:  { mime: 'image/jpeg',      test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png:  { mime: 'image/png',       test: (b) => b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: 'image/webp',      test: (b) => b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  pdf:  { mime: 'application/pdf', test: (b) => b.length >= 5 && b.slice(0, 5).toString('latin1') === '%PDF-' },
  // Contenedor ZIP: el tipo concreto (docx/xlsx) lo decide utils/ooxml validando
  // el paquete completo (ZIP, XML y estructura OPC), no la cabecera.
  zip:  { mime: null,              test: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
};
const OOXML = {
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};
// Tope de lectura en memoria para validar paquetes OOXML (el límite de carga
// de documentos es 10 MB; esto es un resguardo adicional).
const OOXML_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Devuelve la extensión canónica del tipo detectado, o null. */
function sniffType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  for (const [ext, t] of Object.entries(TYPES)) {
    if (t.test(buf)) return ext;
  }
  return null;
}

function mimeFor(ext) {
  if (OOXML[ext]) return OOXML[ext].mime;
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
 * Valida el contenido completo según el tipo detectado. Lanza 400 si no es
 * válido. Imágenes: metadata coherente + límites + decodificación completa
 * (failOn 'warning': truncadas/corruptas fallan). PDF: '%PDF-' y '%%EOF' al
 * final.
 */
async function validateContent(filePath, ext) {
  if (SHARP_FORMAT[ext]) {
    let meta;
    try {
      meta = await sharp(filePath, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    } catch {
      throw uploadError('Imagen inválida');
    }
    if (meta.format !== SHARP_FORMAT[ext]) throw uploadError('Imagen inválida');
    if (!meta.width || !meta.height || meta.width > MAX_IMAGE_SIDE || meta.height > MAX_IMAGE_SIDE) {
      throw uploadError('Dimensiones de imagen fuera de rango');
    }
    try {
      // Decodificación completa (no sólo la cabecera): una imagen truncada o
      // corrupta falla acá.
      await sharp(filePath, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS }).stats();
    } catch {
      throw uploadError('Imagen inválida');
    }
    return { width: meta.width, height: meta.height };
  }
  if (ext === 'pdf') {
    const stat = await fs.promises.stat(filePath);
    if (stat.size < 64) throw uploadError('PDF inválido');
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const n = Math.min(2048, stat.size);
      const tail = Buffer.alloc(n);
      await fh.read(tail, 0, n, stat.size - n);
      if (!tail.toString('latin1').includes('%%EOF')) throw uploadError('PDF inválido');
    } finally {
      await fh.close();
    }
    return {};
  }
  throw uploadError('Tipo de archivo no permitido');
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
  let info;
  if (ext === 'zip' && allowed.some((a) => OOXML[a])) {
    // DOCX/XLSX: se valida el paquete real (ZIP + XML + OPC, utils/ooxml) y el
    // tipo sale del tipo de contenido de la parte principal.
    try {
      const stat = await fs.promises.stat(file.path);
      if (stat.size > OOXML_MAX_FILE_BYTES) throw uploadError('Documento demasiado grande');
      ext = validateOoxmlPackage(await fs.promises.readFile(file.path));
    } catch (e) {
      if (e instanceof OoxmlError) e = uploadError(e.message);
      await fs.promises.unlink(file.path).catch(() => {});
      throw e.status === 400 ? e : uploadError('Archivo inválido');
    }
    info = {};
  }
  if (!ext || !allowed.includes(ext)) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw uploadError('Tipo de archivo no permitido');
  }
  try {
    if (!OOXML[ext]) info = await validateContent(file.path, ext);
  } catch (e) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw e.status === 400 ? e : uploadError('Archivo inválido');
  }
  const base = path.basename(file.filename, path.extname(file.filename));
  const filename = `${base}.${ext}`;
  const dest = path.join(path.dirname(file.path), filename);
  try {
    await fs.promises.rename(file.path, dest);
  } catch (e) {
    await fs.promises.unlink(file.path).catch(() => {});
    throw e;
  }
  return { filename, path: dest, mime: mimeFor(ext), ext, ...info };
}

module.exports = {
  sniffType, mimeFor, finalizeUpload, validateContent, TYPES, OOXML, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE,
};
