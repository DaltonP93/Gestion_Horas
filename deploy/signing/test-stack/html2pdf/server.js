'use strict';
/**
 * html2pdf (STACK DE PRUEBA) — implementa el MISMO contrato HTTP que el servicio
 * real del dueño para la integración de firma, con dependencias abiertas:
 *   POST /pdf   header x-render-key: <SHARED_SECRET>   body { html, options }
 *               → PDF binario (application/pdf).
 *   GET  /health
 * NO es un renderer fiel (extrae el texto del HTML y lo vuelca con pdfkit): su
 * único fin es producir un PDF VÁLIDO que luego pades-signer firma de verdad.
 */
const express = require('express');
const PDFDocument = require('pdfkit');

const app = express();
app.use(express.json({ limit: '12mb' }));

const SECRET = process.env.SHARED_SECRET || '';
const AUTH_HEADER = (process.env.AUTH_HEADER || 'x-render-key').toLowerCase();

app.get('/health', (_req, res) => res.json({ ok: true, service: 'html2pdf-test' }));

app.post('/pdf', (req, res) => {
  if (SECRET && req.headers[AUTH_HEADER] !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const html = String((req.body && req.body.html) || '');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => {
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.concat(chunks));
  });
  doc.on('error', (e) => res.status(500).json({ error: String(e.message || e) }));
  doc.fontSize(14).text('Reporte Mensual de Asistencia (render de prueba html2pdf)', { align: 'center' });
  doc.moveDown().fontSize(9).text(text || '(documento vacío)');
  doc.end();
});

app.listen(3000, () => console.log('html2pdf-test escuchando en :3000'));
