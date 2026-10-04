'use strict';
const stock = require('/tmp/claude-0/-home-user-Gestion-Horas/e1349c0c-c6df-5109-b729-6d3653b7d666/scratchpad/braces-eval/node_modules/braces');
const patched = require('/tmp/claude-0/-home-user-Gestion-Horas/e1349c0c-c6df-5109-b729-6d3653b7d666/scratchpad/braces-eval/patched/node_modules/braces');
const call = (fn) => { try { return { ok: true, val: fn() }; } catch (e) { return { ok: false, err: e.name + ': ' + String(e.message).slice(0, 48) }; } };
const nest = (d) => '{a,'.repeat(d) + 'z' + '}'.repeat(d);

console.log('## A. Controles VÁLIDOS: stock vs patched (deben coincidir)');
const valid = ['foo/{a,b}/bar', 'a{b,c}d', '{1..5}', '{01..10}', '{0..10..2}', '{a,{b,c}}', '{a,b}{c,d}', 'x{{a,b},{c,d}}y', '!(foo|bar)', '@(a|b)', 'foo'];
for (const p of valid) {
  const s = call(() => JSON.stringify(stock.expand ? stock.expand(p) : braces(p)));
  const q = call(() => JSON.stringify(patched.expand(p)));
  const same = s.ok && q.ok && s.val === q.val;
  console.log(`  ${same ? 'IGUAL ' : 'DIFIERE'}  expand(${JSON.stringify(p)}) ${same ? '' : '| stock=' + (s.val||s.err) + ' patched=' + (q.val||q.err)}`);
}

console.log('\n## B. Límite de PROFUNDIDAD por parseo (string). patched MAX_DEPTH=100');
for (const d of [50, 100, 101, 500]) {
  const p = nest(d);
  const s = call(() => { stock(p); return 'acepta'; });
  const q = call(() => { patched(p); return 'acepta'; });
  console.log(`  depth=${String(d).padEnd(4)} len=${String(p.length).padEnd(5)} | stock: ${s.ok ? s.val : s.err.padEnd(0)} | patched: ${q.ok ? q.val : q.err}`);
}

console.log('\n## C. Opción maxDepth que intenta SUPERAR el límite (cap a 100)');
for (const md of [200, 100000]) {
  const p = nest(150);
  const q = call(() => { patched(p, { maxDepth: md }); return 'acepta'; });
  console.log(`  patched(depth150, {maxDepth:${md}}) -> ${q.ok ? q.val : q.err}  (se espera rechazo: cap=min(100,maxDepth))`);
}

console.log('\n## D. Paréntesis profundamente anidados (extglob) — patched cuenta parens');
for (const d of [100, 101]) {
  const p = '!('.repeat(d) + 'x' + ')'.repeat(d);
  const s = call(() => { stock(p); return 'acepta'; });
  const q = call(() => { patched(p); return 'acepta'; });
  console.log(`  parens=${String(d).padEnd(4)} len=${String(p.length).padEnd(5)} | stock: ${s.ok ? s.val : s.err} | patched: ${q.ok ? q.val : q.err}`);
}

console.log('\n## E. AST suministrado DIRECTAMENTE a compile/stringify (sin pasar por parse)');
function deepAst(d) { let node = { type: 'text', value: 'x' }; for (let i = 0; i < d; i++) node = { type: 'brace', nodes: [{ type: 'brace.open', value: '{' }, { type: 'text', value: 'a' }, node, { type: 'brace.close', value: '}' }] }; return { type: 'root', nodes: [node] }; }
for (const d of [50, 150]) {
  const ast = deepAst(d);
  const s = call(() => { stock.compile(JSON.parse(JSON.stringify(ast))); return 'compila'; });
  const q = call(() => { patched.compile(JSON.parse(JSON.stringify(ast))); return 'compila'; });
  console.log(`  compile(AST depth=${String(d).padEnd(3)}) | stock: ${s.ok ? s.val : s.err} | patched: ${q.ok ? q.val : q.err}`);
}
