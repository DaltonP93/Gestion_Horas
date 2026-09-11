'use strict';

/**
 * verifyPdfSignature.test.js — verificador CRIPTOGRÁFICO de la firma PAdES.
 * Prueba, con criptografía real (node-forge), que:
 *   - un PDF con firma PKCS#7 válida sobre su ByteRange → valid:true;
 *   - manipular el contenido firmado rompe la integridad → DIGEST_MISMATCH;
 *   - un %PDF sin firma, un no-PDF y un buffer vacío → valid:false con razón.
 */

const { verifyPdfSignature, REASONS } = require('../src/services/signing/verifyPdfSignature');
const { makeSignedPdf } = require('./helpers/makeSignedPdf');

describe('verifyPdfSignature', () => {
  test('firma REAL válida → valid:true, sha256, CN del firmante', () => {
    const { signedPdf, commonName } = makeSignedPdf({ commonName: 'Firmante Prueba SA' });
    const r = verifyPdfSignature(signedPdf);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.digestAlg).toBe('sha256');
    expect(r.signerSubjectCN).toBe(commonName);
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

  test('ByteRange presente pero Contents ilegible → BAD_CMS/NO_CONTENTS (no valid)', () => {
    // ByteRange válido apuntando a un hueco con basura no-DER.
    const pdf = Buffer.from('%PDF-1.4\n/ByteRange [0 20 40 10]/Contents <zzzz>\npad-relleno-mas\n%%EOF');
    const r = verifyPdfSignature(pdf);
    expect(r.valid).toBe(false);
  });
});
