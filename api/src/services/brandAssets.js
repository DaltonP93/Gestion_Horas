'use strict';

/**
 * brandAssets.js — recursos públicos de marca (logo, favicon, ícono PWA,
 * fondo del login) administrados desde Configuración › Apariencia.
 *
 * Contrato:
 *  - Las cargas nuevas de marca se guardan en `uploads/brand/` con nombre
 *    neutro. Esa carpeta es PÚBLICA por diseño: sólo recibe recursos de marca
 *    (firma, sello, fotos, selfies, documentos y adjuntos nunca van ahí).
 *    nginx publica únicamente `/uploads/brand/<archivo-imagen>`; el resto de
 *    `/uploads/` queda bloqueado, también si se vuelve a un código anterior.
 *  - Los valores HEREDADOS (archivos de marca ya configurados en la raíz de
 *    uploads antes de este cambio) no se mueven: se publican por la ruta
 *    estable `/api/settings/brand/:kind`, que resuelve el ajuste vigente.
 *  - Un ajuste de marca sólo puede apuntar a `/uploads/brand/<archivo
 *    existente>`, quedar vacío, conservar su valor actual o ser una URL que no
 *    esté bajo `/uploads` (p. ej. un recurso estático de la web). Así nadie
 *    puede publicar un archivo privado cambiando la URL del logo a mano.
 */

const fs = require('fs');
const path = require('path');
const { uploadDir } = require('../utils/privateFile');

const BRAND_KINDS = Object.freeze({
  logo: 'system_logo_url',
  favicon: 'system_favicon_url',
  pwa_icon: 'system_pwa_icon_url',
  login_bg: 'system_login_bg_image',
});
const BRAND_KEYS = Object.freeze(Object.values(BRAND_KINDS));
const KIND_BY_KEY = Object.freeze(Object.fromEntries(Object.entries(BRAND_KINDS).map(([k, v]) => [v, k])));

const BRAND_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'svg'];
// Nombre de archivo de marca: un solo segmento, extensión de imagen en minúsculas.
const BRAND_NAME_RE = new RegExp(`^[A-Za-z0-9_-]+\\.(${BRAND_EXTENSIONS.join('|')})$`);
const BRAND_URL_RE = /^\/uploads\/brand\/([^/\\?#]+)$/;
const LEGACY_URL_RE = /^\/uploads\/([^/\\?#]+)$/;
const ROUTE_PREFIX = '/api/settings/brand/';

function brandDir() {
  return path.join(uploadDir(), 'brand');
}
function ensureBrandDir() {
  const d = brandDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Nombre del archivo en uploads/brand si `value` es una URL de marca válida. */
function brandFileName(value) {
  const m = typeof value === 'string' ? BRAND_URL_RE.exec(value.trim()) : null;
  return m && BRAND_NAME_RE.test(m[1]) ? m[1] : null;
}

/** Nombre del archivo en la raíz si `value` es un valor heredado de imagen. */
function legacyFileName(value) {
  const m = typeof value === 'string' ? LEGACY_URL_RE.exec(value.trim()) : null;
  return m && BRAND_NAME_RE.test(m[1].toLowerCase()) && !m[1].startsWith('.') ? m[1] : null;
}

/** URL que se anuncia al cliente para un ajuste de marca. */
function publicUrlFor(key, value) {
  const kind = KIND_BY_KEY[key];
  if (!kind || typeof value !== 'string') return value;
  const legacy = legacyFileName(value);
  if (!legacy) return value; // vacío, /uploads/brand/..., URL externa o de la web
  // Versión derivada del valor: al cambiar el archivo cambia la URL.
  const v = require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${ROUTE_PREFIX}${kind}?v=${v}`;
}

/** Aplica publicUrlFor a un objeto de ajustes (no muta el original). */
function presentSettings(settings) {
  const out = { ...settings };
  for (const key of BRAND_KEYS) if (key in out) out[key] = publicUrlFor(key, out[key]);
  return out;
}

/**
 * Decide qué hacer con un valor entrante para un ajuste de marca.
 * @returns {{action:'skip'}|{action:'write', value:string}|{action:'reject', error:string}}
 */
function checkIncomingValue(key, incoming, current) {
  const value = incoming == null ? '' : String(incoming).trim();
  const kind = KIND_BY_KEY[key];
  if (value === (current || '')) return { action: 'skip' };
  // La URL anunciada de un valor heredado vuelve tal cual: no es un cambio.
  if (value.startsWith(ROUTE_PREFIX)) {
    return value.split('?')[0] === `${ROUTE_PREFIX}${kind}` ? { action: 'skip' } : { action: 'reject', error: 'URL de marca inválida' };
  }
  if (value === '') return { action: 'write', value };
  if (/^\/+uploads(\/|$)/i.test(value) || /%2f|%5c|\\/i.test(value)) {
    const name = brandFileName(value);
    if (!name || !fs.existsSync(path.join(brandDir(), name))) {
      return { action: 'reject', error: 'Los recursos de marca deben subirse desde Apariencia' };
    }
    return { action: 'write', value: `/uploads/brand/${name}` };
  }
  return { action: 'write', value };
}

module.exports = {
  BRAND_KINDS, BRAND_KEYS, KIND_BY_KEY, BRAND_EXTENSIONS, BRAND_NAME_RE, ROUTE_PREFIX,
  brandDir, ensureBrandDir, brandFileName, legacyFileName, publicUrlFor, presentSettings, checkIncomingValue,
};
