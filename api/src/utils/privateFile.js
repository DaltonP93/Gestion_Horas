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

const UPLOADS_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const SAFE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
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
 * @param {object} res
 * @param {string} fullPath
 * @param {{mime?:string, downloadName?:string, inline?:boolean}} opts
 */
function sendPrivateFile(res, fullPath, { mime, downloadName, inline = false } = {}) {
  if (!fullPath || !fs.existsSync(fullPath)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  const guessed = MIME_BY_EXT[path.extname(fullPath).toLowerCase()];
  const type = SAFE_MIMES.has(mime) ? mime : (guessed || 'application/octet-stream');
  const name = String(downloadName || path.basename(fullPath)).replace(/[^\w.\- ]/g, '_').slice(-120);
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', UPLOADS_CSP);
  const disposition = inline && type.startsWith('image/') ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);
  return fs.createReadStream(fullPath).pipe(res);
}

module.exports = { resolvePrivatePath, sendPrivateFile, uploadDir, SAFE_MIMES };
