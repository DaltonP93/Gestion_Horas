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
 * ── QUÉ VERIFICA (el verificador usado, documentado) ───────────────────────
 * Firma PDF estándar (PAdES/PKCS#7 detached, la que produce node-signpdf y los
 * firmadores compatibles). Los pasos, con `node-forge` (PKCS#7/ASN.1 puro JS):
 *   1. Extrae el ÚLTIMO `/ByteRange [a b c d]` y el `/Contents <hex>` del PDF.
 *      [P1-B] COBERTURA TOTAL fail-closed: la firma debe cubrir TODO el PDF
 *      final excepto ÚNICAMENTE el hueco de `/Contents`. Se exige:
 *        · a === 0                        (el contenido firmado arranca en el byte 0)
 *        · b > 0 y d > 0                  (ambos segmentos no vacíos)
 *        · c > a + b                      (hay un hueco real para la firma, sin solape)
 *        · c + d === pdfBuffer.length     (cubre hasta el ÚLTIMO byte del archivo)
 *      Así, agregar contenido NO firmado al final (incremental update sin nueva
 *      firma) rompe `c+d === length` → se rechaza (BYTERANGE_INCOMPLETE).
 *   2. Parsea el PKCS#7 SignedData; toma el SignerInfo con su IssuerAndSerial.
 *   3. [P1-C] ALGORITMOS fail-closed: el digest debe ser uno EXPLÍCITAMENTE
 *      permitido (sha256/sha384/sha512); un OID desconocido NO cae a sha256 →
 *      UNSUPPORTED_DIGEST. El esquema de firma debe ser RSA (RSASSA-PKCS1-v1_5,
 *      única familia que estos firmadores emiten y que forge verifica) → si la
 *      clave del firmante no es RSA, UNSUPPORTED_SIG_ALG.
 *   4. [P1-D] IDENTIDAD del firmante: el certificado se ASOCIA al SignerInfo por
 *      issuer + serial (no "cualquier certificado embebido que verifique"), se
 *      comprueba su VIGENCIA (notBefore/notAfter) y se expone su fingerprint
 *      SHA-256 (`signerCertSha256`) para que el adaptador lo PINEE contra
 *      `PADES_TRUSTED_CERT_SHA256`.
 *   5. INTEGRIDAD: el atributo `messageDigest` debe ser EXACTAMENTE el hash del
 *      contenido cubierto por el ByteRange (si el PDF se alteró, no coincide).
 *   6. AUTENTICIDAD: la firma debe verificar sobre el DER del conjunto de
 *      atributos firmados (SET OF, tag 0x31) con la clave pública del cert del
 *      firmante identificado en (4).
 *
 * Devuelve `{ valid, reason, signerSubjectCN, digestAlg, signerCertSha256,
 * signerSerial, notBefore, notAfter }`. NO valida la cadena del certificado
 * contra una CA de confianza (el pinning por fingerprint lo hace el adaptador):
 * su objetivo es probar que el PDF trae una firma CRIPTOGRÁFICAMENTE VÁLIDA, que
 * cubre todo el documento y que el firmante es identificable — lo necesario para
 * NO afirmar `pades_local` sobre un archivo sin firma real. Cualquier problema
 * devuelve `valid:false` con una razón NO-PII.
 */

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
  SIGNER_CERT_NOT_FOUND: 'SIGNER_CERT_NOT_FOUND',
  CERT_NOT_YET_VALID: 'CERT_NOT_YET_VALID',
  CERT_EXPIRED: 'CERT_EXPIRED',
  NO_MESSAGE_DIGEST: 'NO_MESSAGE_DIGEST',
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
  NO_CERT: 'NO_CERT',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
});

/** Digests EXPLÍCITAMENTE permitidos (OID → nombre forge.md). Nada más pasa. */
const ALLOWED_DIGESTS = Object.freeze({
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
});

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

/**
 * Longitud total (cabecera + contenido) de la PRIMERA estructura DER en `buf`,
 * o `null` si la cabecera es ilegible/indefinida. Permite recortar el objeto
 * PKCS#7 exacto sin depender de heurísticas sobre el padding del hueco.
 */
function derTotalLength(buf) {
  if (!buf || buf.length < 2) return null;
  const lenByte = buf[1];
  if (lenByte < 0x80) return 2 + lenByte; // forma corta
  const numBytes = lenByte & 0x7f;
  // 0x80 = indefinida (no válida en DER); más de 4 bytes de longitud es absurdo aquí.
  if (numBytes === 0 || numBytes > 4 || buf.length < 2 + numBytes) return null;
  let contentLen = 0;
  for (let i = 0; i < numBytes; i += 1) contentLen = (contentLen * 256) + buf[2 + i];
  return 2 + numBytes + contentLen;
}

/** Encuentra el ÚLTIMO /ByteRange y el /Contents de la firma en el PDF. */
function extractSignature(pdfBuffer) {
  const latin1 = pdfBuffer.toString('latin1');

  // Último ByteRange (la firma más reciente).
  const brRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m; let last = null;
  while ((m = brRe.exec(latin1)) !== null) last = m;
  if (!last) return { error: REASONS.NO_BYTERANGE };
  const a = Number(last[1]); const b = Number(last[2]);
  const c = Number(last[3]); const d = Number(last[4]);
  if (![a, b, c, d].every((n) => Number.isFinite(n) && n >= 0)) return { error: REASONS.NO_BYTERANGE };

  // [P1-B] COBERTURA TOTAL fail-closed: la firma cubre todo el PDF salvo el
  // hueco de /Contents. Cualquier desviación (no arranca en 0, segmentos vacíos,
  // solape, o no llega al último byte → hay contenido NO firmado al final) se
  // rechaza. `c+d === length` es lo que atrapa el "append tras firmar".
  if (a !== 0) return { error: REASONS.BYTERANGE_INCOMPLETE };
  if (b <= 0 || d <= 0) return { error: REASONS.BYTERANGE_INCOMPLETE };
  if (c <= a + b) return { error: REASONS.BYTERANGE_INCOMPLETE }; // debe haber hueco real, sin solape
  if (c + d !== pdfBuffer.length) return { error: REASONS.BYTERANGE_INCOMPLETE };

  // Contenido firmado = los dos segmentos del ByteRange (el hueco es la firma).
  const signedData = Buffer.concat([
    pdfBuffer.subarray(a, a + b),
    pdfBuffer.subarray(c, c + d),
  ]);

  // El PKCS#7 (hex) vive en el hueco [a+b, c) del ByteRange. Según el firmante
  // los delimitadores `<`/`>` quedan dentro o fuera del hueco: se tolera todo
  // quitando lo que no sea hex. El hueco de `/Contents` está RELLENO CON CEROS
  // hasta un ancho fijo, así que tras la firma hay padding `00`. NO se puede
  // recortar el padding por "quitar 00 del final": la propia firma DER puede
  // terminar en 0x00 (≈1/256 de las claves) y se perdería un byte → firma
  // corrupta de forma no-determinista. Se recorta con la LONGITUD EXACTA que
  // declara la cabecera DER de la estructura; el resto es padding y se descarta.
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

/** [P1-C] OID de digest → nombre de forge.md, SÓLO si está en la allowlist. */
function digestNameFromOid(oid) {
  return ALLOWED_DIGESTS[oid] || null;
}

/** SHA-256 (hex) sobre una cadena de bytes DER. */
function sha256Hex(derBytes) {
  const md = forge.md.sha256.create();
  md.update(derBytes);
  return md.digest().toHex();
}

/**
 * Fingerprint SHA-256 (hex) de un certificado forge, sobre su DER RE-ENCODADO.
 * Nota: para el PIN se usa el DER EMBEBIDO exacto (ver `findSignerCert`), que es
 * el que produce `openssl x509 -fingerprint -sha256`. Este helper es sólo para
 * usos que ya parten de un objeto cert (tests).
 */
function certSha256(cert) {
  try { return sha256Hex(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()); } catch (_e) { return null; }
}

/** Serial (hex, sin ceros a la izquierda) del certificado forge. */
function normalizeSerialHex(serial) {
  return String(serial || '').toLowerCase().replace(/^0+/, '') || '0';
}

/**
 * [P1-D] Asocia el SignerInfo (issuer + serial del rawCapture) con SU
 * certificado embebido. No basta con "algún cert que verifique": debe ser el
 * cert cuyo issuer/serial coincide con los del SignerInfo.
 *
 * Devuelve `{ cert, sha256 }` donde `sha256` se calcula sobre el DER EMBEBIDO
 * EXACTO del certificado (el nodo ASN.1 tal como vino en la firma), NO sobre un
 * re-encode: así coincide byte-a-byte con `openssl x509 -fingerprint -sha256`
 * del certificado real, que es de dónde sale el pin en producción.
 */
function findSignerCert(p7, rc) {
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
      let sha256 = null;
      try { sha256 = sha256Hex(forge.asn1.toDer(node).getBytes()); } catch (_e) { sha256 = null; }
      return { cert, sha256 };
    }
  }
  return null;
}

/**
 * Verifica criptográficamente la firma PAdES/PKCS#7 de un PDF.
 * @param {Buffer} pdfBuffer
 * @param {object} [opts]
 * @param {Date}   [opts.now]  reloj para la comprobación de vigencia (test).
 * @returns {{valid:boolean, reason:string|null, signerSubjectCN:string|null,
 *            digestAlg:string|null, signerCertSha256:string|null,
 *            signerSerial:string|null, notBefore:Date|null, notAfter:Date|null}}
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

  // [P1-C] Digest EXPLÍCITAMENTE permitido (sin fallback silencioso a sha256).
  let digestOid = null;
  try { digestOid = forge.asn1.derToOid(rc.digestAlgorithm); } catch (_e) { digestOid = null; }
  const mdName = digestNameFromOid(digestOid);
  if (!mdName) return fail(REASONS.UNSUPPORTED_DIGEST);

  // [P1-D] Identidad del firmante: SU certificado por issuer/serial.
  const certsNode = rc.certificates && Array.isArray(rc.certificates.value)
    ? rc.certificates.value : [];
  if (!certsNode.length) return fail(REASONS.NO_CERT);
  const found = findSignerCert(p7, rc);
  if (!found) return fail(REASONS.SIGNER_CERT_NOT_FOUND);
  const { cert, sha256: signerCertSha256 } = found;

  // [P1-C] Esquema de firma permitido: RSA (RSASSA-PKCS1-v1_5). Si la clave del
  // firmante no es RSA (no tiene módulo/exponente), no se acepta.
  if (!cert.publicKey || !cert.publicKey.n || !cert.publicKey.e) {
    return fail(REASONS.UNSUPPORTED_SIG_ALG);
  }

  // [P1-D] Vigencia del certificado del firmante.
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

  // (5) INTEGRIDAD: messageDigest == hash(contenido del ByteRange).
  const mdContent = forge.md[mdName].create();
  mdContent.update(ext.signedData.toString('binary'));
  if (mdContent.digest().getBytes() !== messageDigest) return fail(REASONS.DIGEST_MISMATCH);

  // (6) AUTENTICIDAD: firma sobre el DER del SET OF de atributos firmados, con
  // la clave pública del certificado del firmante IDENTIFICADO (no cualquiera).
  const attrSet = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs,
  );
  const attrDer = forge.asn1.toDer(attrSet).getBytes();
  const mdAttrs = forge.md[mdName].create();
  mdAttrs.update(attrDer);
  const attrDigest = mdAttrs.digest().getBytes();

  let ok = false;
  try { ok = cert.publicKey.verify(attrDigest, signature); } catch (_e) { ok = false; }
  if (!ok) return fail(REASONS.SIGNATURE_INVALID);

  let cn = null;
  try { cn = cert.subject.getField('CN')?.value || null; } catch (_e) { cn = null; }

  return {
    valid: true,
    reason: null,
    signerSubjectCN: cn,
    digestAlg: mdName,
    signerCertSha256, // fingerprint sobre el DER EMBEBIDO (coincide con openssl)
    signerSerial: normalizeSerialHex(cert.serialNumber),
    notBefore: notBefore instanceof Date ? notBefore : null,
    notAfter: notAfter instanceof Date ? notAfter : null,
  };
}

module.exports = {
  verifyPdfSignature,
  REASONS,
  ALLOWED_DIGESTS,
  _extractSignature: extractSignature,
  _findSignerCert: findSignerCert,
  _certSha256: certSha256,
};
