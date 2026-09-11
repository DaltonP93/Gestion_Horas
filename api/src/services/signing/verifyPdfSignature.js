'use strict';

/**
 * verifyPdfSignature.js — Verificador CRIPTOGRÁFICO de la firma PAdES embebida
 * en un PDF (defensa fail-closed del adaptador de firma).
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
 * El adaptador NO debe declarar `pades_local` sólo porque el servicio de firma
 * devolvió unos bytes que empiezan con "%PDF". Un archivo puede empezar con
 * "%PDF" y NO contener ninguna firma (o una firma inválida/manipulada). Este
 * módulo verifica de verdad, con criptografía, que el PDF contiene una firma
 * PKCS#7/CMS válida sobre su propio contenido antes de afirmar que se firmó.
 *
 * ── QUÉ VERIFICA (el verificador usado, documentado) ───────────────────────
 * Firma PDF estándar (PAdES/PKCS#7 detached, la que produce node-signpdf y los
 * firmadores compatibles). Los pasos, con `node-forge` (PKCS#7/ASN.1 puro JS):
 *   1. Extrae el ÚLTIMO `/ByteRange [a b c d]` y el `/Contents <hex>` del PDF.
 *      El contenido firmado son los bytes [a, a+b) ∪ [c, c+d) (todo el PDF menos
 *      el hueco donde vive la firma). `/Contents` es el PKCS#7 DER (hex).
 *   2. Parsea el PKCS#7 SignedData y toma el SignerInfo, su certificado, el
 *      algoritmo de digest y los atributos firmados (authenticatedAttributes).
 *   3. INTEGRIDAD: el atributo `messageDigest` debe ser EXACTAMENTE el hash del
 *      contenido cubierto por el ByteRange (si el PDF se alteró, no coincide).
 *   4. AUTENTICIDAD: la firma debe verificar sobre el DER del conjunto de
 *      atributos firmados (SET OF, tag 0x31) con la clave pública del cert del
 *      firmante (probando cada certificado embebido hasta que uno verifique).
 *
 * Devuelve `{ valid, reason, signerSubjectCN, digestAlg }`. NO valida la cadena
 * del certificado contra una CA de confianza (eso es una política aparte): su
 * objetivo es probar que el PDF trae una firma CRIPTOGRÁFICAMENTE VÁLIDA y que
 * el contenido no fue manipulado tras firmarse — lo que se necesita para NO
 * afirmar `pades_local` sobre un archivo sin firma real. Cualquier PDF sin
 * `/ByteRange`/`/Contents`, con CMS ilegible, o con digest/firma que no cierran,
 * devuelve `valid:false` con una razón NO-PII.
 */

const forge = require('node-forge');

const REASONS = Object.freeze({
  NO_BUFFER: 'NO_BUFFER',
  NOT_PDF: 'NOT_PDF',
  NO_BYTERANGE: 'NO_BYTERANGE',
  NO_CONTENTS: 'NO_CONTENTS',
  BAD_CMS: 'BAD_CMS',
  NO_SIGNED_ATTRS: 'NO_SIGNED_ATTRS',
  NO_MESSAGE_DIGEST: 'NO_MESSAGE_DIGEST',
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
  NO_CERT: 'NO_CERT',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
});

function fail(reason) { return { valid: false, reason, signerSubjectCN: null, digestAlg: null }; }

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
  if (a + b > pdfBuffer.length || c + d > pdfBuffer.length || c < a + b) return { error: REASONS.NO_BYTERANGE };

  // Contenido firmado = los dos segmentos del ByteRange (el hueco es la firma).
  const signedData = Buffer.concat([
    pdfBuffer.subarray(a, a + b),
    pdfBuffer.subarray(c, c + d),
  ]);

  // El PKCS#7 (hex) vive en el hueco [a+b, c) del ByteRange. Según el firmante
  // los delimitadores `<`/`>` quedan dentro o fuera del hueco: se toleran ambos
  // quitando todo lo que no sea hex y el padding de ceros del final.
  const gap = pdfBuffer.subarray(a + b, c).toString('latin1');
  const sigHex = gap.replace(/[^0-9A-Fa-f]/g, '').replace(/(?:00)+$/i, '');
  if (!sigHex) return { error: REASONS.NO_CONTENTS };
  let signature;
  try { signature = Buffer.from(sigHex, 'hex'); } catch (_e) { return { error: REASONS.NO_CONTENTS }; }
  if (!signature.length) return { error: REASONS.NO_CONTENTS };

  return { signedData, signature };
}

/** OID del digest → nombre de forge.md. Default sha256. */
function mdNameFromOid(oid) {
  const name = forge.pki.oids[oid];
  if (name && forge.md[name]) return name;
  return 'sha256';
}

/**
 * Verifica criptográficamente la firma PAdES/PKCS#7 de un PDF.
 * @param {Buffer} pdfBuffer
 * @returns {{valid:boolean, reason:string|null, signerSubjectCN:string|null, digestAlg:string|null}}
 */
function verifyPdfSignature(pdfBuffer) {
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

  const mdName = mdNameFromOid(forge.asn1.derToOid(rc.digestAlgorithm));

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

  // (1) INTEGRIDAD: messageDigest == hash(contenido del ByteRange).
  const mdContent = forge.md[mdName].create();
  mdContent.update(ext.signedData.toString('binary'));
  if (mdContent.digest().getBytes() !== messageDigest) return fail(REASONS.DIGEST_MISMATCH);

  // (2) AUTENTICIDAD: firma sobre el DER del SET OF de atributos firmados.
  const attrSet = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs,
  );
  const attrDer = forge.asn1.toDer(attrSet).getBytes();
  const mdAttrs = forge.md[mdName].create();
  mdAttrs.update(attrDer);
  const attrDigest = mdAttrs.digest().getBytes();

  const certs = p7.certificates || [];
  if (!certs.length) return fail(REASONS.NO_CERT);
  for (const cert of certs) {
    try {
      if (cert.publicKey.verify(attrDigest, signature)) {
        let cn = null;
        try { cn = cert.subject.getField('CN')?.value || null; } catch (_e) { cn = null; }
        return { valid: true, reason: null, signerSubjectCN: cn, digestAlg: mdName };
      }
    } catch (_e) { /* probar el siguiente certificado */ }
  }
  return fail(REASONS.SIGNATURE_INVALID);
}

module.exports = { verifyPdfSignature, REASONS, _extractSignature: extractSignature };
