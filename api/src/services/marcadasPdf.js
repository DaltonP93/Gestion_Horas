/**
 * marcadasPdf.js — Render del PDF de Marcadas.
 *
 * Se extrajo de la ruta `/api/reports/marcadas/pdf` sin cambiarle una línea de
 * dibujo, por dos razones:
 *
 *   1. El benchmark de memoria (scripts/benchmark-marcadas-memory.js) necesita
 *      medir el CAMINO REAL del PDF —incluidos los Buffer de pdfkit, que viven
 *      en `external` y no en el heap—. Duplicar el render para el benchmark
 *      mediría otra cosa; compartirlo mide lo que produce el servidor.
 *   2. Deja el render en un solo lugar testeable.
 *
 * La función escribe en un `PDFDocument` YA CREADO y lo cierra con `doc.end()`.
 * No sabe nada de HTTP: la ruta le pasa `doc.pipe(res)` y el benchmark le pasa
 * un sink que descarta. Así el mismo código sirve para los dos.
 */

'use strict';

const { maxPairsOf } = require('./scheduler');

/**
 * Dibuja el reporte de Marcadas en `doc` y lo finaliza.
 *
 * @param {PDFDocument} doc   documento ya creado (con su pipe ya conectado).
 * @param {Object} report     `{ data: empleados[], from, to }`.
 */
function renderMarcadasPdf(doc, { data, from, to }) {
  const employees = data || [];

  if (!employees.length) {
    doc.fontSize(14).fillColor('#1e40af').text('Reporte de Marcadas', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).fillColor('#64748b').text(`Período: ${from} al ${to}`, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#000').text('Sin registros en el período seleccionado.', { align: 'center' });
    doc.end();
    return;
  }

  // Sin spread: este array tiene un elemento por empleado × día, y el
  // `Math.max(...)` que había acá desbordaba el stack en rangos grandes.
  const maxPairs = employees.reduce((max, e) => Math.max(max, maxPairsOf(e.rows)), 1);

  employees.forEach((emp, idx) => {
    if (idx > 0) doc.addPage();

    // Encabezado
    doc.fontSize(16).fillColor('#1e40af').text('Reporte de Marcadas por Empleado', { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#64748b').text(`Período: ${from} al ${to}`, { align: 'center' });
    doc.moveDown(1);

    // Datos del empleado
    doc.fontSize(12).fillColor('#000')
      .text(emp.employee_name, { continued: true })
      .fillColor('#64748b').fontSize(10).text(`   Cód. ${emp.code}${emp.department ? ' · ' + emp.department : ''}`);
    doc.moveDown(0.7);

    // Tabla
    const colDate   = 110;
    const colPair   = 55;  // ancho por columna entrada/salida
    const colTotal  = 60;
    const tableW    = colDate + colPair * 2 * maxPairs + colTotal;
    const startX    = doc.page.margins.left;
    let y           = doc.y;

    // Headers
    doc.fontSize(8).fillColor('#fff');
    doc.rect(startX, y, tableW, 18).fill('#1e40af');
    doc.fillColor('#fff');
    doc.text('Fecha', startX + 4, y + 5, { width: colDate - 4 });
    for (let i = 0; i < maxPairs; i++) {
      const xE = startX + colDate + (i * 2) * colPair;
      const xS = xE + colPair;
      doc.text('Entrada', xE, y + 5, { width: colPair, align: 'center' });
      doc.text('Salida',  xS, y + 5, { width: colPair, align: 'center' });
    }
    doc.text('Total', startX + tableW - colTotal, y + 5, { width: colTotal - 4, align: 'right' });
    y += 18;

    // Filas
    doc.fontSize(9);
    emp.rows.forEach((row, ri) => {
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      if (ri % 2 === 0) {
        doc.rect(startX, y, tableW, 16).fill('#f8fafc');
      }
      doc.fillColor('#0f172a')
        .text(`${row.dayName} ${row.date}`, startX + 4, y + 4, { width: colDate - 4 });
      for (let i = 0; i < maxPairs; i++) {
        const p  = row.pairs[i] || { entrada: '', salida: '' };
        const xE = startX + colDate + (i * 2) * colPair;
        const xS = xE + colPair;
        doc.fillColor('#334155').font('Courier')
          .text(p.entrada, xE, y + 4, { width: colPair, align: 'center' })
          .text(p.salida,  xS, y + 4, { width: colPair, align: 'center' })
          .font('Helvetica');
      }
      doc.fillColor(row.total === '0:00' ? '#dc2626' : '#1e40af')
        .font('Courier-Bold')
        .text(row.total, startX + tableW - colTotal, y + 4, { width: colTotal - 4, align: 'right' })
        .font('Helvetica');
      y += 16;
    });

    // Total
    doc.rect(startX, y, tableW, 22).fill('#eff6ff');
    doc.fillColor('#1e40af').fontSize(11).font('Helvetica-Bold')
      .text('Total período', startX + 4, y + 6, { width: tableW - colTotal - 8 });
    doc.font('Courier-Bold').fontSize(13)
      .text(emp.total_hm, startX + tableW - colTotal, y + 5, { width: colTotal - 4, align: 'right' });
    doc.font('Helvetica');
  });

  doc.end();
}

module.exports = { renderMarcadasPdf };
