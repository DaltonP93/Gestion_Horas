'use strict';

/**
 * uploadsGuard.js — el estático público `/uploads` sirve SÓLO una lista
 * positiva: los recursos de marca configurados HOY en los ajustes públicos
 * (logo, favicon, icono PWA, fondo de login). Todo lo demás —fotos
 * personales, firmas/sellos, selfies, documentos, justificativos, carpetas
 * nuevas o desconocidas— responde 404 y se sirve únicamente por endpoints
 * autenticados con control de alcance (utils/privateFile).
 *
 * - La lista se lee de `notification_settings` (claves PUBLIC_ASSET_KEYS) y se
 *   cachea brevemente; `invalidatePublicAssets()` la refresca al cambiar la
 *   configuración. Si la lectura falla → no se sirve nada (fail-closed).
 * - Sólo archivos en la raíz de uploads (un segmento), con extensión de imagen.
 * - Lo servido lleva nosniff, CSP sandbox y caché pública acotada.
 */

const path = require('path');

const PUBLIC_ASSET_KEYS = ['system_logo_url', 'system_favicon_url', 'system_pwa_icon_url', 'system_login_bg_image'];
const PUBLIC_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.svg']);
const UPLOADS_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const CACHE_TTL_MS = 30_000;

let cache = { at: 0, names: null };

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

/** Nombre de archivo público a partir de un valor de ajuste, o null. */
function publicNameFromSetting(value) {
  if (typeof value !== 'string') return null;
  const m = /^\/uploads\/([^/\\?#]+)$/.exec(value.trim());
  if (!m) return null;
  const name = m[1];
  if (name.startsWith('.') || !PUBLIC_EXTENSIONS.has(path.posix.extname(name).toLowerCase())) return null;
  return name;
}

async function loadPublicNames() {
  const now = Date.now();
  if (cache.names && now - cache.at < CACHE_TTL_MS) return cache.names;
  // require diferido: permite mockear la base en tests.
  const { sequelize } = require('../config/database');
  const [rows] = await sequelize.query(
    `SELECT setting_key, setting_value FROM notification_settings
      WHERE setting_key IN (${PUBLIC_ASSET_KEYS.map(() => '?').join(',')})`,
    { replacements: PUBLIC_ASSET_KEYS },
  );
  const names = new Set();
  for (const r of rows || []) {
    const n = publicNameFromSetting(r.setting_value);
    if (n) names.add(n);
  }
  cache = { at: now, names };
  return names;
}

function invalidatePublicAssets() {
  cache = { at: 0, names: null };
}

/** ¿La ruta pedida es un recurso público configurado? */
async function isPublicUploadPath(reqPath) {
  const rel = normalizedRelPath(reqPath);
  if (!rel || rel.includes('/')) return false;
  if (!PUBLIC_EXTENSIONS.has(path.posix.extname(rel).toLowerCase())) return false;
  try {
    return (await loadPublicNames()).has(rel);
  } catch {
    return false; // fail-closed
  }
}

async function uploadsGuard(req, res, next) {
  if (!(await isPublicUploadPath(req.path))) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'No encontrado' });
  }
  return next();
}

function setPublicUploadHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', UPLOADS_CSP);
  res.setHeader('Cache-Control', 'public, max-age=3600');
}

module.exports = {
  uploadsGuard,
  setPublicUploadHeaders,
  isPublicUploadPath,
  invalidatePublicAssets,
  publicNameFromSetting,
  PUBLIC_ASSET_KEYS,
  PUBLIC_EXTENSIONS,
  UPLOADS_CSP,
};
