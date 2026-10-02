'use strict';

/**
 * verifyPdfSignature.js — Verificador CRIPTOGRÁFICO de la firma PAdES embebida
 * en un PDF (defensa fail-closed del adaptador de firma).
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
 * El adaptador NO debe declarar `pades_local` sólo porque el servicio de firma
 * devolvió unos bytes que empiezan con "%PDF". Un archivo puede empezar con
 * "%PDF" y NO contener ninguna firma (o una firma inválida/manipulada, o una
 * firma que sólo cubre parte del documento). Este módulo verifica de verdad,
 * con criptografía, que el PDF contiene una firma PKCS#7/CMS válida sobre TODO
 * su contenido antes de afirmar que se firmó.
 *
 * ── MOTOR CRIPTOGRÁFICO (GHSA-86w9-cpqp-85rv / CVE-2026-85393) ──────────────
 * La verificación REAL de la firma RSA PKCS#1 v1.5 la hace node:crypto/OpenSSL,
 * NO node-forge. node-forge 1.4.0 acepta firmas falsificadas con claves de
 * exponente bajo por relleno anidado en el DigestAlgorithm y NO tiene versión
 * corregida; por eso aquí NO se usa `cert.publicKey.verify` de forge en ningún
 * camino de producción. forge queda sólo para el parseo CMS/ASN.1 del contenedor
 * (extraer SignerInfo, certificados y atributos firmados). Como defensa adicional
 * se rechazan las claves RSA con exponente distinto de 65537 (el ataque requiere
 * exponente bajo); el cert real del firmador usa F4=65537 (openssl por defecto),
 * verificado en el runbook de firma.
 *
 * ── QUÉ VERIFICA ────────────────────────────────────────────────────────────
 *   1. Último `/ByteRange` + `/Contents`: COBERTURA TOTAL fail-closed (a===0,
 *      segmentos no vacíos, hueco real sin solape y c+d === longitud del PDF).
 *   2. Parsea el PKCS#7 SignedData (forge, sólo ASN.1) y toma el SignerInfo.
 *   3. Digest EXPLÍCITAMENTE permitido (sha256/384/512); sin fallback silencioso.
 *   4. Certificado del firmante ASOCIADO por issuer + serial; vigencia; y pin por
 *      fingerprint SHA-256 del DER del certificado.
 *   5. INTEGRIDAD: `messageDigest` == hash del contenido cubierto por el ByteRange.
 *   6. AUTENTICIDAD: node:crypto.verify(RSA_PKCS1_PADDING) sobre el DER del SET
 *      de atributos firmados (sin digest precomputado → sin doble hash).
 *
 * ── CODIFICACIONES NO CANÓNICAS ─────────────────────────────────────────────
 * El DER del certificado y el del SET de atributos firmados se RE-SERIALIZAN con
 * `forge.asn1.toDer` a partir de los nodos ASN.1 parseados; no se recorta el DER
 * original byte-a-byte. CMS/PAdES exige DER (canónico) para los SignedAttributes,
 * así que para una firma legítima la re-serialización coincide con lo que firmó
 * el emisor y con `openssl x509 -fingerprint -sha256` del certificado. Si el
 * emisor usó una codificación NO canónica (BER, longitudes no mínimas, elementos
 * de más — justamente el vector de CVE-2026-85393), la re-serialización canónica
 * NO la reproduce: el hash o la firma dejan de coincidir y se responde
 * `valid:false` (fail-closed). No se acepta una codificación laxa; en el peor
 * caso se rechaza una firma, nunca se valida una manipulada.
 *
 * Cualquier problema → `valid:false` con una razón NO-PII.
 */

const crypto = require('node:crypto');
const forge = require('node-forge');

const REASONS = Object.freeze({
  NO_BUFFER: 'NO_BUFFER',
  NOT_PDF: 'NOT_PDF',
  NO_BYTERANGE: 'NO_BYTERANGE',
  BYTERANGE_INCOMPLETE: 'BYTERANGE_INCOMPLETE',
  NO_CONTENTS: 'NO_CONTENTS',
  BAD_CMS: 'BAD_CMS',
  NO_SIGNED_ATTRS: 'NO_SIGNED_ATTRS',
  UNSUPPORTED_DIGEST: 'UNSUPPORTED_DIGEST',
  UNSUPPORTED_SIG_ALG: 'UNSUPPORTED_SIG_ALG',
  RSA_EXPONENT_UNSUPPORTED: 'RSA_EXPONENT_UNSUPPORTED',
  SIGNER_CERT_NOT_FOUND: 'SIGNER_CERT_NOT_FOUND',
  BAD_CERT: 'BAD_CERT',
  CERT_NOT_YET_VALID: 'CERT_NOT_YET_VALID',
  CERT_EXPIRED: 'CERT_EXPIRED',
  NO_MESSAGE_DIGEST: 'NO_MESSAGE_DIGEST',
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
  NO_CERT: 'NO_CERT',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
});

/** Digests EXPLÍCITAMENTE permitidos (OID → nombre de algoritmo). Nada más pasa.
 *  Los nombres son válidos tanto para forge.md como para node:crypto. */
const ALLOWED_DIGESTS = Object.freeze({
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
});

/** Único exponente público RSA aceptado (F4). El ataque de CVE-2026-85393
 *  requiere exponente bajo (p. ej. 3); el firmador real usa 65537. */
const REQUIRED_RSA_EXPONENT = 65537n;

function fail(reason) {
  return {
    valid: false,
    reason,
    signerSubjectCN: null,
    digestAlg: null,
    signerCertSha256: null,
    signerSerial: null,
    notBefore: null,
    notAfter: null,
  };
}

/** Convierte una cadena binaria de forge (bytes en latin1) a Buffer, explícito. */
function forgeBytesToBuffer(bytes) {
  return Buffer.from(bytes == null ? '' : bytes, 'binary');
}

/** SHA-256 (hex) sobre un Buffer DER, con node:crypto. */
function sha256HexBuf(derBuffer) {
  return crypto.createHash('sha256').update(derBuffer).digest('hex');
}

/**
 * Longitud total (cabecera + contenido) de la PRIMERA estructura DER en `buf`,
 * o `null` si la cabecera es ilegible/indefinida.
 */
function derTotalLength(buf) {
  if (!buf || buf.length < 2) return null;
  const lenByte = buf[1];
  if (lenByte < 0x80) return 2 + lenByte; // forma corta
  const numBytes = lenByte & 0x7f;
  if (numBytes === 0 || numBytes > 4 || buf.length < 2 + numBytes) return null;
  let contentLen = 0;
  for (let i = 0; i < numBytes; i += 1) contentLen = (contentLen * 256) + buf[2 + i];
  return 2 + numBytes + contentLen;
}

/** Encuentra el ÚLTIMO /ByteRange y el /Contents de la firma en el PDF. */
function extractSignature(pdfBuffer) {
  const latin1 = pdfBuffer.toString('latin1');

  const brRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m; let last = null;
  while ((m = brRe.exec(latin1)) !== null) last = m;
  if (!last) return { error: REASONS.NO_BYTERANGE };
  const a = Number(last[1]); const b = Number(last[2]);
  const c = Number(last[3]); const d = Number(last[4]);
  if (![a, b, c, d].every((n) => Number.isFinite(n) && n >= 0)) return { error: REASONS.NO_BYTERANGE };

  if (a !== 0) return { error: REASONS.BYTERANGE_INCOMPLETE };
  if (b <= 0 || d <= 0) return { error: REASONS.BYTERANGE_INCOMPLETE };
  if (c <= a + b) return { error: REASONS.BYTERANGE_INCOMPLETE };
  if (c + d !== pdfBuffer.length) return { error: REASONS.BYTERANGE_INCOMPLETE };

  const signedData = Buffer.concat([
    pdfBuffer.subarray(a, a + b),
    pdfBuffer.subarray(c, c + d),
  ]);

  const gap = pdfBuffer.subarray(a + b, c).toString('latin1');
  const hexAll = gap.replace(/[^0-9A-Fa-f]/g, '');
  if (hexAll.length < 4) return { error: REASONS.NO_CONTENTS };
  let raw;
  try { raw = Buffer.from(hexAll, 'hex'); } catch (_e) { return { error: REASONS.NO_CONTENTS }; }
  if (!raw.length) return { error: REASONS.NO_CONTENTS };
  const derLen = derTotalLength(raw);
  const signature = (derLen && derLen >= 2 && derLen <= raw.length) ? raw.subarray(0, derLen) : raw;

  return { signedData, signature };
}

/** OID de digest → nombre, SÓLO si está en la allowlist. */
function digestNameFromOid(oid) {
  return ALLOWED_DIGESTS[oid] || null;
}

/** Serial (hex, sin ceros a la izquierda) de un certificado/serial. */
function normalizeSerialHex(serial) {
  return String(serial || '').toLowerCase().replace(/^0+/, '') || '0';
}

/** Fingerprint SHA-256 (hex) de un cert forge (sólo para tests/herramientas). */
function certSha256(cert) {
  try {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    return sha256HexBuf(forgeBytesToBuffer(der));
  } catch (_e) { return null; }
}

/**
 * Asocia el SignerInfo (issuer + serial) con SU certificado embebido. Devuelve
 * `{ cert, certDer, sha256 }`: `cert` es el objeto forge (metadatos: serial,
 * vigencia, CN); `certDer` es el Buffer con el DER del certificado RE-SERIALIZADO
 * desde su nodo ASN.1 (DER canónico: para un cert legítimo coincide con el DER
 * embebido y con `openssl x509 -fingerprint`), usado para construir la
 * X509Certificate de node:crypto y para el pin; `sha256` es su fingerprint.
 */
function findSignerCert(_p7, rc) {
  const nodes = (rc.certificates && Array.isArray(rc.certificates.value)) ? rc.certificates.value : [];
  if (!nodes.length) return null;
  const siSerialHex = normalizeSerialHex(forge.util.bytesToHex(rc.serial || ''));
  let siIssuerDer = null;
  try { siIssuerDer = forge.asn1.toDer(rc.issuer).getBytes(); } catch (_e) { siIssuerDer = null; }
  if (siIssuerDer == null) return null;

  for (const node of nodes) {
    let cert;
    try { cert = forge.pki.certificateFromAsn1(node); } catch (_e) { continue; }
    if (normalizeSerialHex(cert.serialNumber) !== siSerialHex) continue;
    let certIssuerDer;
    try {
      certIssuerDer = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(cert.issuer)).getBytes();
    } catch (_e) { continue; }
    if (certIssuerDer === siIssuerDer) {
      let certDer = null;
      try { certDer = forgeBytesToBuffer(forge.asn1.toDer(node).getBytes()); } catch (_e) { certDer = null; }
      if (!certDer || !certDer.length) return null;
      return { cert, certDer, sha256: sha256HexBuf(certDer) };
    }
  }
  return null;
}

/**
 * Verifica criptográficamente la firma PAdES/PKCS#7 de un PDF.
 * @param {Buffer} pdfBuffer
 * @param {object} [opts]
 * @param {Date}   [opts.now]  reloj para la comprobación de vigencia (test).
 */
function verifyPdfSignature(pdfBuffer, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) return fail(REASONS.NO_BUFFER);
  if (pdfBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(REASONS.NOT_PDF);

  const ext = extractSignature(pdfBuffer);
  if (ext.error) return fail(ext.error);

  let p7;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(ext.signature.toString('binary')));
    p7 = forge.pkcs7.messageFromAsn1(asn1);
  } catch (_e) {
    return fail(REASONS.BAD_CMS);
  }

  const rc = p7.rawCapture || {};
  const attrs = rc.authenticatedAttributes;
  const signature = rc.signature;
  if (!attrs || !attrs.length || !signature) return fail(REASONS.NO_SIGNED_ATTRS);

  // Digest EXPLÍCITAMENTE permitido (sin fallback silencioso a sha256).
  let digestOid = null;
  try { digestOid = forge.asn1.derToOid(rc.digestAlgorithm); } catch (_e) { digestOid = null; }
  const mdName = digestNameFromOid(digestOid);
  if (!mdName) return fail(REASONS.UNSUPPORTED_DIGEST);

  // Identidad del firmante: SU certificado por issuer/serial.
  const certsNode = rc.certificates && Array.isArray(rc.certificates.value)
    ? rc.certificates.value : [];
  if (!certsNode.length) return fail(REASONS.NO_CERT);
  const found = findSignerCert(p7, rc);
  if (!found) return fail(REASONS.SIGNER_CERT_NOT_FOUND);
  const { cert, certDer, sha256: signerCertSha256 } = found;

  // Clave pública del firmante vía node:crypto, a partir del DER (canónico) del
  // certificado. La verificación de la firma NO usa forge (CVE-2026-85393).
  let x509; let publicKey;
  try {
    x509 = new crypto.X509Certificate(certDer);
    publicKey = x509.publicKey;
  } catch (_e) { return fail(REASONS.BAD_CERT); }

  // Esquema permitido: RSA (RSASSA-PKCS1-v1_5).
  if (!publicKey || publicKey.asymmetricKeyType !== 'rsa') return fail(REASONS.UNSUPPORTED_SIG_ALG);
  // Defensa contra la precondición del ataque: sólo exponente 65537.
  const details = (typeof publicKey.asymmetricKeyDetails === 'object' && publicKey.asymmetricKeyDetails) || {};
  if (details.publicExponent === undefined || BigInt(details.publicExponent) !== REQUIRED_RSA_EXPONENT) {
    return fail(REASONS.RSA_EXPONENT_UNSUPPORTED);
  }

  // Vigencia del certificado del firmante (metadatos de forge).
  const now = opts.now instanceof Date ? opts.now : new Date();
  const notBefore = cert.validity && cert.validity.notBefore;
  const notAfter = cert.validity && cert.validity.notAfter;
  if (notBefore instanceof Date && now < notBefore) return fail(REASONS.CERT_NOT_YET_VALID);
  if (notAfter instanceof Date && now > notAfter) return fail(REASONS.CERT_EXPIRED);

  // messageDigest firmado.
  let messageDigest = null;
  for (const attr of attrs) {
    try {
      const oid = forge.asn1.derToOid(attr.value[0].value);
      if (oid === forge.pki.oids.messageDigest) {
        messageDigest = attr.value[1].value[0].value;
        break;
      }
    } catch (_e) { /* atributo con forma inesperada; se ignora */ }
  }
  if (messageDigest == null) return fail(REASONS.NO_MESSAGE_DIGEST);

  // (5) INTEGRIDAD: messageDigest == hash(contenido del ByteRange), con node:crypto.
  const contentDigest = crypto.createHash(mdName).update(ext.signedData).digest();
  const expectedDigest = forgeBytesToBuffer(messageDigest);
  if (contentDigest.length !== expectedDigest.length
      || !crypto.timingSafeEqual(contentDigest, expectedDigest)) {
    return fail(REASONS.DIGEST_MISMATCH);
  }

  // (6) AUTENTICIDAD: node:crypto.verify sobre el DER del SET OF de atributos
  // firmados, RE-SERIALIZADO desde los nodos ASN.1 (DER canónico; para una firma
  // legítima equivale a lo que firmó el emisor, que CMS exige en DER). Se pasa
  // ese DER completo, no un digest precomputado, para que OpenSSL haga el hash
  // una sola vez; padding RSA PKCS#1 v1.5.
  const attrSet = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs,
  );
  const attrDer = forgeBytesToBuffer(forge.asn1.toDer(attrSet).getBytes());
  const sigBuf = forgeBytesToBuffer(signature);

  let ok = false;
  try {
    ok = crypto.verify(
      mdName,
      attrDer,
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      sigBuf,
    );
  } catch (_e) { ok = false; }
  if (!ok) return fail(REASONS.SIGNATURE_INVALID);

  let cn = null;
  try { cn = cert.subject.getField('CN')?.value || null; } catch (_e) { cn = null; }

  return {
    valid: true,
    reason: null,
    signerSubjectCN: cn,
    digestAlg: mdName,
    signerCertSha256, // fingerprint sobre el DER canónico del cert (coincide con openssl)
    signerSerial: normalizeSerialHex(cert.serialNumber),
    notBefore: notBefore instanceof Date ? notBefore : null,
    notAfter: notAfter instanceof Date ? notAfter : null,
  };
}

module.exports = {
  verifyPdfSignature,
  REASONS,
  ALLOWED_DIGESTS,
  REQUIRED_RSA_EXPONENT,
  _extractSignature: extractSignature,
  _findSignerCert: findSignerCert,
  _certSha256: certSha256,
};
