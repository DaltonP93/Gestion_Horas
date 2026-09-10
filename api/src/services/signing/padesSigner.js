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
 *   - SIGNING_MODE ausente/desconocido  → 'simple'.
 *   - SIGNING_MODE=pades_local pero falta alguna URL   → 'simple' (nota).
 *   - SIGNING_MODE=pades_local pero falta algún secreto → 'simple' (nota):
 *     los servicios responden 401 sin el header, así que sin secreto la firma
 *     no es posible; se degrada ANTES de intentar la red.
 *   - Cualquier fallo de red/timeout/formato → cae a 'simple' con una nota.
 *     El estado 'approved' del período ya está persistido; esto NO rompe la
 *     aprobación. Nunca se afirma "firmado" si no se firmó de verdad.
 *
 * ── PRIVACIDAD ─────────────────────────────────────────────────────────
 *   No se loguean URLs, secretos ni PII. Sólo se guarda una etiqueta de
 *   proveedor NO-PII y un timestamp. El header de secreto nunca se registra.
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../../config/logger');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BYTES = 25 * 1024 * 1024;

/** Modos válidos. Cualquier otro valor colapsa a 'simple' (fail-closed). */
const SIGNING_MODES = Object.freeze({ SIMPLE: 'simple', PADES_LOCAL: 'pades_local' });

/** Razones NO-PII por las que el modo efectivo puede degradar a 'simple'. */
const DEGRADE_REASONS = Object.freeze({
  NOT_PADES: 'MODE_SIMPLE',                 // configurado explícitamente en simple
  MISSING_URLS: 'PADES_URLS_MISSING',       // pades_local pero faltan URLs
  MISSING_SECRETS: 'PADES_SECRETS_MISSING', // pades_local pero faltan secretos
  HTML2PDF_FAILED: 'HTML2PDF_FAILED',       // html2pdf no respondió/erró
  SIGN_FAILED: 'PADES_SIGN_FAILED',         // pades-signer no respondió/erró
  EMPTY_RESULT: 'PADES_EMPTY_RESULT',       // respuesta sin PDF utilizable
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
    if (buf.length && buf.slice(0, 4).toString() === '%PDF') return { pdf: buf, info: null };
    return { pdf: null, info: null };
  }

  // JSON plano (objeto ya parseado por axios) — sólo tolerancia.
  if (data && typeof data === 'object') {
    return { pdf: base64FromObject(data, base64Fields), info: null };
  }

  return { pdf: null, info: null };
}

function base64FromObject(obj, fields) {
  for (const f of fields) {
    if (obj && typeof obj[f] === 'string' && obj[f].length) {
      const buf = Buffer.from(obj[f], 'base64');
      if (buf.length && buf.slice(0, 4).toString() === '%PDF') return buf;
      if (buf.length) return buf; // confiar en el servicio si no expone %PDF
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

  logger.info('Reporte mensual firmado con firma local', {
    signing_mode: SIGNING_MODES.PADES_LOCAL,
    signature_provider: providerLabel(),
  });
  return {
    pdf: signed.signedPdf,
    mode: SIGNING_MODES.PADES_LOCAL,
    provider: providerLabel(),
    signatureInfo: signed.signatureInfo || null,
    note: null,
  };
}

module.exports = {
  SIGNING_MODES,
  DEGRADE_REASONS,
  DEFAULTS,
  resolveSigningConfig,
  isPadesActive,
  providerLabel,
  renderHtmlToPdf,
  signPdf,
  signReportDocument,
};
