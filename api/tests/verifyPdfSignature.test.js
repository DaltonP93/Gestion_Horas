'use strict';

/**
 * verifyPdfSignature.test.js — verificador CRIPTOGRÁFICO de la firma PAdES.
 * Prueba, con criptografía real (node-forge), que:
 *   - un PDF con firma PKCS#7 válida sobre su ByteRange → valid:true;
 *   - manipular el contenido firmado rompe la integridad → DIGEST_MISMATCH;
 *   - un %PDF sin firma, un no-PDF y un buffer vacío → valid:false con razón.
 */

const forge = require('node-forge');
const {
  verifyPdfSignature, REASONS, ALLOWED_DIGESTS, _extractSignature, _findSignerCert,
} = require('../src/services/signing/verifyPdfSignature');
const { makeSignedPdf } = require('./helpers/makeSignedPdf');

describe('verifyPdfSignature', () => {
  test('firma REAL válida → valid:true, sha256, CN + fingerprint + serial del firmante', () => {
    const { signedPdf, commonName, certSha256 } = makeSignedPdf({ commonName: 'Firmante Prueba SA' });
    const r = verifyPdfSignature(signedPdf);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.digestAlg).toBe('sha256');
    expect(r.signerSubjectCN).toBe(commonName);
    // [P1-D] fingerprint SHA-256 (64 hex) del cert firmante, coincide con el helper.
    expect(r.signerCertSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.signerCertSha256).toBe(certSha256);
    expect(r.signerSerial).toBe('1');
    expect(r.notAfter instanceof Date).toBe(true);
  });

  // ── [P1-B] cobertura TOTAL del ByteRange ─────────────────────────────────
  test('[P1-B] agregar contenido NO firmado al final → BYTERANGE_INCOMPLETE', () => {
    const { signedPdf } = makeSignedPdf();
    // Un PDF firmado válido, con bytes extra al final (incremental update SIN
    // nueva firma): c+d ya no llega al último byte → se rechaza.
    const appended = Buffer.concat([signedPdf, Buffer.from('\n% payload no firmado agregado\n')]);
    const r = verifyPdfSignature(appended);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.BYTERANGE_INCOMPLETE);
  });

  test('[P1-B] ByteRange que no arranca en 0 → BYTERANGE_INCOMPLETE', () => {
    // ByteRange con a≠0 sobre un PDF cualquiera (no cubre desde el byte 0).
    const pdf = Buffer.from('%PDF-1.4\n/ByteRange [5 10 20 8]/Contents <00>\ncola\n%%EOF');
    expect(verifyPdfSignature(pdf).reason).toBe(REASONS.BYTERANGE_INCOMPLETE);
  });

  // ── [P1-C] algoritmos fail-closed ────────────────────────────────────────
  test('[P1-C] ALLOWED_DIGESTS: sha256/384/512 permitidos; sha1/md5 NO', () => {
    const names = Object.values(ALLOWED_DIGESTS);
    expect(names).toEqual(expect.arrayContaining(['sha256', 'sha384', 'sha512']));
    expect(names).not.toContain('sha1');
    expect(names).not.toContain('md5');
    // sha1 OID y md5 OID NO están en el mapa.
    expect(ALLOWED_DIGESTS['1.3.14.3.2.26']).toBeUndefined(); // sha1
  });

  test('[P1-C] firma con digest NO permitido (sha1) → UNSUPPORTED_DIGEST (sin fallback a sha256)', () => {
    const { signedPdf } = makeSignedPdf({ digestAlgorithm: forge.pki.oids.sha1 });
    const r = verifyPdfSignature(signedPdf);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.UNSUPPORTED_DIGEST);
  });

  // ── [P1-D] identidad del firmante ────────────────────────────────────────
  test('[P1-D] certificado VENCIDO → CERT_EXPIRED', () => {
    const { signedPdf } = makeSignedPdf({
      notBefore: new Date(Date.now() - 2 * 86400e3),
      notAfter: new Date(Date.now() - 86400e3), // venció ayer
    });
    expect(verifyPdfSignature(signedPdf).reason).toBe(REASONS.CERT_EXPIRED);
  });

  test('[P1-D] certificado AÚN NO vigente → CERT_NOT_YET_VALID', () => {
    const { signedPdf } = makeSignedPdf({
      notBefore: new Date(Date.now() + 86400e3), // empieza mañana
      notAfter: new Date(Date.now() + 2 * 86400e3),
    });
    expect(verifyPdfSignature(signedPdf).reason).toBe(REASONS.CERT_NOT_YET_VALID);
  });

  test('[P1-D] el firmante se asocia por issuer/serial: un serial que no matchea → sin cert', () => {
    // Se parsea un PDF firmado real y se altera el serial buscado del SignerInfo:
    // findSignerCert ya no encuentra un cert que coincida por issuer+serial.
    const { signedPdf } = makeSignedPdf();
    const ext = _extractSignature(signedPdf);
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(ext.signature.toString('binary')));
    const p7 = forge.pkcs7.messageFromAsn1(asn1);
    const rc = p7.rawCapture;
    // match real:
    expect(_findSignerCert(p7, rc)).not.toBeNull();
    // serial que no existe entre los certs embebidos → null.
    expect(_findSignerCert(p7, { ...rc, serial: forge.util.hexToBytes('7f7f7f') })).toBeNull();
  });

  test('contenido manipulado tras firmar → DIGEST_MISMATCH', () => {
    const { signedPdf } = makeSignedPdf();
    const t = Buffer.from(signedPdf); t[9] ^= 0xff; // altera bytes cubiertos por el ByteRange
    const r = verifyPdfSignature(t);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.DIGEST_MISMATCH);
  });

  test('%PDF sin firma → NO_BYTERANGE', () => {
    expect(verifyPdfSignature(Buffer.from('%PDF-1.4\nhola\n%%EOF')).reason).toBe(REASONS.NO_BYTERANGE);
  });

  test('no es un PDF → NOT_PDF; buffer vacío/no-buffer → NO_BUFFER', () => {
    expect(verifyPdfSignature(Buffer.from('GET / HTTP/1.1')).reason).toBe(REASONS.NOT_PDF);
    expect(verifyPdfSignature(Buffer.alloc(0)).reason).toBe(REASONS.NO_BUFFER);
    expect(verifyPdfSignature('x').reason).toBe(REASONS.NO_BUFFER);
  });

  test('regresión: firma DER que TERMINA en 0x00 no se recorta con el padding del hueco', () => {
    // Reproduce de forma DETERMINISTA el flake no-determinista: cuando la firma
    // DER termina en 0x00 (≈1/256 de las claves), recortar "los 00 del final"
    // del hueco de /Contents se comía ese byte y corrompía la firma. El hueco
    // real trae la firma seguida de padding de ceros; hay que recortar por la
    // LONGITUD DE LA CABECERA DER, no por heurística de ceros.
    const der = Buffer.from([0x30, 0x06, 0x04, 0x04, 0xDE, 0xAD, 0xBE, 0x00]); // SEQUENCE→OCTET STRING, termina en 0x00
    const hex = `${der.toString('hex')}0000`; // firma + padding de ceros del hueco (2 bytes 00)
    const pre = Buffer.from(
      '%PDF-1.4\n% relleno\n/ByteRange [0000000000 0000000000 0000000000 0000000000]/Contents <',
      'latin1');
    const pdf = Buffer.concat([pre, Buffer.from(`${hex}>\ncola\n%%EOF\n`, 'latin1')]);
    const hexStart = pdf.indexOf('/Contents <') + '/Contents <'.length;
    const gtPos = pdf.indexOf('>', hexStart);
    const [a, b, c, d] = [0, hexStart, gtPos, pdf.length - gtPos];
    const brStr = `[${String(a).padStart(10, '0')} ${String(b).padStart(10, '0')} ${String(c).padStart(10, '0')} ${String(d).padStart(10, '0')}]`;
    Buffer.from(brStr, 'latin1').copy(pdf, pdf.indexOf('[0000000000'));

    const ext = _extractSignature(pdf);
    expect(ext.error).toBeUndefined();
    // La firma extraída es EXACTAMENTE la DER (8 bytes, con su 0x00 final), sin padding.
    expect(Buffer.compare(ext.signature, der)).toBe(0);
  });

  test('ByteRange presente pero Contents ilegible → BAD_CMS/NO_CONTENTS (no valid)', () => {
    // ByteRange válido apuntando a un hueco con basura no-DER.
    const pdf = Buffer.from('%PDF-1.4\n/ByteRange [0 20 40 10]/Contents <zzzz>\npad-relleno-mas\n%%EOF');
    const r = verifyPdfSignature(pdf);
    expect(r.valid).toBe(false);
  });
});
