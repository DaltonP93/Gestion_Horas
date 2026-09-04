/**
 * padesSigner.test.js — FASE 2, adaptador de firma local (html2pdf + pades-signer).
 *
 * Los servicios html2pdf y pades-signer NO existen en CI: se MOCKEA axios.
 * El contrato real (confirmado contra los server.js del dueño):
 *   - html2pdf     : POST /pdf, header x-render-key, body { html, options },
 *                    respuesta PDF binario.
 *   - pades-signer : POST /sign, header x-sign-key, multipart/form-data
 *                    campo `file` + `reason`, respuesta PDF firmado binario.
 *
 * Cubre:
 *   - resolveSigningConfig fail-closed: default simple; pades_local sin URLs /
 *     sin secretos degrada a simple con razón; con URLs+secretos queda activo.
 *   - signPdf: envía multipart con el PDF y el header de secreto; respuesta
 *     binaria y (tolerancia) JSON base64.
 *   - renderHtmlToPdf: pega a {URL}/pdf con el header de secreto y body { html, options }.
 *   - signReportDocument: simple usa el fallback sin tocar la red;
 *     pades_local OK devuelve el PDF firmado + provider; html2pdf caído /
 *     pades-signer caído → cae al fallback con nota (fail-closed) sin romper.
 */

jest.mock('axios');
const axios = require('axios');
const FormData = require('form-data');

// Silenciar el logger real (evita ruido y dependencias de formato).
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const pades = require('../src/services/signing/padesSigner');

const PDF = () => Buffer.from('%PDF-1.4 fake\n%%EOF');
const SIGNED = () => Buffer.from('%PDF-1.4 signed\n%%EOF');

// Config completa de pades_local para los tests de camino feliz.
const FULL = {
  SIGNING_MODE: 'pades_local',
  HTML2PDF_URL: 'http://html2pdf:8000',
  PADES_SIGNER_URL: 'http://pades:9000',
  HTML2PDF_SHARED_SECRET: 'render-secret',
  PADES_SIGNER_SHARED_SECRET: 'sign-secret',
};

const OLD_ENV = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV };
  delete process.env.SIGNING_MODE;
  delete process.env.HTML2PDF_URL;
  delete process.env.PADES_SIGNER_URL;
  delete process.env.HTML2PDF_SHARED_SECRET;
  delete process.env.PADES_SIGNER_SHARED_SECRET;
  delete process.env.HTML2PDF_PATH;
  delete process.env.PADES_SIGNER_PATH;
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

  test('pades_local con URLs pero SIN secretos → degrada a simple (MISSING_SECRETS)', () => {
    const c = pades.resolveSigningConfig({
      SIGNING_MODE: 'pades_local', HTML2PDF_URL: 'http://h', PADES_SIGNER_URL: 'http://p',
    });
    expect(c.effectiveMode).toBe('simple');
    expect(c.degradedReason).toBe(pades.DEGRADE_REASONS.MISSING_SECRETS);
  });

  test('pades_local con sólo un secreto → degrada a simple (MISSING_SECRETS)', () => {
    const c = pades.resolveSigningConfig({
      SIGNING_MODE: 'pades_local', HTML2PDF_URL: 'http://h', PADES_SIGNER_URL: 'http://p',
      HTML2PDF_SHARED_SECRET: 'x',
    });
    expect(c.effectiveMode).toBe('simple');
    expect(c.degradedReason).toBe(pades.DEGRADE_REASONS.MISSING_SECRETS);
  });

  test('pades_local con URLs + ambos secretos → activo; arma los paths por defecto', () => {
    const c = pades.resolveSigningConfig({
      ...FULL, HTML2PDF_URL: 'http://h/', PADES_SIGNER_URL: 'http://p/',
    });
    expect(c.effectiveMode).toBe('pades_local');
    expect(c.degradedReason).toBeNull();
    expect(c.html2pdfUrl).toBe('http://h/pdf');   // trailing slash normalizado + path
    expect(c.padesUrl).toBe('http://p/sign');
  });

  test('PATH vacío respeta la URL tal cual (ya incluye el endpoint)', () => {
    const c = pades.resolveSigningConfig({
      ...FULL, HTML2PDF_URL: 'http://h/custom', PADES_SIGNER_URL: 'http://p/custom',
      HTML2PDF_PATH: '', PADES_SIGNER_PATH: '',
    });
    expect(c.html2pdfUrl).toBe('http://h/custom');
    expect(c.padesUrl).toBe('http://p/custom');
  });
});

describe('renderHtmlToPdf (contrato /pdf + header)', () => {
  test('pega a {URL}/pdf con header de secreto y body { html, options }', async () => {
    process.env.HTML2PDF_URL = 'http://html2pdf:8000';
    process.env.HTML2PDF_SHARED_SECRET = 'render-secret';
    axios.post.mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: PDF() });

    const pdf = await pades.renderHtmlToPdf('<h1>hola</h1>');
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');

    const [target, body, cfg] = axios.post.mock.calls[0];
    expect(target).toBe('http://html2pdf:8000/pdf');
    expect(body.html).toContain('<h1>hola</h1>');
    expect(body.options).toBeTruthy();
    expect(cfg.headers['x-render-key']).toBe('render-secret');
    expect(cfg.responseType).toBe('arraybuffer');
  });
});

describe('signPdf (contrato /sign multipart)', () => {
  beforeEach(() => {
    process.env.PADES_SIGNER_URL = 'http://pades:9000';
    process.env.PADES_SIGNER_SHARED_SECRET = 'sign-secret';
  });

  test('respuesta binaria application/pdf; request multipart con header de firma', async () => {
    axios.post.mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: SIGNED() });
    const { signedPdf } = await pades.signPdf(PDF(), { meta: { reason: 'x' } });
    expect(signedPdf.slice(0, 4).toString()).toBe('%PDF');

    const [target, form, cfg] = axios.post.mock.calls[0];
    expect(target).toBe('http://pades:9000/sign');
    expect(form).toBeInstanceOf(FormData);
    expect(String(cfg.headers['content-type'])).toMatch(/^multipart\/form-data/);
    expect(cfg.headers['x-sign-key']).toBe('sign-secret');
  });

  test('respuesta JSON con base64 (tolerancia)', async () => {
    axios.post.mockResolvedValueOnce({
      headers: { 'content-type': 'application/json' },
      data: { signed_pdf_base64: SIGNED().toString('base64') },
    });
    const { signedPdf } = await pades.signPdf(PDF(), {});
    expect(signedPdf.slice(0, 4).toString()).toBe('%PDF');
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

  test('pades_local con URLs pero sin secretos: fail-closed a simple (MISSING_SECRETS)', async () => {
    process.env.SIGNING_MODE = 'pades_local';
    process.env.HTML2PDF_URL = 'http://html2pdf:8000';
    process.env.PADES_SIGNER_URL = 'http://pades:9000';
    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.MISSING_SECRETS);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('pades_local OK: html2pdf → pades-signer → PDF firmado + provider', async () => {
    Object.assign(process.env, FULL, { SIGNING_PROVIDER_NAME: 'pades-local' });
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
    // primer POST a html2pdf/pdf lleva el HTML
    expect(axios.post.mock.calls[0][0]).toBe('http://html2pdf:8000/pdf');
    expect(axios.post.mock.calls[0][1].html).toContain('<html>x</html>');
    // segundo POST a pades/sign es multipart
    expect(axios.post.mock.calls[1][0]).toBe('http://pades:9000/sign');
    expect(axios.post.mock.calls[1][1]).toBeInstanceOf(FormData);
  });

  test('html2pdf caído: cae a simple con nota, sin romper', async () => {
    Object.assign(process.env, FULL);
    axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.HTML2PDF_FAILED);
    expect(fallbackPdf).toHaveBeenCalled();
    expect(r.pdf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('pades-signer caído: html2pdf OK pero firma falla → simple con nota', async () => {
    Object.assign(process.env, FULL);
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
