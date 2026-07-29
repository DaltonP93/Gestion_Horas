#!/usr/bin/env node
/**
 * inspect-css-preload.js — Inspecciona el HTML PRERENDERIZADO del build de Next
 * (.next/server/app/**.html) y FALLA (exit 1) si encuentra un preload de CSS
 * en el documento, p.ej. <link rel="preload" as="style" href="....css">.
 *
 * El build de Next 16 entrega el CSS como <link rel="stylesheet">; no debe haber
 * preloads de CSS en el HTML. Este chequeo evita que se reintroduzca un preload
 * manual/incorrecto que dispare el warning de Chrome "preloaded but not used".
 *
 * Uso (después de `npm run build`):
 *   node scripts/inspect-css-preload.js
 */
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', '.next', 'server', 'app');
const PRELOAD_CSS = /<link[^>]*rel=["']preload["'][^>]*>/gi;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

function isCssStylePreload(tag) {
  const isPreload = /rel=["']preload["']/i.test(tag);
  const asStyle = /as=["']style["']/i.test(tag);
  const hrefCss = /href=["'][^"']*\.css[^"']*["']/i.test(tag);
  return isPreload && (asStyle || hrefCss);
}

const files = walk(APP_DIR);
if (!files.length) {
  console.error('inspect-css-preload: no se encontró HTML prerenderizado. Corré `npm run build` primero.');
  process.exit(2);
}

const offenders = [];
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const tags = html.match(PRELOAD_CSS) || [];
  for (const t of tags) if (isCssStylePreload(t)) offenders.push({ file: path.relative(process.cwd(), f), tag: t });
}

if (offenders.length) {
  console.error(`✗ Se encontraron ${offenders.length} preload(s) de CSS en el HTML (no debería haber):`);
  for (const o of offenders.slice(0, 20)) console.error(`  ${o.file}\n    ${o.tag}`);
  process.exit(1);
}

console.log(`✓ ${files.length} HTML prerenderizados revisados: sin preloads de CSS en el documento.`);
