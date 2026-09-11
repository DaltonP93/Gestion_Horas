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
const { makeSignedPdf } = require('./helpers/makeSignedPdf');

const PDF = () => Buffer.from('%PDF-1.4 fake\n%%EOF');
// Un %PDF sin firma criptográfica real: el adaptador NUNCA debe declararlo pades_local.
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

  test('pades_local con FIRMA REAL verificable: html2pdf → pades-signer → pades_local + verificado', async () => {
    Object.assign(process.env, FULL, { SIGNING_PROVIDER_NAME: 'pades-local' });
    const { signedPdf } = makeSignedPdf({ commonName: 'SisHoras Test Cert' }); // firma PKCS#7 REAL
    axios.post
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: PDF() })       // html2pdf
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: signedPdf });  // pades-signer

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html>x</html>', fallbackPdf, meta: { reason: 'r' } });

    expect(r.mode).toBe('pades_local');
    expect(r.provider).toBe('pades-local');
    expect(r.signatureInfo).toEqual(expect.objectContaining({ verified: true, digestAlg: 'sha256' }));
    expect(fallbackPdf).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[0][0]).toBe('http://html2pdf:8000/pdf');
    expect(axios.post.mock.calls[0][1].html).toContain('<html>x</html>');
    expect(axios.post.mock.calls[1][0]).toBe('http://pades:9000/sign');
    expect(axios.post.mock.calls[1][1]).toBeInstanceOf(FormData);
    // [SSRF] ambas requests con maxRedirects:0
    expect(axios.post.mock.calls[0][2].maxRedirects).toBe(0);
    expect(axios.post.mock.calls[1][2].maxRedirects).toBe(0);
  });

  test('[SEGURIDAD] pades-signer devuelve un %PDF SIN firma válida → NO pades_local (degrada a simple/UNVERIFIED)', async () => {
    Object.assign(process.env, FULL);
    axios.post
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: PDF() })     // html2pdf OK
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: SIGNED() }); // %PDF sin firma real

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html>x</html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.provider).toBeNull();
    expect(r.note).toBe(pades.DEGRADE_REASONS.UNVERIFIED);
    expect(fallbackPdf).toHaveBeenCalled(); // se sirve el fallback simple, no el "firmado" falso
    expect(axios.post).toHaveBeenCalledTimes(2); // se llamó a ambos servicios pero no se afirma PAdES
  });

  test('[SEGURIDAD] firma manipulada tras firmar → verificación falla → NO pades_local', async () => {
    Object.assign(process.env, FULL);
    const { signedPdf } = makeSignedPdf();
    const tampered = Buffer.from(signedPdf); tampered[12] ^= 0xff; // altera el contenido firmado
    axios.post
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: PDF() })
      .mockResolvedValueOnce({ headers: { 'content-type': 'application/pdf' }, data: tampered });

    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html>x</html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.UNVERIFIED);
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

  test('timeout de red → degrada seguro (nota HTML2PDF_FAILED), sin romper', async () => {
    Object.assign(process.env, FULL);
    const to = new Error('timeout of 15000ms exceeded'); to.code = 'ECONNABORTED';
    axios.post.mockRejectedValueOnce(to);
    const fallbackPdf = jest.fn(() => PDF());
    const r = await pades.signReportDocument({ html: '<html></html>', fallbackPdf });
    expect(r.mode).toBe('simple');
    expect(r.note).toBe(pades.DEGRADE_REASONS.HTML2PDF_FAILED);
  });
});

// ─── [SSRF] allowlist de destinos LOCALES/PRIVADOS ─────────────────────────
describe('isLocalTarget (SSRF: sólo destinos locales/privados)', () => {
  test('acepta loopback/privados/localhost/servicio Docker/sufijo interno', () => {
    for (const u of [
      'http://127.0.0.1:3001/sign', 'http://localhost:3002/pdf',
      'http://10.1.2.3/sign', 'http://192.168.1.9/pdf', 'http://172.16.0.5/x',
      'http://html2pdf:3000/pdf', 'http://pades-signer:3000/sign',
      'http://render.internal/pdf', 'http://svc.local/x', 'http://[::1]:3001/sign',
    ]) expect(pades.isLocalTarget(u, {})).toBe(true);
  });
  test('rechaza hosts PÚBLICOS (FQDN/IP enrutable) y esquemas no http', () => {
    for (const u of [
      'http://evil.example.com/pdf', 'https://8.8.8.8/sign',
      'http://169.254.169.254/latest/meta-data/', // metadata de la nube (SSRF)
      'http://169.254.169.254.nip.io/x', 'http://attacker.io/pdf',
      'file:///etc/passwd', 'ftp://host/x', 'http://1.2.3.4/x',
    ]) expect(pades.isLocalTarget(u, {})).toBe(false);
  });
  test('SIGNING_ALLOWED_HOSTS permite EXPLÍCITAMENTE un host adicional', () => {
    expect(pades.isLocalTarget('http://firmador.corp:3000/sign', { SIGNING_ALLOWED_HOSTS: 'firmador.corp' })).toBe(true);
    expect(pades.isLocalTarget('http://firmador.corp:3000/sign', {})).toBe(false);
  });
  test('resolveSigningConfig degrada a simple si una URL NO es local (URLS_NOT_LOCAL)', () => {
    const c = pades.resolveSigningConfig({
      SIGNING_MODE: 'pades_local',
      HTML2PDF_URL: 'http://127.0.0.1:3002',
      PADES_SIGNER_URL: 'http://evil.example.com:3001',
      HTML2PDF_SHARED_SECRET: 'a', PADES_SIGNER_SHARED_SECRET: 'b',
    });
    expect(c.effectiveMode).toBe('simple');
    expect(c.degradedReason).toBe(pades.DEGRADE_REASONS.URLS_NOT_LOCAL);
  });
});

// ─── PDF/looksLikePdf + verificador criptográfico ──────────────────────────
describe('looksLikePdf + verifyPdfSignature', () => {
  test('looksLikePdf: sólo un PDF real ("%PDF-")', () => {
    expect(pades.looksLikePdf(Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(pades.looksLikePdf(Buffer.from('%PDF'))).toBe(false);       // sin el guión ni cuerpo
    expect(pades.looksLikePdf(Buffer.from('<html>error</html>'))).toBe(false);
    expect(pades.looksLikePdf(Buffer.from(''))).toBe(false);
    expect(pades.looksLikePdf('no-buffer')).toBe(false);
  });
  test('verifyPdfSignature: firma REAL → valid; %PDF sin firma / no-PDF → invalid', () => {
    const { signedPdf, commonName } = makeSignedPdf({ commonName: 'CN Prueba' });
    const ok = pades.verifyPdfSignature(signedPdf);
    expect(ok.valid).toBe(true);
    expect(ok.digestAlg).toBe('sha256');
    expect(ok.signerSubjectCN).toBe(commonName);
    expect(pades.verifyPdfSignature(Buffer.from('%PDF-1.4\nsin firma\n%%EOF')).valid).toBe(false);
    expect(pades.verifyPdfSignature(Buffer.from('no es pdf')).valid).toBe(false);
  });
});
