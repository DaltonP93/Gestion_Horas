#!/usr/bin/env node
/**
 * benchmark-marcadas-memory.js — Medición del consumo del reporte de Marcadas.
 *
 * SÓLO LECTURA. Emite SELECT y nada más. No toca ATT2000.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ INCIDENTE MIDE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * PM2 tiene `max_memory_restart` en 536.870.912 bytes (512 MB). Se observaron
 * reinicios del API con 545.738.752, 1.283.604.480, 757.321.728, 625.246.208,
 * 541.741.056 y 733.835.264 bytes, y los 502 del navegador coinciden con el
 * SIGINT de PM2 — el 502 es CONSECUENCIA del reinicio, no su causa.
 *
 * Justo antes del reinicio del 19/08 se habían generado reportes de Marcadas
 * grandes (2024-12-01 → 2025-01-31, respuesta ≈1,9 MB). Este script existe
 * para pasar de esa correlación a una medición.
 *
 * La solución NO puede ser subir `max_memory_restart`: eso esconde el síntoma
 * y deja el crecimiento sin acotar.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POR QUÉ VARIAS ITERACIONES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Un pico alto en una corrida puede ser trabajo legítimo que el GC después
 * libera. Lo que mata al proceso es el crecimiento ACUMULATIVO: memoria que
 * queda retenida entre peticiones por una caché, un closure o un listener. Por
 * eso cada escenario corre N veces y se informa el delta entre la primera y la
 * última corrida, además del pico.
 *
 * Correr con --expose-gc mejora mucho la señal, porque permite forzar una
 * recolección antes de cada medición y distinguir "todavía no se recolectó" de
 * "no se puede recolectar":
 *
 *     node --expose-gc scripts/benchmark-marcadas-memory.js --iterations 5
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Va ANTES de requerir config/database, que lee process.env al cargarse.
function cargarEnv(argv) {
  if (argv.includes('--no-env')) return { modo: 'shell', archivo: null };
  const i = argv.indexOf('--env');
  const archivo = (i >= 0 && argv[i + 1])
    ? path.resolve(argv[i + 1])
    : path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(archivo)) return { modo: 'shell', archivo, faltante: true };
  require('dotenv').config({ path: archivo, override: true });
  return { modo: 'archivo', archivo };
}

const ENV = cargarEnv(process.argv.slice(2));

const { Writable } = require('stream');
const { sequelize } = require('../src/config/database');
const { generateMarcadasReport } = require('../src/services/scheduler');
const { renderMarcadasPdf } = require('../src/services/marcadasPdf');

const MB = 1048576;
const mb = (b) => (b / MB).toFixed(1);

function parseArgs(argv) {
  const args = { iterations: 3, out: null, employee: null, scenarios: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--iterations') args.iterations = Math.max(1, Number(next()));
    else if (a === '--out') args.out = next();
    else if (a === '--employee') args.employee = next();
    else if (a === '--scenario') args.scenarios = (args.scenarios || []).concat(next());
    else if (a === '--env') next();
    else if (a === '--no-env') { /* ya procesado */ }
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) throw new Error(`Argumento desconocido: ${a}`);
  }
  return args;
}

const AYUDA = `
benchmark-marcadas-memory — consumo del reporte de Marcadas (SÓLO LECTURA)

  --iterations N     corridas por escenario (por defecto 3)
  --scenario NOMBRE  limitar a un escenario (repetible):
                       json-mes | json-dos-meses | json-trimestre | pdf-mes
                       json-empleado (requiere --employee)
  --employee ID      id de empleado para el escenario individual
  --out DIR          escribir DIR/marcadas-memory.json
  --env RUTA         archivo .env a usar
  --no-env           usar sólo variables del shell

Recomendado: node --expose-gc scripts/benchmark-marcadas-memory.js

Este comando mide el CAMINO REAL contra la base del servidor (mysql2,
sequelize, pdfkit, Node productivo). El test de CI, en cambio, sólo demuestra
la propiedad estructural con la base mockeada: NO mide el RSS real del API.
Ejecutar este script en el servidor, en horario de baja carga, es lo que cierra
esa brecha. Nunca lo ejecuta Claude contra producción.
`;

/**
 * Escenarios.
 *
 * El rango 2024-12-01 → 2025-01-31 es el que precedió al reinicio del 19/08 y
 * por eso está tal cual, no aproximado.
 */
function escenarios(args) {
  const lista = [
    { nombre: 'json-mes', dateFrom: '2024-12-01', dateTo: '2024-12-31' },
    { nombre: 'json-dos-meses', dateFrom: '2024-12-01', dateTo: '2025-01-31' },
    { nombre: 'json-trimestre', dateFrom: '2024-11-01', dateTo: '2025-01-31' },
    // El PDF agrega el Buffer de pdfkit encima del dataset; se mide con el
    // MISMO render que sirve la ruta, no con una copia.
    { nombre: 'pdf-mes', dateFrom: '2024-12-01', dateTo: '2024-12-31', pdf: true },
  ];
  if (args.employee) {
    lista.push({
      nombre: 'json-empleado',
      dateFrom: '2024-12-01', dateTo: '2025-01-31',
      employeeId: args.employee,
    });
  }
  if (!args.scenarios) return lista;
  return lista.filter((e) => args.scenarios.includes(e.nombre));
}

/**
 * Renderiza el PDF a un sink que descarta, devolviendo los bytes producidos.
 *
 * Mide el camino real —el mismo `renderMarcadasPdf` de la ruta— sin escribir a
 * disco ni a la red. Los Buffer de pdfkit viven en `external`, por eso ese
 * campo importa para el PDF aunque el heap no se mueva.
 */
function renderPdfADescarte(report, esc) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line global-require
    const PDFDocument = require('pdfkit');
    let bytes = 0;
    const sink = new Writable({ write(chunk, _enc, cb) { bytes += chunk.length; cb(); } });
    sink.on('error', reject);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.on('error', reject);
    doc.pipe(sink);
    sink.on('finish', () => resolve(bytes));
    renderMarcadasPdf(doc, { data: report.data, from: esc.dateFrom, to: esc.dateTo });
  });
}

/** Fuerza recolección si el proceso corre con --expose-gc. */
function recolectar() {
  if (typeof global.gc === 'function') {
    global.gc();
    return true;
  }
  return false;
}

/**
 * Muestra de memoria.
 *
 * Se informan las cuatro métricas porque dicen cosas distintas: `rss` es lo que
 * mira PM2 para reiniciar, `heapUsed` es lo que el GC puede liberar,
 * `heapTotal` es lo que V8 le pidió al sistema, y `external` cubre los Buffer
 * —que es donde vive un PDF y donde el heap no lo mostraría.
 */
function muestra() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
}

async function correrEscenario(esc, iteraciones) {
  const corridas = [];
  let picoRss = 0;

  for (let i = 0; i < iteraciones; i++) {
    recolectar();
    // Un respiro para que el GC asíncrono termine antes de la línea base.
    await new Promise((r) => setTimeout(r, 150));
    const antes = muestra();

    const t0 = Date.now();
    let filas = 0;
    let bytesRespuesta = 0;
    let error = null;
    try {
      const out = await generateMarcadasReport({ dateFrom: esc.dateFrom, dateTo: esc.dateTo, employeeId: esc.employeeId });
      filas = out.data.reduce((acc, e) => acc + e.rows.length, 0);
      if (esc.pdf) {
        // Camino PDF: además del dataset, el render y su Buffer.
        bytesRespuesta = await renderPdfADescarte(out, esc);
      } else {
        // Tamaño real de lo que viajaría por la red, que es parte del costo.
        bytesRespuesta = Buffer.byteLength(JSON.stringify(out));
      }
    } catch (err) {
      error = err.message;
    }
    const ms = Date.now() - t0;

    const pico = muestra();
    if (pico.rss > picoRss) picoRss = pico.rss;

    recolectar();
    await new Promise((r) => setTimeout(r, 150));
    const despues = muestra();

    corridas.push({
      iteracion: i + 1,
      ms,
      filas,
      bytes_respuesta: bytesRespuesta,
      error,
      rss_antes: antes.rss,
      rss_pico: pico.rss,
      rss_despues: despues.rss,
      heap_usado_pico: pico.heapUsed,
      heap_total_pico: pico.heapTotal,
      external_pico: pico.external,
      // Lo que NO se liberó: la señal de retención.
      retenido: despues.heapUsed - antes.heapUsed,
    });

    console.log(
      `  ${String(i + 1).padStart(2)}/${iteraciones}  `
      + `${String(ms).padStart(6)} ms  `
      + `rss ${mb(antes.rss).padStart(7)} → pico ${mb(pico.rss).padStart(7)} → ${mb(despues.rss).padStart(7)} MB  `
      + `heap pico ${mb(pico.heapUsed).padStart(7)} MB  `
      + `retenido ${mb(despues.heapUsed - antes.heapUsed).padStart(7)} MB  `
      + `${filas} filas${error ? `  ERROR: ${error}` : ''}`,
    );
  }

  const primera = corridas[0];
  const ultima = corridas[corridas.length - 1];
  return {
    escenario: esc.nombre,
    periodo: `${esc.dateFrom}..${esc.dateTo}`,
    iteraciones,
    corridas,
    rss_pico: picoRss,
    // Crecimiento entre la primera y la última corrida en reposo: si es
    // sustancial y consistente, hay retención entre peticiones.
    crecimiento_rss: ultima.rss_despues - primera.rss_despues,
    supera_limite_pm2: picoRss > 536870912,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(AYUDA); return; }

  console.log('─'.repeat(78));
  console.log('BENCHMARK DE MEMORIA — reporte de Marcadas (sólo lectura)');
  console.log(`Entorno    : ${ENV.modo === 'archivo' ? ENV.archivo : 'variables del shell'}`);
  console.log(`Iteraciones: ${args.iterations}`);
  console.log(`GC forzado : ${typeof global.gc === 'function' ? 'sí' : 'NO — correr con --expose-gc para mejor señal'}`);
  console.log(`Límite PM2 : 536870912 bytes (512,0 MB)`);
  console.log('─'.repeat(78));

  const lista = escenarios(args);
  if (!lista.length) throw new Error('Ningún escenario coincide con --scenario');

  const resultados = [];
  for (const esc of lista) {
    console.log(`\n▸ ${esc.nombre}  (${esc.dateFrom} .. ${esc.dateTo})`);
    resultados.push(await correrEscenario(esc, args.iterations));
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log('RESUMEN');
  console.log('─'.repeat(78));
  for (const r of resultados) {
    console.log(
      `${r.escenario.padEnd(22)} pico RSS ${mb(r.rss_pico).padStart(8)} MB  `
      + `crecimiento ${mb(r.crecimiento_rss).padStart(7)} MB  `
      + `${r.supera_limite_pm2 ? '⚠ SUPERA EL LÍMITE DE PM2' : 'dentro del límite'}`,
    );
  }

  const algunoSupera = resultados.some((r) => r.supera_limite_pm2);
  // 32 MB de margen: por debajo de eso el ruido del GC domina y llamarlo
  // "crecimiento" sería leer una señal que no está.
  const algunoCrece = resultados.some((r) => r.crecimiento_rss > 32 * MB);

  console.log('');
  if (algunoSupera) console.log('✖ Al menos un escenario supera los 512 MB: NO-GO.');
  if (algunoCrece) console.log('✖ Crecimiento acumulativo entre corridas: hay retención. NO-GO.');
  if (!algunoSupera && !algunoCrece) console.log('✓ Dentro del límite y sin crecimiento acumulativo apreciable.');
  console.log('');
  console.log('Recordatorio: subir max_memory_restart no es una solución. Si un');
  console.log('escenario supera el límite, la forma de leer sigue estando mal.');

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    const destino = path.join(args.out, 'marcadas-memory.json');
    fs.writeFileSync(destino, JSON.stringify({
      generado: new Date().toISOString(),
      node: process.version,
      gc_expuesto: typeof global.gc === 'function',
      limite_pm2_bytes: 536870912,
      resultados,
    }, null, 2));
    console.log(`\nDetalle escrito en ${destino}`);
  }

  process.exitCode = (algunoSupera || algunoCrece) ? 1 : 0;
}

main()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error(`\n✖ ${err.message}`);
    try { await sequelize.close(); } catch { /* la conexión ya podía estar caída */ }
    process.exitCode = 1;
  });
