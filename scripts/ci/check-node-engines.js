#!/usr/bin/env node
'use strict';

/**
 * check-node-engines.js — [Baseline Node 22] Verificación EXPLÍCITA de que TODAS
 * las dependencias RUNTIME (no `dev`) declaradas en un package-lock.json tengan
 * `engines.node` compatibles con la versión de Node en ejecución.
 *
 * Complementa a `npm ci` con `engine-strict=true` (que ya aborta la instalación
 * ante un engine incompatible): este guard deja EVIDENCIA legible en el log de CI
 * de qué dependencia transitiva exige qué versión de Node, y falla el job si
 * alguna dependencia runtime no es satisfecha por el Node actual.
 *
 * Uso:  node scripts/ci/check-node-engines.js <dir-del-app>
 *       (el <dir-del-app> debe contener package-lock.json y node_modules tras npm ci)
 *
 * NO instala nada, NO modifica archivos: sólo lee el lock y evalúa engines.
 */

const fs = require('fs');
const path = require('path');

const appDir = path.resolve(process.argv[2] || '.');
const lockPath = path.join(appDir, 'package-lock.json');

let semver;
try {
  semver = require(require.resolve('semver', { paths: [path.join(appDir, 'node_modules')] }));
} catch (_e) {
  console.error(`[check-node-engines] no se pudo resolver 'semver' desde ${appDir}/node_modules — ¿corriste npm ci?`);
  process.exit(2);
}

let lock;
try {
  lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
} catch (_e) {
  console.error(`[check-node-engines] no se pudo leer ${lockPath}`);
  process.exit(2);
}

const nodeVer = process.versions.node;
const pkgs = lock.packages || {};
const bad = [];
let runtimeWithEngines = 0;

for (const [name, meta] of Object.entries(pkgs)) {
  if (!meta || meta.dev === true) continue;                 // sólo dependencias RUNTIME (no dev)
  // Igual que npm con engine-strict: las dependencias OPCIONALES (p.ej. los
  // binarios de plataforma de `sharp`, `os`/`cpu` ajenos) NO se instalan en esta
  // plataforma y NO deben imponer su engine. Se omiten.
  if (meta.optional === true) continue;
  const range = meta.engines && meta.engines.node;
  if (!range) continue;
  runtimeWithEngines += 1;
  let ok = true;
  try { ok = semver.satisfies(nodeVer, range, { includePrerelease: true }); } catch (_e) { ok = true; }
  if (!ok) bad.push(`${name || '(root)'}  engines.node=${JSON.stringify(range)}`);
}

if (bad.length) {
  console.error(`[check-node-engines] Node ${nodeVer} NO satisface engines de ${bad.length} dependencia(s) RUNTIME en ${path.relative(process.cwd(), lockPath)}:`);
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}

console.log(`[check-node-engines] OK: Node ${nodeVer} satisface engines de las ${runtimeWithEngines} dependencia(s) runtime con engines declarados en ${path.relative(process.cwd(), lockPath)}`);
