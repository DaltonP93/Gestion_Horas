'use strict';

/**
 * uploadsGuard.js — qué puede servir el estático público `/uploads`.
 *
 * `/uploads` queda sólo para recursos de marca (logos, favicons, fondos,
 * firma/sello) y avatares. Todo lo demás se sirve únicamente por endpoints
 * autenticados con control de alcance:
 *   - subdirectorios privados (`permissions/`, `selfies/`,
 *     `employee-documents/`) → 404;
 *   - cualquier extensión que no sea imagen → 404.
 *
 * Además, toda respuesta servida lleva `X-Content-Type-Options: nosniff` y una
 * CSP `sandbox` restrictiva: aun si un archivo llegara a navegarse
 * directamente, no puede ejecutar scripts ni acceder al origen de la app. No
 * afecta a las imágenes usadas en `<img>`.
 */

const path = require('path');

const PRIVATE_PREFIXES = ['permissions', 'selfies', 'employee-documents'];
const PUBLIC_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg']);
const UPLOADS_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

function normalizedRelPath(reqPath) {
  let p;
  try {
    p = decodeURIComponent(String(reqPath || ''));
  } catch {
    return null; // codificación inválida → no se sirve
  }
  if (p.includes('\0')) return null;
  const unified = p.replace(/\\/g, '/');
  // Cualquier segmento '..' se rechaza (fail-closed), aunque normalizado no
  // escape de la raíz.
  if (unified.split('/').some((seg) => seg === '..')) return null;
  const norm = path.posix.normalize(unified).replace(/^\/+/, '');
  if (norm === '..' || norm.startsWith('../')) return null;
  return norm;
}

function isPublicUploadPath(reqPath) {
  const rel = normalizedRelPath(reqPath);
  if (!rel) return false;
  const first = rel.split('/')[0].toLowerCase();
  if (PRIVATE_PREFIXES.includes(first)) return false;
  return PUBLIC_EXTENSIONS.has(path.posix.extname(rel).toLowerCase());
}

function uploadsGuard(req, res, next) {
  if (!isPublicUploadPath(req.path)) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  return next();
}

function setPublicUploadHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', UPLOADS_CSP);
}

module.exports = {
  uploadsGuard,
  setPublicUploadHeaders,
  isPublicUploadPath,
  PRIVATE_PREFIXES,
  PUBLIC_EXTENSIONS,
  UPLOADS_CSP,
};
