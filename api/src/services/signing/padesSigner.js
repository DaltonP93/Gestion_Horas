/**
 * padesSigner.js
 *
 * FASE 2 — Adaptador de firma PAdES LOCAL/PROPIA del reporte mensual aprobado.
 *
 * El dueño corre por Docker Compose DOS servicios propios:
 *   - html2pdf      → renderiza HTML → PDF.
 *   - pades-signer  → aplica una firma PAdES a un PDF.
 *
 * Este módulo es un ADAPTADOR config-driven: NO hardcodea URLs ni secretos
 * (todo por variables de entorno) y expone una interfaz limpia e
 * intercambiable para que mañana el proveedor pueda cambiarse tocando sólo
 * este archivo.
 *
 * ── VARIABLES DE ENTORNO (documentadas, NUNCA valores en el código) ─────
 *   SIGNING_MODE          'simple' (default, fail-closed) | 'pades_local'.
 *                         Sólo 'pades_local' habilita la firma PAdES.
 *   HTML2PDF_URL          URL del servicio html2pdf del compose.
 *   PADES_SIGNER_URL      URL del servicio pades-signer del compose.
 *   SIGNING_TIMEOUT_MS    Timeout por request HTTP (default 15000).
 *   SIGNING_PROVIDER_NAME Etiqueta NO-PII del proveedor que se guarda como
 *                         signature_provider (default 'pades-local').
 *   HTML2PDF_HTML_FIELD   Campo JSON del HTML en el request a html2pdf
 *                         (default 'html'). Ajuste de una línea si el
 *                         contrato real difiere.
 *   PADES_PDF_FIELD       Campo JSON del PDF (base64) en el request a
 *                         pades-signer (default 'pdf_base64').
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────
 *   - SIGNING_MODE ausente/desconocido  → 'simple'.
 *   - SIGNING_MODE=pades_local pero falta HTML2PDF_URL o PADES_SIGNER_URL
 *     → NO se firma PAdES: cae a 'simple' y lo registra. Nunca se afirma
 *       "firmado PAdES" si no se pudo firmar de verdad.
 *   - Cualquier fallo de red/timeout/formato de los servicios → cae a
 *     'simple' con una nota. El estado 'approved' del período ya está
 *     persistido; esto NO rompe la aprobación.
 *
 * ── CONTRATO HTTP ASUMIDO (marcarlo, es AJUSTABLE) ─────────────────────
 *   El contrato exacto de los servicios del dueño puede requerir un ajuste de
 *   una línea (nombres de campos por env, o el parseo de respuesta acá).
 *
 *   html2pdf:
 *     REQUEST : POST {HTML2PDF_URL}
 *               Content-Type: application/json
 *               body = { "<HTML2PDF_HTML_FIELD>": "<html>", "filename": "..." }
 *               Accept: application/pdf
 *     RESPONSE: binario PDF (Content-Type application/pdf u octet-stream)
 *               O JSON con el PDF en base64 en alguno de:
 *               pdf_base64 | pdf | data | result.
 *
 *   pades-signer:
 *     REQUEST : POST {PADES_SIGNER_URL}
 *               Content-Type: application/json
 *               body = { "<PADES_PDF_FIELD>": "<pdf-base64>",
 *                        "reason": "...", "name": "...", "location": "..." }
 *               Accept: application/pdf
 *     RESPONSE: binario PDF firmado (application/pdf u octet-stream)
 *               O JSON con el PDF firmado en base64 en alguno de:
 *               signed_pdf_base64 | signed_pdf | pdf_base64 | pdf | data,
 *               y opcionalmente info de firma en `signature` | `info`.
 *
 *   Nota: se usa base64-JSON (no multipart) para no depender de `form-data`.
 *   Si los servicios exigen multipart, es un cambio acotado a este archivo.
 *
 * ── PRIVACIDAD ─────────────────────────────────────────────────────────
 *   No se loguean URLs ni secretos ni PII. La info de firma que devuelve el
 *   servicio (que podría traer datos del certificado) NO se persiste: sólo se
 *   guarda una etiqueta de proveedor NO-PII y un timestamp.
 */

const axios = require('axios');
const logger = require('../../config/logger');

const DEFAULT_TIMEOUT_MS = 15000;

/** Modos válidos. Cualquier otro valor colapsa a 'simple' (fail-closed). */
const SIGNING_MODES = Object.freeze({ SIMPLE: 'simple', PADES_LOCAL: 'pades_local' });

/** Razones NO-PII por las que el modo efectivo puede degradar a 'simple'. */
const DEGRADE_REASONS = Object.freeze({
  NOT_PADES: 'MODE_SIMPLE',                 // configurado explícitamente en simple
  MISSING_URLS: 'PADES_URLS_MISSING',       // pades_local pero faltan URLs
  HTML2PDF_FAILED: 'HTML2PDF_FAILED',       // html2pdf no respondió/erró
  SIGN_FAILED: 'PADES_SIGN_FAILED',         // pades-signer no respondió/erró
  EMPTY_RESULT: 'PADES_EMPTY_RESULT',       // respuesta sin PDF utilizable
});

function timeoutMs() {
  const n = parseInt(process.env.SIGNING_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function providerLabel() {
  // Etiqueta NO-PII, acotada, apta para guardar en columna VARCHAR(64).
  return String(process.env.SIGNING_PROVIDER_NAME || 'pades-local').slice(0, 64);
}

function cleanUrl(v) {
  const s = (v || '').trim();
  return s ? s.replace(/\/+$/, '') : '';
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

  if (requested !== SIGNING_MODES.PADES_LOCAL) {
    return {
      requestedMode: requested,
      effectiveMode: SIGNING_MODES.SIMPLE,
      degradedReason: requested === SIGNING_MODES.SIMPLE ? null : DEGRADE_REASONS.NOT_PADES,
      html2pdfUrl: '',
      padesUrl: '',
    };
  }

  const html2pdfUrl = cleanUrl(env.HTML2PDF_URL);
  const padesUrl = cleanUrl(env.PADES_SIGNER_URL);

  // Fail-closed: pades_local SIN las dos URLs no puede firmar → 'simple'.
  if (!html2pdfUrl || !padesUrl) {
    return {
      requestedMode: SIGNING_MODES.PADES_LOCAL,
      effectiveMode: SIGNING_MODES.SIMPLE,
      degradedReason: DEGRADE_REASONS.MISSING_URLS,
      html2pdfUrl,
      padesUrl,
    };
  }

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

/** Extrae un buffer PDF de una respuesta axios (binario o JSON base64). */
function pdfFromResponse(resp, base64Fields) {
  const ctype = String(resp.headers?.['content-type'] || '').toLowerCase();
  const data = resp.data;

  // Binario directo (arraybuffer).
  if (data && (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Si vino como JSON pese al arraybuffer, intentar parsear.
    if (ctype.includes('application/json')) {
      try {
        const obj = JSON.parse(buf.toString('utf8'));
        return { pdf: base64FromObject(obj, base64Fields), info: signatureInfoFromObject(obj) };
      } catch (_e) { /* no era JSON legible; se trata como binario abajo */ }
    }
    if (buf.length && buf.slice(0, 4).toString() === '%PDF') return { pdf: buf, info: null };
    // Sin cabecera %PDF y sin JSON → dato inservible.
    return { pdf: null, info: null };
  }

  // JSON plano (objeto ya parseado por axios).
  if (data && typeof data === 'object') {
    return { pdf: base64FromObject(data, base64Fields), info: signatureInfoFromObject(data) };
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
 * Info de firma NO persistible tal cual (puede traer datos de certificado).
 * Se devuelve al llamador sólo para trazas acotadas; NO se guarda en tabla.
 */
function signatureInfoFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const src = obj.signature || obj.info || null;
  return src && typeof src === 'object' ? src : null;
}

/**
 * html2pdf: HTML → PDF. Lanza si no se obtiene un PDF utilizable.
 */
async function renderHtmlToPdf(html, { url, timeout } = {}) {
  const target = cleanUrl(url || process.env.HTML2PDF_URL);
  if (!target) throw new Error('HTML2PDF_URL no configurada');
  const htmlField = process.env.HTML2PDF_HTML_FIELD || 'html';

  const resp = await axios.post(
    target,
    { [htmlField]: String(html || ''), filename: 'reporte_mensual.pdf' },
    {
      timeout: timeout || timeoutMs(),
      responseType: 'arraybuffer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/pdf' },
      // No seguir redirects a hosts inesperados ni inflar memoria sin límite.
      maxContentLength: 25 * 1024 * 1024,
      maxBodyLength: 25 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 300,
    }
  );

  const { pdf } = pdfFromResponse(resp, ['pdf_base64', 'pdf', 'data', 'result']);
  if (!pdf) throw new Error('html2pdf no devolvió un PDF utilizable');
  return pdf;
}

/**
 * INTERFAZ LIMPIA E INTERCAMBIABLE.
 * pades-signer: PDF → PDF firmado PAdES.
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
  const target = cleanUrl(url || process.env.PADES_SIGNER_URL);
  if (!target) throw new Error('PADES_SIGNER_URL no configurada');
  const pdfField = process.env.PADES_PDF_FIELD || 'pdf_base64';

  const body = {
    [pdfField]: pdfBuffer.toString('base64'),
    // Metadatos NO-PII de la firma (motivo/rótulo/ubicación).
    reason: meta.reason || 'Reporte mensual de asistencia aprobado',
    name: meta.name || providerLabel(),
    location: meta.location || undefined,
  };

  const resp = await axios.post(target, body, {
    timeout: timeout || timeoutMs(),
    responseType: 'arraybuffer',
    headers: { 'Content-Type': 'application/json', Accept: 'application/pdf' },
    maxContentLength: 25 * 1024 * 1024,
    maxBodyLength: 25 * 1024 * 1024,
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

  if (cfg.effectiveMode !== SIGNING_MODES.PADES_LOCAL) {
    // Fail-closed: no se firma PAdES. Se registra la razón (sin PII/URLs).
    if (cfg.degradedReason && cfg.degradedReason !== DEGRADE_REASONS.NOT_PADES) {
      logger.warn('Firma PAdES no disponible; se usa firma simple interna', {
        signing_reason: cfg.degradedReason,
        signing_mode: SIGNING_MODES.SIMPLE,
      });
    }
    return {
      pdf: await asBuffer(),
      mode: SIGNING_MODES.SIMPLE,
      provider: null,
      signatureInfo: null,
      note: cfg.degradedReason && cfg.degradedReason !== DEGRADE_REASONS.NOT_PADES
        ? cfg.degradedReason
        : null,
    };
  }

  // Modo PAdES activo: html2pdf → pades-signer.
  try {
    const rendered = await renderHtmlToPdf(html, { url: cfg.html2pdfUrl });
    let signed;
    try {
      signed = await signPdf(rendered, { meta, url: cfg.padesUrl });
    } catch (err) {
      logger.error('pades-signer falló; se cae a firma simple interna', err, {
        signing_reason: DEGRADE_REASONS.SIGN_FAILED,
      });
      return {
        pdf: await asBuffer(), mode: SIGNING_MODES.SIMPLE, provider: null,
        signatureInfo: null, note: DEGRADE_REASONS.SIGN_FAILED,
      };
    }
    if (!signed.signedPdf || !signed.signedPdf.length) {
      logger.error('pades-signer devolvió un resultado vacío; firma simple interna', {
        signing_reason: DEGRADE_REASONS.EMPTY_RESULT,
      });
      return {
        pdf: await asBuffer(), mode: SIGNING_MODES.SIMPLE, provider: null,
        signatureInfo: null, note: DEGRADE_REASONS.EMPTY_RESULT,
      };
    }
    logger.info('Reporte mensual firmado con PAdES local', {
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
  } catch (err) {
    // Falla html2pdf (o algo antes de firmar).
    logger.error('html2pdf falló; se cae a firma simple interna', err, {
      signing_reason: DEGRADE_REASONS.HTML2PDF_FAILED,
    });
    return {
      pdf: await asBuffer(), mode: SIGNING_MODES.SIMPLE, provider: null,
      signatureInfo: null, note: DEGRADE_REASONS.HTML2PDF_FAILED,
    };
  }
}

module.exports = {
  SIGNING_MODES,
  DEGRADE_REASONS,
  resolveSigningConfig,
  isPadesActive,
  providerLabel,
  renderHtmlToPdf,
  signPdf,
  signReportDocument,
};
