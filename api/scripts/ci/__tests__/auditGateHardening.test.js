'use strict';

/**
 * auditGateHardening.test.js — REPRODUCCIONES que fallan sobre
 * 85a85100f6b2a86873b9124284b45692ebeb64c1 (HEAD de #245 antes del endurecimiento).
 *
 * Documentan tres huecos del gate de ese HEAD. En 85a8510 estos tests FALLAN
 * (el gate aprueba lo que no debería); tras el endurecimiento, PASAN.
 *
 *   1. Parche con la guarda de `compile` eliminada: el AST profundo se acepta y
 *      el gate de 85a8510 (que sólo prueba la guarda de PARSE por profundidad)
 *      sigue aprobándolo. El gate endurecido verifica huellas de TODOS los
 *      archivos + guardas de parse Y compile.
 *   2. node-forge con fixAvailable de OTRO paquete e isSemVerMajor:true: la regla
 *      base de node-forge lo RECHAZA; 85a8510 lo permite (aplicó la tolerancia de
 *      la heurística transitiva a todos los paquetes). El endurecido acota esa
 *      tolerancia al caso documentado de braces.
 *   3. fixAvailable mal formado ("unexpected" o 1): 85a8510 lo permite (no es
 *      `true` ni objeto, cae sin error). El endurecido valida estrictamente la
 *      forma de fixAvailable.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate, verifyBracesPatch } = require('../audit-gate');

const FP = require('../braces-patch-fingerprints.json');
const now = new Date('2026-10-02T00:00:00Z');

// ── #1: parche con la guarda de compile eliminada ───────────────────────────
describe('REPRO 85a8510 #1 — guarda de compile eliminada se sigue aprobando', () => {
  let tamperedRoot;
  const nest = (d) => `${'{a,'.repeat(d)}z${'}'.repeat(d)}`;
  const deepAst = (d) => { let n = { type: 'text', value: 'x' }; for (let i = 0; i < d; i += 1) n = { type: 'brace', nodes: [{ type: 'brace.open', value: '{' }, { type: 'text', value: 'a' }, n, { type: 'brace.close', value: '}' }] }; return { type: 'root', nodes: [n] }; };

  beforeAll(() => {
    const apiNm = path.resolve(__dirname, '..', '..', '..', 'node_modules');
    tamperedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'braces-tamper-'));
    const nm = path.join(tamperedRoot, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    // Copia braces + su cierre de dependencias runtime para que pueda ejecutarse.
    for (const dep of ['braces', 'fill-range', 'to-regex-range', 'is-number']) {
      fs.cpSync(path.join(apiNm, dep), path.join(nm, dep), { recursive: true });
    }
    const dst = path.join(nm, 'braces');
    // Neutraliza SÓLO la guarda de compile (parse queda intacta).
    const cf = path.join(dst, 'lib', 'compile.js');
    const before = fs.readFileSync(cf, 'utf8');
    const after = before.replace('depth > maxDepth', 'depth > 1e9');
    if (after === before) throw new Error('no se pudo neutralizar la guarda de compile (patrón no encontrado)');
    fs.writeFileSync(cf, after);
  });

  test('la copia manipulada mantiene la guarda de PARSE pero PIERDE la de COMPILE', () => {
    const braces = require(require.resolve('braces', { paths: [tamperedRoot] }));
    // parse sigue rechazando profundidad (por eso una prueba de profundidad por
    // parseo NO basta para acreditar el parche completo).
    expect(() => braces(nest(101))).toThrow(/depth/i);
    // compile YA NO rechaza el AST profundo suministrado directamente.
    expect(() => braces.compile(deepAst(150))).not.toThrow();
  });

  test('el gate endurecido RECHAZA la copia con la guarda de compile eliminada', () => {
    const r = verifyBracesPatch(tamperedRoot, FP);
    expect(r.ok).toBe(false);
  });
});

// ── #2 y #3: forma y alcance de fixAvailable ────────────────────────────────
describe('REPRO 85a8510 #2/#3 — fixAvailable: alcance y forma', () => {
  const NF_GHSA = 'GHSA-86w9-cpqp-85rv';
  const NF_URL = `https://github.com/advisories/${NF_GHSA}`;
  const NF_EXC = [{ ghsa: NF_GHSA, cve: 'CVE-2026-85393', package: 'node-forge', version: '1.4.0', affectedRange: '<=1.4.0', severity: 'high', url: NF_URL, expires: '2026-11-01' }];
  const inst = { 'node-forge': '1.4.0' };
  const auditNF = (fixAvailable) => ({
    vulnerabilities: { 'node-forge': { name: 'node-forge', severity: 'high', via: [{ source: 1, name: 'node-forge', dependency: 'node-forge', title: 't', url: NF_URL, severity: 'high', range: '<=1.4.0' }], range: '*', nodes: ['node_modules/node-forge'], fixAvailable } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  });

  test('#2 node-forge con fixAvailable major de OTRO paquete → el gate debe FALLAR (regla base de node-forge)', () => {
    const r = evaluate(auditNF({ name: 'otro', version: '9.9.9', isSemVerMajor: true }), NF_EXC, { now, installedVersions: inst });
    expect(r.ok).toBe(false);
  });

  test('#3a fixAvailable = "unexpected" (string) → el gate debe FALLAR', () => {
    const r = evaluate(auditNF('unexpected'), NF_EXC, { now, installedVersions: inst });
    expect(r.ok).toBe(false);
  });

  test('#3b fixAvailable = 1 (número) → el gate debe FALLAR', () => {
    const r = evaluate(auditNF(1), NF_EXC, { now, installedVersions: inst });
    expect(r.ok).toBe(false);
  });
});
