'use strict';
/**
 * pades-signer (STACK DE PRUEBA) — implementa el MISMO contrato HTTP que el
 * servicio real del dueño, firmando de VERDAD con un certificado .p12 de prueba:
 *   POST /sign  header x-sign-key: <SHARED_SECRET>
 *               multipart/form-data  file=<PDF>  reason=<texto>
 *               → PDF FIRMADO (PAdES/PKCS#7 detached) binario.
 *   GET  /health
 * Usa @signpdf (placeholder-plain + signer-p12): agrega el placeholder de firma
 * al PDF recibido y lo firma con el .p12 montado en /certs. Produce una firma
 * criptográfica REAL (no un sello) que el backend verifica con verifyPdfSignature.
 */
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const signpdf = require('@signpdf/signpdf').default;
const { P12Signer } = require('@signpdf/signer-p12');
const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');

const upload = multer();
const app = express();
app.use(express.urlencoded({ extended: false }));

const SECRET = process.env.SHARED_SECRET || '';
const AUTH_HEADER = (process.env.AUTH_HEADER || 'x-sign-key').toLowerCase();
const P12_PATH = process.env.P12_PATH || '/certs/test.p12';
const P12_PASS = process.env.P12_PASSPHRASE || '';

app.get('/health', (_req, res) => res.json({ ok: true, service: 'pades-signer-test' }));

app.post('/sign', upload.single('file'), async (req, res) => {
  try {
    if (SECRET && req.headers[AUTH_HEADER] !== SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'no file' });
    }
    const p12 = fs.readFileSync(P12_PATH);
    const reason = String((req.body && req.body.reason) || 'Reporte mensual aprobado');
    const withPlaceholder = plainAddPlaceholder({
      pdfBuffer: req.file.buffer,
      reason,
      signatureLength: 8192,
    });
    const signer = new P12Signer(p12, { passphrase: P12_PASS });
    const signed = await signpdf.sign(withPlaceholder, signer);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(signed);
  } catch (err) {
    console.error('sign error:', err && err.message);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

app.listen(3000, () => console.log('pades-signer-test escuchando en :3000'));
