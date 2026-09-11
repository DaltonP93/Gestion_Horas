'use strict';

/**
 * verifyPdfSignature.test.js — verificador CRIPTOGRÁFICO de la firma PAdES.
 * Prueba, con criptografía real (node-forge), que:
 *   - un PDF con firma PKCS#7 válida sobre su ByteRange → valid:true;
 *   - manipular el contenido firmado rompe la integridad → DIGEST_MISMATCH;
 *   - un %PDF sin firma, un no-PDF y un buffer vacío → valid:false con razón.
 */

const { verifyPdfSignature, REASONS, _extractSignature } = require('../src/services/signing/verifyPdfSignature');
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
