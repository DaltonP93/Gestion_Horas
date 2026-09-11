'use strict';

/**
 * makeSignedPdf.js — helper de TEST: produce un PDF con una firma PKCS#7/PAdES
 * REAL (detached, con authenticatedAttributes: contentType + messageDigest +
 * signingTime), equivalente a lo que emite node-signpdf / un firmador PAdES.
 *
 * Se usa para probar de forma DETERMINISTA (sin Docker) que:
 *   - un PDF con firma criptográfica válida se verifica → `verifyPdfSignature`
 *     devuelve `valid:true` y `signReportDocument` declara `pades_local`;
 *   - un PDF manipulado tras firmar rompe la verificación (DIGEST_MISMATCH);
 *   - un %PDF SIN firma nunca se declara `pades_local`.
 *
 * NO es un firmador de producción: sólo arma un PDF-mínimo con `/ByteRange` y
 * `/Contents` para ejercer el verificador con criptografía de verdad.
 */

const forge = require('node-forge');

/** Genera un par de llaves + certificado autofirmado de prueba. */
function makeTestCert(commonName = 'SisHoras Reporte Mensual (test)') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 3600e3);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600e3);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert, commonName };
}

/**
 * Arma un PDF firmado (detached PKCS#7) sobre su propio ByteRange.
 * @param {object} [opts]
 * @param {string} [opts.commonName]  CN del certificado firmante.
 * @param {string} [opts.body]        texto de relleno del PDF.
 * @returns {{ signedPdf: Buffer, commonName: string }}
 */
function makeSignedPdf({ commonName, body = 'Reporte mensual de asistencia' } = {}) {
  const { keys, cert, commonName: cn } = makeTestCert(commonName);
  const HEXW = 8000; // ancho del hueco hex de /Contents

  const pre = Buffer.from(
    `%PDF-1.4\n% ${body}\n1 0 obj<</Type/Sig/SubFilter/adbe.pkcs7.detached`
    + '/ByteRange [0000000000 0000000000 0000000000 0000000000]/Contents <',
    'latin1');
  const post = Buffer.from('>>>\n%%EOF\n', 'latin1');
  const hole = Buffer.from('0'.repeat(HEXW), 'latin1');
  const pdf = Buffer.concat([pre, hole, post]);

  const hexStart = pdf.indexOf('/Contents <') + '/Contents <'.length;
  const gtPos = pdf.indexOf('>', hexStart);
  // ByteRange estándar: [0, hexStart, gtPos, len2] — el '<' queda en el 1er
  // segmento, el '>' en el 2º; el hex entre ambos es la firma.
  const a = 0;
  const b = hexStart;
  const c = gtPos;
  const d = pdf.length - gtPos;
  const brStr = `[${String(a).padStart(10, '0')} ${String(b).padStart(10, '0')} ${String(c).padStart(10, '0')} ${String(d).padStart(10, '0')}]`;
  Buffer.from(brStr, 'latin1').copy(pdf, pdf.indexOf('[0000000000'));

  const signedData = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(signedData.toString('binary'));
  p7.addCertificate(cert);
  p7.addSigner({
    key: keys.privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });

  let hex = forge.util.bytesToHex(forge.asn1.toDer(p7.toAsn1()).getBytes());
  if (hex.length > HEXW) throw new Error(`firma demasiado grande (${hex.length} > ${HEXW})`);
  hex += '0'.repeat(HEXW - hex.length);
  Buffer.from(hex, 'latin1').copy(pdf, hexStart);

  return { signedPdf: pdf, commonName: cn };
}

module.exports = { makeSignedPdf, makeTestCert };
