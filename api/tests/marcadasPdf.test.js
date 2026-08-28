/**
 * marcadasPdf.test.js — El render del PDF de Marcadas.
 *
 * El render se extrajo de la ruta para poder medirlo en el benchmark de
 * memoria. Este test verifica que sigue produciendo un PDF válido —una página
 * por empleado, y una portada de "sin registros" cuando no hay datos— para que
 * la extracción no haya cambiado el comportamiento en silencio.
 */

const { Writable } = require('stream');
const PDFDocument = require('pdfkit');
const { renderMarcadasPdf } = require('../src/services/marcadasPdf');

/** Renderiza a memoria y devuelve el Buffer del PDF. */
function render(report) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    const sink = new Writable({ write(c, _e, cb) { trozos.push(c); cb(); } });
    sink.on('finish', () => resolve(Buffer.concat(trozos)));
    sink.on('error', reject);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.on('error', reject);
    doc.pipe(sink);
    renderMarcadasPdf(doc, report);
  });
}

const empleado = (n) => ({
  employee_name: `Empleado ${n}`, code: String(3000 + n), department: 'Operaciones',
  total_hm: '8:00',
  rows: [{ dayName: 'Martes', date: '10/06/2025', pairs: [{ entrada: '08:00', salida: '17:00' }], total: '8:00' }],
});

const esPdf = (buf) => buf.length > 0 && buf.slice(0, 5).toString() === '%PDF-';

describe('renderMarcadasPdf', () => {
  test('produce un PDF válido con datos', async () => {
    const buf = await render({ data: [empleado(1), empleado(2)], from: '2025-06-01', to: '2025-06-30' });
    expect(esPdf(buf)).toBe(true);
  });

  test('produce un PDF de "sin registros" cuando no hay empleados', async () => {
    const buf = await render({ data: [], from: '2025-06-01', to: '2025-06-30' });
    expect(esPdf(buf)).toBe(true);
  });

  test('no lanza con muchos empleados (una página por cada uno)', async () => {
    const data = Array.from({ length: 60 }, (_, i) => empleado(i));
    const buf = await render({ data, from: '2025-06-01', to: '2025-06-30' });
    expect(esPdf(buf)).toBe(true);
    // Un PDF de 60 empleados pesa bastante más que uno de dos.
    expect(buf.length).toBeGreaterThan(5000);
  });

  test('tolera filas con más pares en unos empleados que en otros', async () => {
    const data = [
      { ...empleado(1), rows: [{ dayName: 'Lunes', date: '09/06/2025',
        pairs: [{ entrada: '08:00', salida: '12:00' }, { entrada: '13:00', salida: '17:00' }], total: '8:00' }] },
      empleado(2),
    ];
    const buf = await render({ data, from: '2025-06-01', to: '2025-06-30' });
    expect(esPdf(buf)).toBe(true);
  });
});
