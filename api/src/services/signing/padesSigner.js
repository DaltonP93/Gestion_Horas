/**
 * padesSigner.js
 *
 * FASE 2 — Adaptador de firma LOCAL/PROPIA del reporte mensual aprobado.
 *
 * El dueño corre por Docker Compose DOS servicios propios (Node.js):
 *   - html2pdf      → renderiza HTML → PDF (Playwright/Chromium).
 *   - pades-signer  → firma el PDF con un certificado .p12 (node-signpdf,
 *                     PKCS#7 embebido dentro del PDF).
 *
 * Este módulo es un ADAPTADOR config-driven: NO hardcodea URLs ni secretos
 * (todo por variables de entorno) y expone una interfaz limpia e
 * intercambiable para que mañana el proveedor pueda cambiarse tocando sólo
 * este archivo.
 *
 * ── CONTRATO HTTP REAL (confirmado contra los server.js del dueño) ─────
 *
 *   html2pdf:
 *     REQUEST : POST {HTML2PDF_URL}{HTML2PDF_PATH}      (path por defecto /pdf)
 *               Header  {HTML2PDF_AUTH_HEADER}: {HTML2PDF_SHARED_SECRET}
 *                       (por defecto  x-render-key: <secreto>)
 *               Content-Type: application/json
 *               body = { "<HTML2PDF_HTML_FIELD>": "<html>",
 *                        "options": { format, printBackground, margin } }
 *     RESPONSE: PDF binario (Content-Type application/pdf).
 *     AUTH    : sin el header correcto el servicio responde 401.
 *
 *   pades-signer:
 *     REQUEST : POST {PADES_SIGNER_URL}{PADES_SIGNER_PATH} (path por defecto /sign)
 *               Header  {PADES_SIGNER_AUTH_HEADER}: {PADES_SIGNER_SHARED_SECRET}
 *                       (por defecto  x-sign-key: <secreto>)
 *               Content-Type: multipart/form-data
 *               campo file = <PDF>  ({PADES_FILE_FIELD}, por defecto "file")
 *               campo reason = "<motivo NO-PII>"
 *     RESPONSE: PDF firmado binario (Content-Type application/pdf).
 *     AUTH    : sin el header correcto el servicio responde 401.
 *     CERT    : el certificado .p12 y su passphrase viven DENTRO del servicio
 *               pades-signer (montados como volumen/secreto). El backend NO los
 *               conoce ni los toca.
 *
 * ── VARIABLES DE ENTORNO (documentadas, NUNCA valores en el código) ─────
 *   SIGNING_MODE               'simple' (default, fail-closed) | 'pades_local'.
 *   HTML2PDF_URL               Base del servicio html2pdf (p.ej. http://html2pdf:3000).
 *   HTML2PDF_PATH              Ruta del endpoint (default '/pdf'). '' si la URL ya la incluye.
 *   HTML2PDF_SHARED_SECRET     Secreto que html2pdf exige (header de auth).
 *   HTML2PDF_AUTH_HEADER       Nombre del header de auth (default 'x-render-key').
 *   HTML2PDF_HTML_FIELD        Campo JSON del HTML (default 'html').
 *   PADES_SIGNER_URL           Base del servicio pades-signer (p.ej. http://pades-signer:3000).
 *   PADES_SIGNER_PATH          Ruta del endpoint (default '/sign'). '' si la URL ya la incluye.
 *   PADES_SIGNER_SHARED_SECRET Secreto que pades-signer exige (header de auth).
 *   PADES_SIGNER_AUTH_HEADER   Nombre del header de auth (default 'x-sign-key').
 *   PADES_FILE_FIELD           Nombre del campo multipart del PDF (default 'file').
 *   SIGNING_TIMEOUT_MS         Timeout por request HTTP (default 15000).
 *   SIGNING_PROVIDER_NAME      Etiqueta NO-PII que se guarda como
 *                              signature_provider (default 'pades-local').
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────
 *   - SIGNING_MODE ausente/desconocido  → 'simple' (default).
 *   - SIGNING_MODE=pades_local pero falta alguna URL   → 'simple' (nota).
 *   - SIGNING_MODE=pades_local pero alguna URL NO es un destino LOCAL/PRIVADO
 *     permitido (loopback/rango privado/host de Docker/allowlist SIGNING_ALLOWED_HOSTS)
 *     → 'simple' (nota). Protección SSRF: nunca se contacta un host público.
 *   - SIGNING_MODE=pades_local pero falta algún secreto → 'simple' (nota):
 *     los servicios responden 401 sin el header, así que sin secreto la firma
 *     no es posible; se degrada ANTES de intentar la red.
 *   - Requests con `maxRedirects: 0`: un 3xx NO reenvía la request a otro host.
 *   - Respuesta que no es un PDF real ("%PDF-") → se descarta (no se confía en
 *     bytes arbitrarios ni en base64 que no sea PDF).
 *   - El PDF firmado se VERIFICA CRIPTOGRÁFICAMENTE (verifyPdfSignature): si no
 *     contiene una firma PKCS#7 válida sobre su contenido → 'simple' (nota). NO
 *     se declara 'pades_local' por el sólo hecho de recibir un %PDF.
 *   - Cualquier fallo de red/timeout/formato → cae a 'simple' con una nota.
 *     El estado 'approved' del período ya está persistido; esto NO rompe la
 *     aprobación. Nunca se afirma "firmado PAdES" si no se firmó/verificó de verdad.
 *
 * ── PRIVACIDAD ─────────────────────────────────────────────────────────
 *   No se loguean URLs, secretos ni PII. Sólo se guarda una etiqueta de
 *   proveedor NO-PII y un timestamp. El header de secreto nunca se registra.
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../../config/logger');
const { verifyPdfSignature } = require('./verifyPdfSignature');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BYTES = 25 * 1024 * 1024;
/** Cabecera de un PDF real. Sólo se acepta un documento que empiece con esto. */
const PDF_MAGIC = '%PDF-';

/** ¿El buffer es un PDF real (empieza con "%PDF-")? Estricto (no "%PDF" a secas). */
function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 5 && buf.subarray(0, 5).toString('latin1') === PDF_MAGIC;
}

/** Modos válidos. Cualquier otro valor colapsa a 'simple' (fail-closed). */
const SIGNING_MODES = Object.freeze({ SIMPLE: 'simple', PADES_LOCAL: 'pades_local' });

/** Razones NO-PII por las que el modo efectivo puede degradar a 'simple'. */
const DEGRADE_REASONS = Object.freeze({
  NOT_PADES: 'MODE_SIMPLE',                 // configurado explícitamente en simple
  MISSING_URLS: 'PADES_URLS_MISSING',       // pades_local pero faltan URLs
  URLS_NOT_LOCAL: 'PADES_URLS_NOT_LOCAL',   // pades_local pero una URL no es local/privada permitida
  MISSING_SECRETS: 'PADES_SECRETS_MISSING', // pades_local pero faltan secretos
  HTML2PDF_FAILED: 'HTML2PDF_FAILED',       // html2pdf no respondió/erró
  SIGN_FAILED: 'PADES_SIGN_FAILED',         // pades-signer no respondió/erró
  EMPTY_RESULT: 'PADES_EMPTY_RESULT',       // respuesta sin PDF utilizable
  UNVERIFIED: 'PADES_SIGNATURE_UNVERIFIED', // el PDF devuelto NO tiene una firma válida verificable
});

/** Defaults del contrato real de los servicios del dueño. */
const DEFAULTS = Object.freeze({
  HTML2PDF_PATH: '/pdf',
  HTML2PDF_AUTH_HEADER: 'x-render-key',
  HTML2PDF_HTML_FIELD: 'html',
  PADES_PATH: '/sign',
  PADES_AUTH_HEADER: 'x-sign-key',
  PADES_FILE_FIELD: 'file',
});

function timeoutMs() {
  const n = parseInt(process.env.SIGNING_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function providerLabel() {
  // Etiqueta NO-PII, acotada, apta para guardar en columna VARCHAR(64).
  return String(process.env.SIGNING_PROVIDER_NAME || 'pades-local').slice(0, 64);
}

function cleanBase(v) {
  const s = (v || '').trim();
  return s ? s.replace(/\/+$/, '') : '';
}

/** Une base + ruta. Ruta vacía => se usa la base tal cual (ya incluye el path). */
function joinUrl(base, path) {
  const b = cleanBase(base);
  const p = (path == null ? '' : String(path)).trim();
  if (!b) return '';
  if (!p) return b;
  return b + (p.startsWith('/') ? p : `/${p}`);
}

/** Lee una env con default; '' explícito se respeta (no cae al default). */
function envOr(name, dflt) {
  const v = process.env[name];
  return v == null ? dflt : v;
}

// ─── SSRF: sólo destinos LOCALES/PRIVADOS explícitamente permitidos ────────
/** ¿Es una IPv4 privada/loopback/link-local? (no enrutable en Internet). */
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  if (o[0] === 127) return true;                 // 127.0.0.0/8 loopback
  if (o[0] === 10) return true;                  // 10.0.0.0/8
  if (o[0] === 192 && o[1] === 168) return true; // 192.168.0.0/16
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
  // Se EXCLUYE a propósito 169.254.0.0/16 (link-local): contiene el endpoint de
  // metadata de la nube (169.254.169.254), objetivo clásico de SSRF; no es un
  // destino legítimo de firma. También se excluye 0.0.0.0/8.
  return false;
}
/** ¿Es una IPv6 privada/loopback (ULA/loopback)? Se excluye link-local fe80. */
function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === '::1') return true;                       // loopback
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;      // fc00::/7 ULA (docker/k8s)
  if (h.startsWith('::ffff:')) return isPrivateIPv4(h.slice('::ffff:'.length)); // IPv4-mapped
  return false;
}
/** Hosts permitidos EXPLÍCITAMENTE por ops (allowlist por env, coma-separada). */
function allowedHostsFromEnv(env = process.env) {
  return String(env.SIGNING_ALLOWED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
/**
 * [SSRF] Un target de firma sólo se acepta si apunta a un destino LOCAL/PRIVADO
 * explícitamente permitido: http(s) hacia loopback/rango privado, `localhost`,
 * un nombre de servicio de Docker de una sola etiqueta (sin punto), un sufijo
 * interno (.local/.internal/.svc/.cluster.local) o un host de la allowlist
 * `SIGNING_ALLOWED_HOSTS`. Cualquier host público (FQDN/IP enrutable) se rechaza.
 * Combinado con `maxRedirects:0`, evita que una URL mal configurada o un redirect
 * saquen la request del perímetro interno.
 */
function isLocalTarget(rawUrl, env = process.env) {
  let u;
  try { u = new URL(rawUrl); } catch (_e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let host = (u.hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6
  if (!host) return false;

  if (allowedHostsFromEnv(env).includes(host)) return true; // allowlist explícita

  // IP literal → debe ser privada/loopback/link-local.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIPv4(host);
  if (host.includes(':')) return isPrivateIPv6(host);

  // Hostname (no IP): loopback, single-label (servicio Docker) o sufijo interno.
  if (host === 'localhost' || host === 'localhost.localdomain') return true;
  if (!host.includes('.')) return true; // p.ej. "html2pdf", "pades-signer"
  if (/\.(local|internal|svc|cluster\.local)$/.test(host)) return true;
  return false; // FQDN público → rechazado
}

/**
 * Resuelve la configuración de firma de forma fail-closed.
 * Devuelve el modo pedido, el modo EFECTIVO (lo que realmente se puede hacer)
 * y, si degradó, la razón NO-PII.
 */
function resolveSigningConfig(env = process.env) {
  const requested = env.SIGNING_MODE === SIGNING_MODES.PADES_LOCAL
    ? SIGNING_MODES.PADES_LOCAL
    : SIGNING_MODES.SIMPLE;

  const simple = (degradedReason) => ({
    requestedMode: requested,
    effectiveMode: SIGNING_MODES.SIMPLE,
    degradedReason,
    html2pdfUrl: '',
    padesUrl: '',
  });

  if (requested !== SIGNING_MODES.PADES_LOCAL) {
    return simple(requested === SIGNING_MODES.SIMPLE ? null : DEGRADE_REASONS.NOT_PADES);
  }

  // Los paths salen del `env` recibido ('' explícito se respeta: la URL ya lo incluye).
  const html2pdfPath = env.HTML2PDF_PATH == null ? DEFAULTS.HTML2PDF_PATH : env.HTML2PDF_PATH;
  const padesPath = env.PADES_SIGNER_PATH == null ? DEFAULTS.PADES_PATH : env.PADES_SIGNER_PATH;
  const html2pdfUrl = joinUrl(env.HTML2PDF_URL, html2pdfPath);
  const padesUrl = joinUrl(env.PADES_SIGNER_URL, padesPath);

  // Fail-closed: pades_local SIN las dos URLs no puede firmar → 'simple'.
  if (!html2pdfUrl || !padesUrl) return simple(DEGRADE_REASONS.MISSING_URLS);

  // Fail-closed [SSRF]: ambas URLs deben apuntar a destinos LOCALES/PRIVADOS
  // permitidos. Una URL pública (o mal configurada) NO se contacta → 'simple'.
  if (!isLocalTarget(html2pdfUrl, env) || !isLocalTarget(padesUrl, env)) {
    return simple(DEGRADE_REASONS.URLS_NOT_LOCAL);
  }

  // Fail-closed: los servicios exigen su shared secret (401 sin él). Sin ambos
  // secretos no tiene sentido intentar la red → 'simple'.
  const html2pdfSecret = (env.HTML2PDF_SHARED_SECRET || '').trim();
  const padesSecret = (env.PADES_SIGNER_SHARED_SECRET || '').trim();
  if (!html2pdfSecret || !padesSecret) return simple(DEGRADE_REASONS.MISSING_SECRETS);

  return {
    requestedMode: SIGNING_MODES.PADES_LOCAL,
    effectiveMode: SIGNING_MODES.PADES_LOCAL,
    degradedReason: null,
    html2pdfUrl,
    padesUrl,
  };
}

/** ¿El modo efectivo es PAdES? (config presente y coherente). */
function isPadesActive(env = process.env) {
  return resolveSigningConfig(env).effectiveMode === SIGNING_MODES.PADES_LOCAL;
}

/** Extrae un buffer PDF de una respuesta axios (binario o, tolerante, JSON base64). */
function pdfFromResponse(resp, base64Fields) {
  const ctype = String(resp.headers?.['content-type'] || '').toLowerCase();
  const data = resp.data;

  // Binario directo (arraybuffer) — camino real de ambos servicios.
  if (data && (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Si vino como JSON pese al arraybuffer, intentar parsear (tolerancia).
    if (ctype.includes('application/json')) {
      try {
        const obj = JSON.parse(buf.toString('utf8'));
        return { pdf: base64FromObject(obj, base64Fields), info: null };
      } catch (_e) { /* no era JSON legible; se trata como binario abajo */ }
    }
    // Estricto: sólo un PDF real ("%PDF-"). Cualquier otra cosa → no es PDF.
    if (looksLikePdf(buf)) return { pdf: buf, info: null };
    return { pdf: null, info: null };
  }

  // JSON plano (objeto ya parseado por axios) — sólo tolerancia.
  if (data && typeof data === 'object') {
    return { pdf: base64FromObject(data, base64Fields), info: null };
  }

  return { pdf: null, info: null };
}

/**
 * Extrae un PDF de un campo base64 de un objeto JSON. RECHAZA cualquier
 * resultado que NO sea un PDF real: nunca "confía" en el servicio devolviendo
 * bytes arbitrarios (evita tratar como PDF una respuesta de error/redirect/HTML).
 */
function base64FromObject(obj, fields) {
  for (const f of fields) {
    if (obj && typeof obj[f] === 'string' && obj[f].length) {
      let buf;
      try { buf = Buffer.from(obj[f], 'base64'); } catch (_e) { continue; }
      if (looksLikePdf(buf)) return buf; // SÓLO si es un PDF real ("%PDF-")
    }
  }
  return null;
}

/**
 * html2pdf: HTML → PDF. Lanza si no se obtiene un PDF utilizable.
 * Contrato real: POST /pdf, header x-render-key, body { html, options },
 * respuesta PDF binario.
 */
async function renderHtmlToPdf(html, { url, timeout } = {}) {
  const target = url
    ? cleanBase(url)
    : joinUrl(process.env.HTML2PDF_URL, envOr('HTML2PDF_PATH', DEFAULTS.HTML2PDF_PATH));
  if (!target) throw new Error('HTML2PDF_URL no configurada');

  const htmlField = envOr('HTML2PDF_HTML_FIELD', DEFAULTS.HTML2PDF_HTML_FIELD);
  const authHeader = envOr('HTML2PDF_AUTH_HEADER', DEFAULTS.HTML2PDF_AUTH_HEADER);
  const secret = (process.env.HTML2PDF_SHARED_SECRET || '').trim();

  const headers = { 'Content-Type': 'application/json', Accept: 'application/pdf' };
  if (secret) headers[authHeader] = secret;

  const resp = await axios.post(
    target,
    {
      [htmlField]: String(html || ''),
      options: {
        format: 'A4',
        printBackground: true,
        margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
      },
    },
    {
      timeout: timeout || timeoutMs(),
      responseType: 'arraybuffer',
      headers,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      // [SSRF] sin redirects: un 3xx no debe reenviar la request a otro host.
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 300,
    }
  );

  const { pdf } = pdfFromResponse(resp, ['pdf_base64', 'pdf', 'data', 'result']);
  if (!pdf) throw new Error('html2pdf no devolvió un PDF utilizable');
  return pdf;
}

/**
 * INTERFAZ LIMPIA E INTERCAMBIABLE.
 * pades-signer: PDF → PDF firmado. Contrato real: POST /sign,
 * header x-sign-key, multipart/form-data campo `file` + `reason`,
 * respuesta PDF firmado binario.
 *
 * @param {Buffer} pdfBuffer  PDF a firmar.
 * @param {object} opts
 * @param {object} opts.meta  metadatos NO-PII para el servicio (reason, etc.).
 * @returns {Promise<{signedPdf: Buffer, signatureInfo: object|null}>}
 */
async function signPdf(pdfBuffer, { meta = {}, url, timeout } = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    throw new Error('signPdf requiere un Buffer PDF no vacío');
  }
  const target = url
    ? cleanBase(url)
    : joinUrl(process.env.PADES_SIGNER_URL, envOr('PADES_SIGNER_PATH', DEFAULTS.PADES_PATH));
  if (!target) throw new Error('PADES_SIGNER_URL no configurada');

  const fileField = envOr('PADES_FILE_FIELD', DEFAULTS.PADES_FILE_FIELD);
  const authHeader = envOr('PADES_SIGNER_AUTH_HEADER', DEFAULTS.PADES_AUTH_HEADER);
  const secret = (process.env.PADES_SIGNER_SHARED_SECRET || '').trim();

  const form = new FormData();
  form.append(fileField, pdfBuffer, {
    filename: 'reporte_mensual.pdf',
    contentType: 'application/pdf',
  });
  // Metadato NO-PII: motivo de la firma (el servicio lo lee de req.body.reason).
  form.append('reason', String(meta.reason || 'Reporte mensual de asistencia aprobado'));

  const headers = { ...form.getHeaders(), Accept: 'application/pdf' };
  if (secret) headers[authHeader] = secret;

  const resp = await axios.post(target, form, {
    timeout: timeout || timeoutMs(),
    responseType: 'arraybuffer',
    headers,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    // [SSRF] sin redirects: un 3xx no debe reenviar la request a otro host.
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const { pdf, info } = pdfFromResponse(resp, ['signed_pdf_base64', 'signed_pdf', 'pdf_base64', 'pdf', 'data']);
  if (!pdf) throw new Error('pades-signer no devolvió un PDF firmado utilizable');
  return { signedPdf: pdf, signatureInfo: info };
}

/**
 * Orquestación de alto nivel para el reporte mensual.
 *
 * - En 'simple' (o cuando pades no está activo) devuelve el PDF de fallback
 *   (el generador pdfkit existente) sin tocar la red.
 * - En 'pades_local' intenta: html2pdf(html) → signPdf → PDF firmado.
 *   Ante CUALQUIER fallo cae al PDF de fallback con una nota NO-PII. La
 *   aprobación ya está persistida; esto nunca la rompe.
 *
 * @param {object} args
 * @param {string} args.html          HTML del reporte (para html2pdf).
 * @param {() => (Buffer|Promise<Buffer>)} args.fallbackPdf  generador simple.
 * @param {object} args.meta          metadatos NO-PII (period, scope, reason).
 * @returns {Promise<{pdf: Buffer, mode: string, provider: string|null,
 *                    signatureInfo: object|null, note: string|null}>}
 */
async function signReportDocument({ html, fallbackPdf, meta = {} } = {}) {
  const cfg = resolveSigningConfig();

  const asBuffer = async () => {
    const b = await fallbackPdf();
    if (!Buffer.isBuffer(b)) throw new Error('fallbackPdf debe devolver un Buffer');
    return b;
  };

  const degrade = async (note) => ({
    pdf: await asBuffer(),
    mode: SIGNING_MODES.SIMPLE,
    provider: null,
    signatureInfo: null,
    note: note || null,
  });

  if (cfg.effectiveMode !== SIGNING_MODES.PADES_LOCAL) {
    // Fail-closed: no se firma. Se registra la razón (sin PII/URLs/secretos).
    if (cfg.degradedReason && cfg.degradedReason !== DEGRADE_REASONS.NOT_PADES) {
      logger.warn('Firma PAdES no disponible; se usa firma simple interna', {
        signing_reason: cfg.degradedReason,
        signing_mode: SIGNING_MODES.SIMPLE,
      });
    }
    return degrade(
      cfg.degradedReason && cfg.degradedReason !== DEGRADE_REASONS.NOT_PADES
        ? cfg.degradedReason
        : null
    );
  }

  // Modo PAdES activo: html2pdf → pades-signer.
  let rendered;
  try {
    rendered = await renderHtmlToPdf(html, { url: cfg.html2pdfUrl });
  } catch (err) {
    logger.error('html2pdf falló; se cae a firma simple interna', err, {
      signing_reason: DEGRADE_REASONS.HTML2PDF_FAILED,
    });
    return degrade(DEGRADE_REASONS.HTML2PDF_FAILED);
  }

  let signed;
  try {
    signed = await signPdf(rendered, { meta, url: cfg.padesUrl });
  } catch (err) {
    logger.error('pades-signer falló; se cae a firma simple interna', err, {
      signing_reason: DEGRADE_REASONS.SIGN_FAILED,
    });
    return degrade(DEGRADE_REASONS.SIGN_FAILED);
  }

  if (!signed.signedPdf || !signed.signedPdf.length) {
    logger.error('pades-signer devolvió un resultado vacío; firma simple interna', {
      signing_reason: DEGRADE_REASONS.EMPTY_RESULT,
    });
    return degrade(DEGRADE_REASONS.EMPTY_RESULT);
  }

  // [SEGURIDAD] NO declarar 'pades_local' por recibir un %PDF: verificar
  // CRIPTOGRÁFICAMENTE que el PDF devuelto contiene una firma PKCS#7 VÁLIDA
  // sobre su propio contenido. Si no puede verificarse (sin firma, digest o
  // firma que no cierran, CMS ilegible), se DEGRADA a 'simple' — nunca se afirma
  // PAdES sobre un documento sin firma real.
  const verification = verifyPdfSignature(signed.signedPdf);
  if (!verification.valid) {
    logger.error('El PDF de pades-signer NO tiene una firma válida verificable; firma simple interna', {
      signing_reason: DEGRADE_REASONS.UNVERIFIED,
      verify_reason: verification.reason,
    });
    return degrade(DEGRADE_REASONS.UNVERIFIED);
  }

  logger.info('Reporte mensual firmado con firma local (firma verificada criptográficamente)', {
    signing_mode: SIGNING_MODES.PADES_LOCAL,
    signature_provider: providerLabel(),
    digest_alg: verification.digestAlg,
  });
  return {
    pdf: signed.signedPdf,
    mode: SIGNING_MODES.PADES_LOCAL,
    provider: providerLabel(),
    signatureInfo: {
      verified: true,
      digestAlg: verification.digestAlg,
      signerSubjectCN: verification.signerSubjectCN,
    },
    note: null,
  };
}

module.exports = {
  SIGNING_MODES,
  DEGRADE_REASONS,
  DEFAULTS,
  resolveSigningConfig,
  isPadesActive,
  isLocalTarget,
  looksLikePdf,
  providerLabel,
  renderHtmlToPdf,
  signPdf,
  signReportDocument,
  // Reexportado para pruebas / uso directo.
  verifyPdfSignature,
};
