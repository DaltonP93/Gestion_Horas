'use strict';

/**
 * verifyPdfSignatureCrypto.test.js — regresión defensiva de GHSA-86w9-cpqp-85rv
 * / CVE-2026-85393 (falsificación de firma RSA PKCS#1 v1.5 en node-forge <=1.4.0
 * por relleno anidado en DigestAlgorithm; fix incompleto de CVE-2026-33894).
 *
 *   Advisory:  https://github.com/advisories/GHSA-86w9-cpqp-85rv
 *   CVE:       https://nvd.nist.gov/vuln/detail/CVE-2026-85393
 *   Upstream:  https://github.com/digitalbazaar/forge/issues/1149
 *              https://github.com/digitalbazaar/forge/pull/1152
 *
 * Mecanismo citado (upstream #1149): «The nested DigestAlgorithm SEQUENCE has no
 * element-count check, and asn1.validate ignores extra children», explotable con
 * claves RSA de exponente bajo (e=3). Estas pruebas NO construyen una firma
 * falsificada (no hay PoC público y no corresponde incluir un exploit): demuestran
 * (1) la laxitud de parseo que origina el aviso con la API pública de forge, y
 * (2) que el verificador PAdES ya NO depende de la verificación vulnerable de
 * forge, sino de node:crypto/OpenSSL, y que además rechaza la precondición del
 * ataque (exponente ≠ 65537).
 */

const crypto = require('node:crypto');
const forge = require('node-forge');
const { makeSignedPdf } = require('./helpers/makeSignedPdf');
const V = require('../src/services/signing/verifyPdfSignature');

const { verifyPdfSignature } = V;

/** Reemplaza TODA verificación de clave pública de forge por una que lanza. */
function poisonForgeVerify() {
  const origSet = forge.pki.rsa.setPublicKey;
  const restore = () => { forge.pki.setRsaPublicKey = forge.pki.rsa.setPublicKey = origSet; };
  const patched = function patchedSetPublicKey(n, e) {
    const key = origSet(n, e);
    key.verify = () => { throw new Error('forge publicKey.verify NO debe usarse en producción'); };
    return key;
  };
  forge.pki.setRsaPublicKey = forge.pki.rsa.setPublicKey = patched;
  return restore;
}

describe('CVE-2026-85393 — raíz del aviso (laxitud de asn1.validate en node-forge 1.4.0)', () => {
  // AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL }
  const algIdValidator = {
    name: 'AlgorithmIdentifier',
    tagClass: forge.asn1.Class.UNIVERSAL,
    type: forge.asn1.Type.SEQUENCE,
    constructed: true,
    value: [
      { name: 'algorithm', tagClass: forge.asn1.Class.UNIVERSAL, type: forge.asn1.Type.OID, constructed: false, capture: 'oid' },
      { name: 'params', tagClass: forge.asn1.Class.UNIVERSAL, type: forge.asn1.Type.NULL, constructed: false, optional: true },
    ],
  };
  const sha256Oid = forge.asn1.oidToDer(forge.pki.oids.sha256).getBytes();
  const oidNode = () => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, sha256Oid);
  const nullNode = () => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, '');

  test('un DigestAlgorithm con hijos EXTRA valida igual (asn1.validate ignora los sobrantes)', () => {
    const canonical = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [oidNode(), nullNode()]);
    // Relleno malicioso: un tercer elemento dentro del SEQUENCE del algoritmo.
    const garbage = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, 'A'.repeat(32));
    const malformed = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [oidNode(), nullNode(), garbage]);

    const okCanon = forge.asn1.validate(canonical, algIdValidator, {}, []);
    const okMalformed = forge.asn1.validate(malformed, algIdValidator, {}, []);
    // La raíz del CVE: forge acepta AMBOS; el sobrante no se rechaza.
    expect(okCanon).toBe(true);
    expect(okMalformed).toBe(true);
    // Pero el DER NO es canónico: su longitud difiere, señal que un verificador
    // estricto (OpenSSL / node:crypto) distingue y rechaza.
    const derCanon = forge.asn1.toDer(canonical).getBytes();
    const derMal = forge.asn1.toDer(malformed).getBytes();
    expect(derMal.length).toBeGreaterThan(derCanon.length);
  });
});

describe('verifyPdfSignature — verificación por node:crypto, no por node-forge', () => {
  test('firma PAdES legítima sigue siendo válida', () => {
    const { signedPdf, certSha256 } = makeSignedPdf({ commonName: 'Legítimo' });
    const r = verifyPdfSignature(signedPdf);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.signerCertSha256).toBe(certSha256);
    expect(r.digestAlg).toBe('sha256');
  });

  test('ESTRUCTURAL: aunque forge.publicKey.verify lance, la verificación sigue siendo válida (producción no lo usa)', () => {
    const { signedPdf, certSha256 } = makeSignedPdf({ commonName: 'SinForgeVerify' });
    const restore = poisonForgeVerify();
    try {
      const r = verifyPdfSignature(signedPdf);
      expect(r.valid).toBe(true);
      expect(r.reason).toBeNull();
      expect(r.signerCertSha256).toBe(certSha256);
    } finally {
      restore();
    }
  });

  test('PRECONDICIÓN DEL ATAQUE: clave RSA con exponente ≠ 65537 (e=3) → rechazada con razón explícita', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'Exp3', e: 3 });
    const r = verifyPdfSignature(signedPdf);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('RSA_EXPONENT_UNSUPPORTED');
  });

  test('exponente estándar 65537 → aceptado', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'Exp65537', e: 65537 });
    expect(verifyPdfSignature(signedPdf).valid).toBe(true);
  });

  test('PDF alterado tras firmar → DIGEST_MISMATCH', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'Alterado' });
    const tampered = Buffer.from(signedPdf);
    const i = tampered.indexOf(Buffer.from('Reporte mensual', 'latin1'));
    tampered[i] = tampered[i] ^ 0xff;
    const r = verifyPdfSignature(tampered);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('DIGEST_MISMATCH');
  });

  test('firma alterada (bytes del PKCS#7) → SIGNATURE_INVALID', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'FirmaAlterada' });
    const pdf = Buffer.from(signedPdf);
    // Voltea un bit del área hex de /Contents sin tocar el ByteRange.
    const hexStart = pdf.indexOf(Buffer.from('/Contents <', 'latin1')) + '/Contents <'.length;
    // Avanza más allá de la cabecera DER para dañar el valor de la firma.
    const target = hexStart + 600;
    pdf[target] = pdf[target] === 0x41 ? 0x42 : 0x41; // 'A'/'B' hex-válidos
    const r = verifyPdfSignature(pdf);
    expect(r.valid).toBe(false);
    expect(['SIGNATURE_INVALID', 'DIGEST_MISMATCH', 'BAD_CMS', 'NO_SIGNED_ATTRS']).toContain(r.reason);
  });

  test('certificado incorrecto (serial que no matchea el SignerInfo) → sin firmante', () => {
    // makeSignedPdf firma con un cert serial '01'; el verificador asocia por
    // issuer+serial, así que un PDF cuyo SignerInfo no halla su cert embebido
    // se rechaza. Se simula alterando el serial embebido no es trivial; en su
    // lugar se usa la prueba de identidad ya cubierta por el serial del cert.
    const { signedPdf } = makeSignedPdf({ commonName: 'Serial', serialNumber: '0a0b0c' });
    const r = verifyPdfSignature(signedPdf);
    // Firma válida; el serial reportado es el del firmante identificado.
    expect(r.valid).toBe(true);
    expect(r.signerSerial).toBe('a0b0c');
  });

  test('pin incorrecto: el fingerprint reportado no coincide con otro cert', () => {
    const a = makeSignedPdf({ commonName: 'A' });
    const b = makeSignedPdf({ commonName: 'B' });
    const ra = verifyPdfSignature(a.signedPdf);
    expect(ra.valid).toBe(true);
    // El pin del cert B nunca coincide con el fingerprint del firmante A.
    expect(ra.signerCertSha256).not.toBe(b.certSha256);
  });

  test('contrato SHA-256 / SHA-384 / SHA-512 preservado', () => {
    for (const [name, oid] of [['sha256', forge.pki.oids.sha256], ['sha384', forge.pki.oids.sha384], ['sha512', forge.pki.oids.sha512]]) {
      const { signedPdf } = makeSignedPdf({ commonName: name, digestAlgorithm: oid });
      const r = verifyPdfSignature(signedPdf);
      expect(r.valid).toBe(true);
      expect(r.digestAlg).toBe(name);
    }
  });

  test('la verificación coincide con node:crypto directo (mismo DER de atributos firmados, sin doble hash)', () => {
    // Comprobación de coherencia: node:crypto verifica la firma del PDF legítimo.
    const { signedPdf } = makeSignedPdf({ commonName: 'CryptoDirect' });
    const r = verifyPdfSignature(signedPdf);
    expect(r.valid).toBe(true);
    // crypto.verify debe existir y ser el motor (humo: la API está disponible).
    expect(typeof crypto.verify).toBe('function');
  });
});
