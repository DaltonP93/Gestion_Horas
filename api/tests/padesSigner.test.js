/**
 * padesSigner.test.js — FASE 2, adaptador de firma PAdES local.
 *
 * Los servicios html2pdf y pades-signer NO existen en CI: se MOCKEA axios.
 * Cubre:
 *   - resolveSigningConfig fail-closed: default simple; pades_local sin URLs
 *     degrada a simple con razón; pades_local con URLs queda activo.
 *   - signPdf: contrato base64-JSON, respuesta binaria y respuesta JSON base64.
 *   - signReportDocument: simple usa el fallback sin tocar la red;
 *     pades_local OK devuelve el PDF firmado + provider;
 *     html2pdf caído / pades-signer caído → cae al fallback con nota
 *     (fail-closed) sin romper.
 */

jest.mock('axios');
const axios = require('axios');

// Silenciar el logger real (evita ruido y dependencias de formato).
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const pades = require('../src/services/signing/padesSigner');

const PDF = () => Buffer.from('%PDF-1.4 fake\n%%EOF');
const SIGNED = () => Buffer.from('%PDF-1.4 signed\n%%EOF');

const OLD_ENV = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV };
  delete process.env.SIGNING_MODE;
  delete process.env.HTML2PDF_URL;
  delete process.env.PADES_SIGNER_URL;
});
afterAll(() => { process.env = OLD_ENV; });

describe('resolveSigningConfig (fail-closed)', () => {
  test('sin SIGNING_MODE → simple', () => {
    const c = pades.resolveSigningConfig({});
    expect(c.effectiveMode).toBe('simple');
    expect(pades.isPadesActive({})).toBe(false);
  });

  test('valor desconocido → simple', () => {
    expect(pades.resolveSigningConfig({ SIGNING_MODE: 'foo' }).effectiveMode).toBe('simple');
  });

  test('pades_local SIN URLs → degrada a simple con razón', () => {
    const c = pades.resolveSigningConfig({ SIGNING_MODE: 'pades_local' });
    expect(c.requestedMode).toBe('pades_local');
    expect(c.effectiveMode).toBe('simple');
    expect(c.degradedReason).toBe(pades.DEGRADE_REASONS.MISSING_URLS);
  });

  test('pades_local con sólo una URL → degrada a simple', () => {
    const c = pades.resolveSigningConfig({ SIGNING_MODE: 'pades_local', HTML2PDF_URL: 'http://h' });
    expect(c.effectiveMode).toBe('simple');
    expect(c.degradedReason).toBe(pades.DEGRADE_REASONS.MISSING_URLS);
  });

  test('pades_local con ambas URLs → activo', () => {
    const c = pades.resolveSigningConfig({ SIGNING_MODE: 'pades_local', HTML2PDF_URL: 'http://h/', PADES_SIGNER_URL: 'http://p/' });
    expect(c.effectiveMode).toBe('pades_local');
    expect(c.degradedReason).toBeNull();
    expect(c.html2pdfUrl).toBe('http://h'); // trailing slash normalizado
  });
});

describe('signPdf (contrato base64-JSON)', () => {
  beforeEach(() => {
    process.env.PADES_SIGNER_URL = 'http://pades:9000/sign';
  });

  test('respuesta binaria application/pdf', async () => {
    axios.post.mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: SIGNED() });
    const { signedPdf } = await pades.signPdf(PDF(), { meta: { reason: 'x' } });
    expect(signedPdf.slice(0, 4).toString()).toBe('%PDF');
    // el request lleva el PDF en base64 bajo el campo por defecto
    const [, body] = axios.post.mock.calls[0];
    expect(typeof body.pdf_base64).toBe('string');
    expect(Buffer.from(body.pdf_base64, 'base64').slice(0, 4).toString()).toBe('%PDF');
  });

  test('respuesta JSON con base64 y signatureInfo', async () => {
    axios.post.mockResolvedValueOnce({
      headers: { 'content-type': 'application/json' },
      data: { signed_pdf_base64: SIGNED().toString('base64'), signature: { serial: 'abc' } },
    });
    const { signedPdf, signatureInfo } = await pades.signPdf(PDF(), {});
    expect(signedPdf.slice(0, 4).toString()).toBe('%PDF');
    expect(signatureInfo).toEqual({ serial: 'abc' });
  });

  test('sin URL configurada → lanza', async () => {
    delete process.env.PADES_SIGNER_URL;
    await expect(pades.signPdf(PDF(), {})).rejects.toThrow(/PADES_SIGNER_URL/);
  });

  test('buffer vacío → lanza', async () => {
    await expect(pades.signPdf(Buffer.alloc(0), {})).rejects.toThrow(/Buffer PDF/);
  });
});

describe('signReportDocument', () => {
  test('modo simple: usa el fallback y NO toca la red', async () => {
    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.provider).toBeNull();
    expect(fallbackPdf).toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(r.pdf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('pades_local sin URLs: fail-closed a simple con nota', async () => {
    process.env.SIGNING_MODE = 'pades_local';
    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.MISSING_URLS);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('pades_local OK: html2pdf → pades-signer → PDF firmado + provider', async () => {
    process.env.SIGNING_MODE = 'pades_local';
    process.env.HTML2PDF_URL = 'http://html2pdf:8000';
    process.env.PADES_SIGNER_URL = 'http://pades:9000';
    process.env.SIGNING_PROVIDER_NAME = 'pades-local';
    axios.post
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: PDF() })     // html2pdf
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: SIGNED() }); // pades-signer

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html>x</html>', fallbackPdf, meta: { reason: 'r' } });

    expect(r.mode).toBe('pades_local');
    expect(r.provider).toBe('pades-local');
    expect(r.pdf.toString()).toContain('signed');
    expect(fallbackPdf).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(2);
    // primer POST a html2pdf lleva el HTML
    expect(axios.post.mock.calls[0][0]).toBe('http://html2pdf:8000');
    expect(axios.post.mock.calls[0][1].html).toContain('<html>x</html>');
  });

  test('html2pdf caído: cae a simple con nota, sin romper', async () => {
    process.env.SIGNING_MODE = 'pades_local';
    process.env.HTML2PDF_URL = 'http://html2pdf:8000';
    process.env.PADES_SIGNER_URL = 'http://pades:9000';
    axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.HTML2PDF_FAILED);
    expect(fallbackPdf).toHaveBeenCalled();
    expect(r.pdf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('pades-signer caído: html2pdf OK pero firma falla → simple con nota', async () => {
    process.env.SIGNING_MODE = 'pades_local';
    process.env.HTML2PDF_URL = 'http://html2pdf:8000';
    process.env.PADES_SIGNER_URL = 'http://pades:9000';
    axios.post
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: PDF() }) // html2pdf OK
      .mockRejectedValueOnce(new Error('500'));                                               // pades-signer cae

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.SIGN_FAILED);
    expect(fallbackPdf).toHaveBeenCalled();
  });
});
