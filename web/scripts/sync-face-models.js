#!/usr/bin/env node
/**
 * sync-face-models.js — copia los pesos de face-api desde node_modules a
 * `public/face-models`.
 *
 * Motivo: la versión anterior de FaceEnroll pedía los modelos a
 * `.../@vladmandic/face-api@X/dist/models`, y ahí no están: el paquete los
 * publica en `model/` (singular), fuera de `dist/`. El CDN devolvía 404 y el
 * enrolamiento no funcionaba nunca. Además dependía de una red externa en
 * tiempo de ejecución.
 *
 * Los pesos NO se versionan: se generan desde la misma dependencia exacta que
 * se instala, así que el JavaScript y los modelos siempre son de la misma
 * versión. Mezclar versiones entre ambos produce fallos sutiles de precisión.
 *
 * Si falta cualquiera de los archivos el proceso termina con código 1 y dice
 * exactamente cuál. Nunca se silencia: un build "exitoso" sin modelos deja la
 * función rota en producción, que es justo lo que pasaba.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT   = path.resolve(__dirname, '..');
const SRC    = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api', 'model');
const DEST   = path.join(ROOT, 'public', 'face-models');

/** Lo que FaceEnroll carga: TinyFaceDetector + FaceRecognitionNet + landmarks tiny. */
const REQUIRED = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
  'face_landmark_68_tiny_model-weights_manifest.json',
  'face_landmark_68_tiny_model.bin',
];

function fail(msg) {
  console.error(`\n[sync-face-models] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(SRC)) {
  fail(
    `No se encontró ${path.relative(ROOT, SRC)}.\n` +
    'Instalá las dependencias con `npm ci` antes de compilar.'
  );
}

fs.mkdirSync(DEST, { recursive: true });

const missing = [];
let copied = 0;

for (const name of REQUIRED) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) { missing.push(name); continue; }

  const to = path.join(DEST, name);
  // El manifiesto referencia al .bin por nombre: si uno se copia y el otro no,
  // el navegador falla al resolver los pesos. Por eso se valida el set completo
  // antes de dar el proceso por bueno.
  fs.copyFileSync(from, to);
  copied += 1;
}

if (missing.length) {
  fail(
    `Faltan ${missing.length} archivo(s) de modelo en el paquete instalado:\n` +
    missing.map(m => `  - ${m}`).join('\n') +
    '\nRevisá la versión de @vladmandic/face-api en package.json.'
  );
}

// Un .bin de 0 bytes pasaría el existsSync y rompería recién en el navegador.
for (const name of REQUIRED) {
  const size = fs.statSync(path.join(DEST, name)).size;
  if (!size) fail(`${name} quedó vacío al copiarse.`);
}

console.log(`[sync-face-models] ${copied} archivo(s) en public/face-models`);
