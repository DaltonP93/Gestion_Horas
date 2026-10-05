'use strict';

/**
 * eval.js — evaluación reproducible del parche braces (CVE-2026-93687 /
 * GHSA-vfj7-8cjw-p6xm). Node 22. NO instala nada: recibe DOS instalaciones
 * aisladas ya preparadas (ver README.md), cada una con `node_modules/braces`:
 *   - "stock"   : braces@3.0.3 publicado.
 *   - "patched" : PR micromatch/braces #72 fijado en el commit completo
 *                 28d440b5dd449dbf1fe6f3506cf94ecca4d02660 (instalado con
 *                 --ignore-scripts).
 *
 * Uso (rutas sin hardcodear):
 *   BRACES_STOCK=<dir> BRACES_PATCHED=<dir> node eval.js
 *   node eval.js <dir_stock> <dir_patched>
 * Cada <dir> es la carpeta que contiene `node_modules/braces`.
 *
 * Convierte los resultados esperados en ASERCIONES: cualquier incumplimiento
 * termina con exit 1. Incluye un CONTROL NEGATIVO (usa el stock como supuesto
 * parche) que debe FALLAR por aceptar profundidades que un parche debería
 * rechazar; si el control no falla, también termina con exit 1.
 */

const path = require('node:path');

const STOCK = process.env.BRACES_STOCK || process.argv[2];
const PATCHED = process.env.BRACES_PATCHED || process.argv[3];
if (!STOCK || !PATCHED) {
  console.error('Uso: BRACES_STOCK=<dir> BRACES_PATCHED=<dir> node eval.js   (o: node eval.js <stock> <patched>)');
  console.error('Cada <dir> contiene node_modules/braces. Ver README.md.');
  process.exit(2);
}

const loadBraces = (dir) => require(path.resolve(dir, 'node_modules', 'braces'));
const pkgVersion = (dir) => {
  try { return require(path.resolve(dir, 'node_modules', 'braces', 'package.json')).version; } catch (_e) { return '?'; }
};
const stock = loadBraces(STOCK);
const patched = loadBraces(PATCHED);

const call = (fn) => { try { return { ok: true, val: fn() }; } catch (e) { return { ok: false, err: `${e.name}: ${String(e.message).slice(0, 60)}` }; } };
const nest = (d) => '{a,'.repeat(d) + 'z' + '}'.repeat(d);
const parens = (d) => '!('.repeat(d) + 'x' + ')'.repeat(d);
function deepAst(d) {
  let n = { type: 'text', value: 'x' };
  for (let i = 0; i < d; i += 1) n = { type: 'brace', nodes: [{ type: 'brace.open', value: '{' }, { type: 'text', value: 'a' }, n, { type: 'brace.close', value: '}' }] };
  return { type: 'root', nodes: [n] };
}

const VALID = ['foo/{a,b}/bar', 'a{b,c}d', '{1..5}', '{01..10}', '{0..10..2}', '{a,{b,c}}', '{a,b}{c,d}', 'x{{a,b},{c,d}}y', '!(foo|bar)', '@(a|b)', 'foo'];

/**
 * Comprobaciones del "comportamiento corregido esperado" para `impl`, usando
 * `ref` (stock) como referencia de salida válida. Cada una es {id, pass, detail}.
 */
function fixedBehaviorChecks(impl, ref) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });

  // A. Controles VÁLIDOS: impl debe producir la MISMA expansión que la referencia.
  for (const p of VALID) {
    const a = call(() => JSON.stringify(ref.expand(p)));
    const b = call(() => JSON.stringify(impl.expand(p)));
    add(`A.valido ${JSON.stringify(p)}`, a.ok && b.ok && a.val === b.val, `${a.val || a.err} | ${b.val || b.err}`);
  }
  // B. Profundidad por parseo (string): dentro del límite acepta; sobre el límite rechaza.
  add('B.depth100.acepta', call(() => impl(nest(100))).ok === true, 'nest(100)');
  add('B.depth101.rechaza', call(() => impl(nest(101))).ok === false, 'nest(101)');
  add('B.depth500.rechaza', call(() => impl(nest(500))).ok === false, 'nest(500)');
  // C. La opción maxDepth no puede SUPERAR el tope: sigue rechazando depth 150.
  add('C.maxDepth200.rechaza', call(() => impl(nest(150), { maxDepth: 200 })).ok === false, '{maxDepth:200}');
  add('C.maxDepth1e5.rechaza', call(() => impl(nest(150), { maxDepth: 100000 })).ok === false, '{maxDepth:100000}');
  // D. Paréntesis anidados: dentro acepta; sobre rechaza.
  add('D.parens100.acepta', call(() => impl(parens(100))).ok === true, 'parens(100)');
  add('D.parens101.rechaza', call(() => impl(parens(101))).ok === false, 'parens(101)');
  // E. AST suministrado DIRECTAMENTE a compile (sin parse): depth 50 compila; depth 150 rechaza.
  add('E.compileAst50.acepta', call(() => impl.compile(deepAst(50))).ok === true, 'compile(AST depth 50)');
  add('E.compileAst150.rechaza', call(() => impl.compile(deepAst(150))).ok === false, 'compile(AST depth 150)');
  return checks;
}

function report(title, checks) {
  console.log(`\n## ${title}`);
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id}`);
    if (!c.pass) console.log(`        detalle: ${c.detail}`);
  }
}

console.log(`braces eval — Node ${process.version}`);
console.log(`stock  : ${STOCK}  (braces@${pkgVersion(STOCK)})`);
console.log(`patched: ${PATCHED}  (braces@${pkgVersion(PATCHED)})  [PR #72 @28d440b5dd449dbf1fe6f3506cf94ecca4d02660]`);
console.log('(ambas versiones deberían ser 3.0.3: el parche NO cambia la versión → relevante para npm audit)');

let failures = 0;

// Fase 1 — el PARCHE bajo prueba debe cumplir TODO el comportamiento corregido.
const phase1 = fixedBehaviorChecks(patched, stock);
report('Fase 1 — parche bajo prueba: debe cumplir el comportamiento corregido', phase1);
const p1fail = phase1.filter((c) => !c.pass).length;
failures += p1fail;

// Fase 2 — CONTROL NEGATIVO: el stock, usado como "supuesto parche", DEBE fallar
// los criterios de rechazo (acepta profundidades que un parche rechazaría). Si el
// stock los cumpliera, la prueba no distinguiría una implementación no corregida.
const stockAsChecks = fixedBehaviorChecks(stock, stock);
const REJECT_IDS = ['B.depth101.rechaza', 'B.depth500.rechaza', 'C.maxDepth200.rechaza', 'C.maxDepth1e5.rechaza', 'D.parens101.rechaza', 'E.compileAst150.rechaza'];
const negChecks = REJECT_IDS.map((id) => {
  const c = stockAsChecks.find((x) => x.id === id);
  // El control es correcto si el stock NO cumple el rechazo (c.pass === false).
  return { id: `NEG ${id} (el stock debe NO rechazar)`, pass: !!c && c.pass === false, detail: c ? `stock rechaza=${c.pass}` : '(ausente)' };
});
report('Fase 2 — control negativo: el stock DEBE fallar los criterios de rechazo', negChecks);
const negfail = negChecks.filter((c) => !c.pass).length;
failures += negfail;

console.log('\n## RESUMEN');
console.log(`  Fase 1 (parche cumple): ${phase1.length - p1fail}/${phase1.length} PASS`);
console.log(`  Fase 2 (control negativo): ${negChecks.length - negfail}/${negChecks.length} PASS`);
if (failures > 0) {
  console.log(`\nRESULTADO: FALLÓ (${failures} comprobación/es) -> exit 1`);
  process.exit(1);
}
console.log('\nRESULTADO: OK -> exit 0');
process.exit(0);
