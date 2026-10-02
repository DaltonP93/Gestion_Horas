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
 * La prueba central (abajo) construye el caso defensivo con una clave privada
 * SINTÉTICA de prueba y exponente 65537 (NO una falsificación sin clave): firma
 * un DigestInfo NO canónico (con relleno en el DigestAlgorithm) y demuestra la
 * diferencia real — node-forge 1.4.0 lo ACEPTA, node:crypto/OpenSSL lo RECHAZA —
 * conservando un control canónico válido que ambos aceptan. Las demás pruebas
 * verifican que el verificador PAdES delega en node:crypto (no en forge) y
 * rechaza la precondición del ataque (exponente ≠ 65537).
 */

const crypto = require('node:crypto');
const forge = require('node-forge');
const { makeSignedPdf } = require('./helpers/makeSignedPdf');
const V = require('../src/services/signing/verifyPdfSignature');

const { verifyPdfSignature } = V;
const asn1 = forge.asn1;

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

describe('CVE-2026-85393 — forge acepta un DigestInfo no canónico; node:crypto lo rechaza', () => {
  // Clave de prueba con exponente estándar 65537 (no se explota exponente bajo,
  // sino la laxitud de parseo del DigestInfo). Se usa la PRIVADA de prueba para
  // emitir firmas válidas con DigestInfo canónico vs. con relleno.
  let keys; let pem; let message; let md; let digest; let k;
  const sha256Oid = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes());
  const nullNode = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '');
  const digestInfoDer = (algSeq) => asn1.toDer(asn1.create(
    asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true,
    [algSeq, asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest)],
  )).getBytes();
  /** EM PKCS#1 v1.5 (00 01 FF..FF 00 || T); el scheme custom deja bt=false → encrypt lo usa tal cual. */
  const signRaw = (t) => keys.privateKey.sign(md, { encode: () => `\x00\x01${'\xff'.repeat(k - 3 - t.length)}\x00${t}` });

  beforeAll(() => {
    keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    pem = forge.pki.publicKeyToPem(keys.publicKey);
    message = Buffer.from('contenido PAdES de prueba para la regresión');
    md = forge.md.sha256.create(); md.update(message.toString('binary'));
    digest = md.digest().getBytes();
    k = Math.ceil(keys.privateKey.n.bitLength() / 8);
  });

  test('control canónico: forge y node:crypto lo aceptan', () => {
    const alg = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [sha256Oid(), nullNode()]);
    const sig = signRaw(digestInfoDer(alg));
    expect(keys.publicKey.verify(digest, sig)).toBe(true);
    expect(crypto.verify('sha256', message, pem, Buffer.from(sig, 'binary'))).toBe(true);
  });

  test('DigestInfo con relleno en el DigestAlgorithm: forge ACEPTA (vulnerable), node:crypto RECHAZA', () => {
    const garbage = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'A'.repeat(64));
    const alg = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [sha256Oid(), nullNode(), garbage]);
    const sig = signRaw(digestInfoDer(alg));
    // La firma no es canónica: más larga que el control.
    const canonLen = digestInfoDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [sha256Oid(), nullNode()])).length;
    expect(digestInfoDer(alg).length).toBeGreaterThan(canonLen);
    // node-forge 1.4.0 la da por buena (el bug); node:crypto/OpenSSL la rechaza.
    expect(keys.publicKey.verify(digest, sig)).toBe(true);
    expect(crypto.verify('sha256', message, pem, Buffer.from(sig, 'binary'))).toBe(false);
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

  test('firma alterada (último byte del valor de la firma) → no válida', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'FirmaAlterada' });
    // Corrupción DETERMINISTA: se toma el DER exacto del PKCS#7 y se altera su
    // último byte (contenido del OCTET STRING de la firma), re-hex del MISMO
    // largo sobre el hueco de /Contents (el padding de ceros queda intacto).
    const ext = V._extractSignature(signedPdf);
    const der = Buffer.from(ext.signature);
    der[der.length - 1] ^= 0xff;
    const pdf = Buffer.from(signedPdf);
    const hexStart = pdf.indexOf(Buffer.from('/Contents <', 'latin1')) + '/Contents <'.length;
    Buffer.from(der.toString('hex'), 'latin1').copy(pdf, hexStart);
    const r = verifyPdfSignature(pdf);
    expect(r.valid).toBe(false);
    expect(['SIGNATURE_INVALID', 'BAD_CMS']).toContain(r.reason);
  });

  test('contrato SHA-256 / SHA-384 / SHA-512 preservado', () => {
    for (const [name, oid] of [['sha256', forge.pki.oids.sha256], ['sha384', forge.pki.oids.sha384], ['sha512', forge.pki.oids.sha512]]) {
      const { signedPdf } = makeSignedPdf({ commonName: name, digestAlgorithm: oid });
      const r = verifyPdfSignature(signedPdf);
      expect(r.valid).toBe(true);
      expect(r.digestAlg).toBe(name);
    }
  });
});

describe('identidad del firmante: issuer/serial y pin por fingerprint', () => {
  test('el firmante se asocia por issuer/serial; un serial que no matchea → sin certificado', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'Serial', serialNumber: '0a0b0c' });
    const ext = V._extractSignature(signedPdf);
    const p7 = forge.pkcs7.messageFromAsn1(asn1.fromDer(forge.util.createBuffer(ext.signature.toString('binary'))));
    const rc = p7.rawCapture;
    expect(V._findSignerCert(p7, rc)).not.toBeNull();
    // Serial que no corresponde a ningún cert embebido → no se identifica firmante.
    expect(V._findSignerCert(p7, { ...rc, serial: forge.util.hexToBytes('7f7f7f') })).toBeNull();
  });

  test('el serial reportado es el del firmante identificado (normalizado)', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'SerialReport', serialNumber: '0a0b0c' });
    expect(verifyPdfSignature(signedPdf).signerSerial).toBe('a0b0c');
  });

  test('PIN: el fingerprint expuesto se calcula sobre el MISMO DER que node:crypto parsea, y difiere entre certificados', () => {
    const a = makeSignedPdf({ commonName: 'PinA' });
    const b = makeSignedPdf({ commonName: 'PinB' });
    const ra = verifyPdfSignature(a.signedPdf);
    expect(ra.valid).toBe(true);

    // El DER embebido que el verificador entrega a node:crypto es el mismo sobre
    // el que calcula el fingerprint del pin (coincide con openssl -fingerprint).
    const ext = V._extractSignature(a.signedPdf);
    const p7 = forge.pkcs7.messageFromAsn1(asn1.fromDer(forge.util.createBuffer(ext.signature.toString('binary'))));
    const found = V._findSignerCert(p7, p7.rawCapture);
    const x509 = new crypto.X509Certificate(found.certDer);
    expect(crypto.createHash('sha256').update(x509.raw).digest('hex')).toBe(found.sha256);
    expect(ra.signerCertSha256).toBe(found.sha256);
    // Dos certificados distintos → fingerprints distintos (base del pin).
    expect(ra.signerCertSha256).not.toBe(b.certSha256);
  });
});

describe('node:crypto verifica de forma INDEPENDIENTE la firma PAdES legítima', () => {
  test('re-deriva certDer y atributos firmados y verifica con crypto.verify; un bit alterado → false', () => {
    const { signedPdf } = makeSignedPdf({ commonName: 'Independiente' });
    const ext = V._extractSignature(signedPdf);
    const p7 = forge.pkcs7.messageFromAsn1(asn1.fromDer(forge.util.createBuffer(ext.signature.toString('binary'))));
    const rc = p7.rawCapture;
    const found = V._findSignerCert(p7, rc);
    const x509 = new crypto.X509Certificate(found.certDer);

    const attrSet = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, rc.authenticatedAttributes);
    const attrDer = Buffer.from(asn1.toDer(attrSet).getBytes(), 'binary');
    const sig = Buffer.from(rc.signature, 'binary');

    const key = { key: x509.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING };
    expect(crypto.verify('sha256', attrDer, key, sig)).toBe(true);

    const badSig = Buffer.from(sig); badSig[badSig.length - 1] ^= 0xff;
    expect(crypto.verify('sha256', attrDer, key, badSig)).toBe(false);
  });
});
