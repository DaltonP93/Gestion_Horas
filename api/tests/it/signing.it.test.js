'use strict';

/**
 * signing.it.test.js — INTEGRACIÓN REAL de la firma PAdES contra los servicios
 * html2pdf + pades-signer levantados por Docker (deploy/signing/test-stack),
 * con un certificado .p12 de PRUEBA. Ejerce el camino COMPLETO del adaptador:
 *   pades.signReportDocument({ html, fallbackPdf, meta })
 *     → html2pdf (POST /pdf) → pades-signer (POST /sign) → PDF FIRMADO
 *     → verificación CRIPTOGRÁFICA (verifyPdfSignature) → mode 'pades_local'.
 *
 * Gate: sólo corre con IT_SIGNING=1 (con el stack arriba). Sin él, se saltea.
 * Levantar el stack:
 *   deploy/signing/test-stack/prepare.sh && \
 *   (cd deploy/signing/test-stack && ./gen-cert.sh && docker compose up --build -d)
 * y correr:
 *   IT_SIGNING=1 SIGNING_MODE=pades_local \
 *   HTML2PDF_URL=http://127.0.0.1:3012 PADES_SIGNER_URL=http://127.0.0.1:3011 \
 *   HTML2PDF_SHARED_SECRET=render-test-secret PADES_SIGNER_SHARED_SECRET=sign-test-secret \
 *   npx jest tests/it/signing.it.test.js --runInBand
 */

const IT = process.env.IT_SIGNING === '1';
const describeIT = IT ? describe : describe.skip;

const pades = require('../../src/services/signing/padesSigner');
const { verifyPdfSignature } = require('../../src/services/signing/verifyPdfSignature');

jest.setTimeout(60000);

const SAMPLE_HTML = '<html><body><h1>Reporte Mensual de Asistencia</h1>'
  + '<p>Período 08/2026 · Alcance: Organización</p>'
  + '<p>Hash de integridad (SHA-256): abcdef0123456789</p></body></html>';

describeIT('FASE 2 — firma PAdES REAL (Docker html2pdf + pades-signer + .p12 de prueba)', () => {
  const fallbackPdf = () => Buffer.from('%PDF-1.4\n% fallback simple\n%%EOF');

  test('pades_local: html2pdf → pades-signer → PDF con firma CRIPTOGRÁFICA verificada', async () => {
    // El entorno ya trae SIGNING_MODE/URLs/secretos apuntando al stack Docker.
    expect(pades.isPadesActive()).toBe(true);

    const result = await pades.signReportDocument({
      html: SAMPLE_HTML,
      fallbackPdf,
      meta: { reason: 'Reporte mensual 08/2026 aprobado (test)' },
    });

    expect(result.mode).toBe('pades_local');
    expect(result.provider).toBeTruthy();
    expect(result.signatureInfo).toEqual(expect.objectContaining({ verified: true }));

    // El PDF devuelto es realmente un PDF y tiene una firma que verifica.
    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const v = verifyPdfSignature(result.pdf);
    expect(v.valid).toBe(true);
    expect(v.digestAlg).toBe('sha256');
    // El CN del cert de prueba montado en pades-signer.
    expect(v.signerSubjectCN).toMatch(/SisHoras/i);

    // Manipular un byte del CONTENIDO cubierto por el ByteRange (la cabecera del
    // PDF, primer segmento) rompe la verificación (integridad real, no un sello).
    const tampered = Buffer.from(result.pdf);
    tampered[8] = tampered[8] ^ 0xff; // dentro de "%PDF-1.x", siempre cubierto
    expect(verifyPdfSignature(tampered).valid).toBe(false);
  });

  test('secreto de firma incorrecto → 401 del servicio → degrada a simple (no afirma PAdES)', async () => {
    const OLD = process.env.PADES_SIGNER_SHARED_SECRET;
    process.env.PADES_SIGNER_SHARED_SECRET = 'secreto-incorrecto';
    try {
      const result = await pades.signReportDocument({ html: SAMPLE_HTML, fallbackPdf, meta: {} });
      expect(result.mode).toBe('simple');
      expect(result.note).toBe(pades.DEGRADE_REASONS.SIGN_FAILED);
    } finally {
      process.env.PADES_SIGNER_SHARED_SECRET = OLD;
    }
  });
});
