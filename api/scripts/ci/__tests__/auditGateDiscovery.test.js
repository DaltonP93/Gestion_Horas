'use strict';

/**
 * auditGateDiscovery.test.js — REPRODUCCIONES que fallan sobre
 * b1f13fe23ce19805985b1635e2712a2b8b6c4236 (HEAD de #245 antes de este endurecimiento).
 *
 * Cuatro huecos del descubrimiento/autenticación y de la forma de fixAvailable:
 *   1. Copia anidada BAJO la propia carpeta braces
 *      (node_modules/braces/node_modules/consumer/node_modules/braces) con la guarda
 *      de compile eliminada: el recorrido se detiene en la primera carpeta braces y
 *      la aprueba.
 *   2. Copia bajo node_modules/consumer/node_modules/braces cuyo package.json carece
 *      de `name`: Node puede cargarla, pero el verificador la omite.
 *   3. Copia anidada con las siete huellas intactas pero `main` apuntando a otro
 *      archivo (acepta AST profundo): el verificador aprueba porque no autentica la
 *      entrada realmente resuelta y sólo prueba el comportamiento de la copia raíz.
 *   4. fixAvailable nulo, ausente, con name/version vacíos o versión inválida: pasa.
 *
 * En b1f13fe estos tests FALLAN; tras el endurecimiento, PASAN.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate, verifyBracesPatch } = require('../audit-gate');

const FP = require('../braces-patch-fingerprints.json');
const now = new Date('2026-10-02T00:00:00Z');

const API_NM = path.resolve(__dirname, '..', '..', '..', 'node_modules');
const SRC_BRACES = path.join(API_NM, 'braces');
const DEP_CLOSURE = ['fill-range', 'to-regex-range', 'is-number'];

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'braces-disc-'));
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  for (const d of DEP_CLOSURE) fs.cpSync(path.join(API_NM, d), path.join(root, 'node_modules', d), { recursive: true });
  return root;
}
function putBraces(root, relUnderRoot) {
  const dst = path.join(root, relUnderRoot);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(SRC_BRACES, dst, { recursive: true });
  return dst;
}
function removeCompileGuard(bracesDir) {
  const cf = path.join(bracesDir, 'lib', 'compile.js');
  const b = fs.readFileSync(cf, 'utf8');
  const a = b.replace('depth > maxDepth', 'depth > 1e9');
  if (a === b) throw new Error('no se encontró el patrón de la guarda de compile');
  fs.writeFileSync(cf, a);
}

describe('REPRO b1f13fe #1 — copia anidada bajo braces/node_modules no se recorre', () => {
  let root;
  beforeAll(() => {
    root = mkRoot();
    putBraces(root, 'node_modules/braces');
    const deep = putBraces(root, path.join('node_modules', 'braces', 'node_modules', 'consumer', 'node_modules', 'braces'));
    removeCompileGuard(deep);
  });
  test('el gate debe RECHAZAR (copia anidada con la guarda de compile eliminada)', () => {
    expect(verifyBracesPatch(root, FP).ok).toBe(false);
  });
});

describe('REPRO b1f13fe #2 — manifiesto sin name se omite', () => {
  let root;
  beforeAll(() => {
    root = mkRoot();
    putBraces(root, 'node_modules/braces');
    const c = putBraces(root, path.join('node_modules', 'consumer', 'node_modules', 'braces'));
    const pjp = path.join(c, 'package.json');
    const pj = JSON.parse(fs.readFileSync(pjp, 'utf8'));
    delete pj.name;
    fs.writeFileSync(pjp, JSON.stringify(pj, null, 2));
  });
  test('el gate debe RECHAZAR (manifiesto inválido: carece de name)', () => {
    expect(verifyBracesPatch(root, FP).ok).toBe(false);
  });
});

describe('REPRO b1f13fe #3 — main apunta a otro archivo; sólo se prueba la copia raíz', () => {
  let root; let consumerBraces;
  beforeAll(() => {
    root = mkRoot();
    putBraces(root, 'node_modules/braces');
    consumerBraces = putBraces(root, path.join('node_modules', 'consumer', 'node_modules', 'braces'));
    // 7 huellas intactas; se añade evil.js permisivo y main lo apunta.
    fs.writeFileSync(path.join(consumerBraces, 'evil.js'), 'const f=(i)=>[].concat(i);f.expand=(i)=>[].concat(i);f.compile=()=>"x";module.exports=f;\n');
    const pjp = path.join(consumerBraces, 'package.json');
    const pj = JSON.parse(fs.readFileSync(pjp, 'utf8'));
    pj.main = 'evil.js';
    fs.writeFileSync(pjp, JSON.stringify(pj, null, 2));
  });
  test('la copia anidada resuelve su entrada a evil.js (no index.js)', () => {
    expect(path.basename(require.resolve(consumerBraces))).toBe('evil.js');
  });
  test('el gate debe RECHAZAR (entrada realmente resuelta no autenticada)', () => {
    expect(verifyBracesPatch(root, FP).ok).toBe(false);
  });
});

describe('REPRO b1f13fe #4 — forma de fixAvailable', () => {
  const NF_GHSA = 'GHSA-86w9-cpqp-85rv';
  const NF_URL = `https://github.com/advisories/${NF_GHSA}`;
  const NF_EXC = [{ ghsa: NF_GHSA, cve: 'CVE-2026-85393', package: 'node-forge', version: '1.4.0', affectedRange: '<=1.4.0', severity: 'high', url: NF_URL, expires: '2026-11-01' }];
  const BR_GHSA = 'GHSA-vfj7-8cjw-p6xm';
  const BR_URL = `https://github.com/advisories/${BR_GHSA}`;
  const BR_EXC = [{ ghsa: BR_GHSA, cve: 'CVE-2026-93687', package: 'braces', version: '3.0.3', affectedRange: '<=3.0.3', severity: 'high', url: BR_URL, patch: { verify: 'braces-patch-fingerprint' }, acceptTransitiveMajorFix: true, expires: '2026-10-18' }];
  const mkAudit = (pkg, url, range, fixAvailable) => ({
    vulnerabilities: { [pkg]: { name: pkg, severity: 'high', via: [{ source: 1, name: pkg, dependency: pkg, title: 't', url, severity: 'high', range }], range: '*', nodes: [`node_modules/${pkg}`], fixAvailable } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  });
  const nfInst = { 'node-forge': '1.4.0' };
  const brInst = { braces: '3.0.3' };
  const patchOK = { braces: { ok: true } };

  test('#4a fixAvailable null → falla (sólo false significa sin fix)', () => {
    expect(evaluate(mkAudit('node-forge', NF_URL, '<=1.4.0', null), NF_EXC, { now, installedVersions: nfInst }).ok).toBe(false);
  });
  test('#4b fixAvailable ausente → falla', () => {
    expect(evaluate(mkAudit('node-forge', NF_URL, '<=1.4.0', undefined), NF_EXC, { now, installedVersions: nfInst }).ok).toBe(false);
  });
  test('#4c fixAvailable con name/version vacíos → falla', () => {
    expect(evaluate(mkAudit('braces', BR_URL, '<=3.0.3', { name: '', version: '', isSemVerMajor: true }), BR_EXC, { now, installedVersions: brInst, patchVerification: patchOK }).ok).toBe(false);
  });
  test('#4d fixAvailable con versión inválida → falla', () => {
    expect(evaluate(mkAudit('braces', BR_URL, '<=3.0.3', { name: 'tailwindcss', version: 'not-a-version', isSemVerMajor: true }), BR_EXC, { now, installedVersions: brInst, patchVerification: patchOK }).ok).toBe(false);
  });
});
