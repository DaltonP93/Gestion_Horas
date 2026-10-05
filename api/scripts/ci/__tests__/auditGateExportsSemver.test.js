'use strict';

/**
 * auditGateExportsSemver.test.js — REPRODUCCIONES que fallan sobre
 * d3d2e3dd34a84ef0324eea47d039b17fcc89f676 (HEAD de #245 antes de este endurecimiento).
 *
 *   1/2. exports["."].require redirige la entrada que carga el consumidor por NOMBRE
 *        (require('braces')) a otro archivo que acepta AST profundo, conservando las 7
 *        huellas y main=index.js. El gate usa require.resolve(dir) (resolución por RUTA,
 *        que IGNORA exports) → autentica index.js y aprueba, en copia raíz y anidada.
 *   3.   fixAvailable con versiones NO-SemVer (`01.2.3`, `1.2.3-!`, `1.2.3-a..b`) pasa
 *        por una expresión regular simplificada.
 *
 * En d3d2e3d estos tests FALLAN; tras el endurecimiento, PASAN.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'braces-exp-'));
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
// Conserva las 7 huellas y main=index.js; añade exports["."].require → evil.js.
function addExportsEvil(bracesDir) {
  fs.writeFileSync(path.join(bracesDir, 'evil.js'), 'const f=(i)=>[].concat(i);f.expand=(i)=>[].concat(i);f.compile=()=>"x";module.exports=f;\n');
  const pjp = path.join(bracesDir, 'package.json');
  const pj = JSON.parse(fs.readFileSync(pjp, 'utf8'));
  pj.exports = { '.': { require: './evil.js', default: './evil.js' } };
  fs.writeFileSync(pjp, JSON.stringify(pj, null, 2));
}

describe('REPRO d3d2e3d #1 — exports redirige la entrada por nombre (copia raíz)', () => {
  let root;
  beforeAll(() => { root = mkRoot(); addExportsEvil(putBraces(root, 'node_modules/braces')); });
  test('require("braces") por nombre carga evil.js (exports) aunque main=index.js', () => {
    expect(path.basename(require.resolve('braces', { paths: [root] }))).toBe('evil.js');
  });
  test('el gate debe RECHAZAR (entrada por nombre no autenticada)', () => {
    expect(verifyBracesPatch(root, FP).ok).toBe(false);
  });
});

describe('REPRO d3d2e3d #2 — exports redirige la entrada por nombre (copia anidada)', () => {
  let root;
  beforeAll(() => {
    root = mkRoot();
    putBraces(root, 'node_modules/braces'); // raíz limpia
    addExportsEvil(putBraces(root, path.join('node_modules', 'consumer', 'node_modules', 'braces')));
  });
  test('el gate debe RECHAZAR (la copia anidada redirige su entrada por exports)', () => {
    expect(verifyBracesPatch(root, FP).ok).toBe(false);
  });
});

describe('REPRO d3d2e3d #3 — SemVer no estricto en fixAvailable', () => {
  const BR_GHSA = 'GHSA-vfj7-8cjw-p6xm';
  const BR_URL = `https://github.com/advisories/${BR_GHSA}`;
  const BR_EXC = [{ ghsa: BR_GHSA, cve: 'CVE-2026-93687', package: 'braces', version: '3.0.3', affectedRange: '<=3.0.3', severity: 'high', url: BR_URL, patch: { verify: 'braces-patch-fingerprint' }, acceptTransitiveMajorFix: true, expires: '2026-10-18' }];
  const brInst = { braces: '3.0.3' };
  const patchOK = { braces: { ok: true } };
  const mkAudit = (fixAvailable) => ({
    vulnerabilities: { braces: { name: 'braces', severity: 'high', via: [{ source: 1, name: 'braces', dependency: 'braces', title: 't', url: BR_URL, severity: 'high', range: '<=3.0.3' }], range: '*', nodes: ['node_modules/braces'], fixAvailable } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  });
  const run = (version) => evaluate(mkAudit({ name: 'tailwindcss', version, isSemVerMajor: true }), BR_EXC, { now, installedVersions: brInst, patchVerification: patchOK });

  for (const v of ['01.2.3', '1.2.3-!', '1.2.3-a..b']) {
    test(`versión NO-SemVer ${JSON.stringify(v)} → debe FALLAR`, () => {
      expect(run(v).ok).toBe(false);
    });
  }
  // Controles positivos: versiones SemVer válidas siguen tolerándose (NOTA).
  for (const v of ['4.3.3', '1.14.10', '1.2.3-beta.1']) {
    test(`control positivo: versión SemVer válida ${JSON.stringify(v)} → tolerada`, () => {
      expect(run(v).ok).toBe(true);
    });
  }
});
