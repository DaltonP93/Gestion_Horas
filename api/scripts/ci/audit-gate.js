#!/usr/bin/env node
'use strict';

/**
 * audit-gate.js — gate de `npm audit` con excepciones TEMPORALES, acotadas y
 * vencibles. Reemplaza a `npm audit --audit-level=high`. Por defecto audita el
 * API; con `--root <dir> --exceptions <file>` el MISMO evaluador sirve a Bridge y
 * Web, cada uno con su propio archivo de excepciones:
 *   - API : node-forge (GHSA-86w9-cpqp-85rv) + braces (GHSA-vfj7-8cjw-p6xm)
 *   - Bridge / Web : SÓLO braces (GHSA-vfj7-8cjw-p6xm)
 *
 * Mantiene el nivel alto/crítico y además:
 *   - tolera EXACTAMENTE los advisories declarados en el archivo de excepciones;
 *   - falla ante cualquier otro high/critical;
 *   - falla si hay más advisories permitidos que excepciones declaradas;
 *   - falla si cambia paquete, URL/GHSA, severidad, rango o versión instalada;
 *   - falla si aparece una versión corregida del propio paquete (o un fix NO-mayor);
 *     un salto semver-MAJOR de OTRO paquete (heurística transitiva de npm) se tolera
 *     con NOTA y NO limpia el aviso;
 *   - falla si la excepción exige un parche y éste NO está aplicado/verificado sobre
 *     la instalación real: braces se verifica por HUELLAS SHA-256 de la revisión fija
 *     aprobada sobre TODAS las copias (incl. anidadas) + guardas de parse Y compile;
 *   - valida estrictamente la forma de `fixAvailable` y acota la tolerancia de la
 *     heurística transitiva (salto semver-MAJOR de otro paquete) a la excepción que lo
 *     declara (`acceptTransitiveMajorFix`), nunca a node-forge;
 *   - falla si la excepción venció (fecha `expires`);
 *   - falla si el advisory DESAPARECE (hay que retirar la excepción y volver a
 *     `npm audit --audit-level=high`).
 *
 * Excepciones = ACEPTACIÓN TEMPORAL DEL RIESGO: no eliminan el aviso de npm audit.
 *   - node-forge: la función vulnerable (cert.publicKey.verify) ya NO se usa en
 *     producción; la verificación real la hace node:crypto/OpenSSL.
 *   - braces: parcheado con PR micromatch/braces #72 (overrides → git), que agrega
 *     guardas de profundidad; el paquete sigue reportando 3.0.3, así que npm audit
 *     sigue marcando el aviso mientras no exista una versión publicada > 3.0.3.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HIGH = new Set(['high', 'critical']);
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
// SemVer 2.0.0 estricto (semver.org): sin ceros a la izquierda, prerelease/build con
// identificadores válidos y no vacíos. Rechaza 01.2.3, 1.2.3-!, 1.2.3-a..b, etc.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const SEV = new Set(SEVERITIES);

function ghsaFromUrl(url) {
  const m = String(url || '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : null;
}

/** `YYYY-MM-DD` real (rechaza '2026-13-40', 'pronto', etc.). */
function isCanonicalDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Advisories (via[] con objeto y URL) alcanzables desde una vulnerabilidad,
 * resolviendo las referencias transitivas (via = nombre de otro paquete del
 * informe). `seen` evita ciclos.
 */
function reachableAdvisories(name, vulns, seen) {
  if (seen.has(name)) return [];
  seen.add(name);
  const v = vulns[name];
  const via = v && Array.isArray(v.via) ? v.via : [];
  const out = [];
  for (const ref of via) {
    if (typeof ref === 'string') {
      if (ref !== name && vulns[ref]) out.push(...reachableAdvisories(ref, vulns, seen));
    } else if (ref && typeof ref === 'object' && ref.url) {
      out.push(ref);
    }
  }
  return out;
}

/**
 * Evalúa un reporte de npm audit contra las excepciones. PURA (testeable).
 * Antes de aplicar la excepción valida la INTEGRIDAD del informe: sin objeto
 * `error`, con `vulnerabilities`, contadores de metadata coherentes, todas las
 * referencias `via` resolubles y toda vulnerabilidad high/critical explicada por
 * al menos un advisory identificado (con URL). Nada se amplía ni se ignora.
 * @returns {{ok:boolean, errors:string[], allowed:string[]}}
 */
function evaluate(audit, exceptions, { now = new Date(), installedVersions = {}, patchVerification = {} } = {}) {
  const errors = [];
  const notes = [];
  const nowDate = now instanceof Date ? now : new Date(now);

  // 0) Las fechas de vencimiento declaradas deben ser válidas (independiente del informe).
  for (const e of exceptions) {
    if (!isCanonicalDate(e.expires)) {
      errors.push(`La excepción ${e.ghsa || e.package} tiene una fecha de vencimiento inválida: ${JSON.stringify(e.expires)} (se espera YYYY-MM-DD).`);
    }
  }

  // 1) Integridad básica del informe.
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    errors.push('Informe de npm audit inválido (no es un objeto).');
    return { ok: false, errors, allowed: [] };
  }
  if (audit.error) {
    const detail = typeof audit.error === 'object' ? (audit.error.summary || audit.error.code || JSON.stringify(audit.error)) : String(audit.error);
    errors.push(`npm audit reportó un error de ejecución: ${detail}. No se evalúa la excepción sobre un informe incompleto.`);
    return { ok: false, errors, allowed: [] };
  }
  const vulns = audit.vulnerabilities;
  if (!vulns || typeof vulns !== 'object' || Array.isArray(vulns)) {
    errors.push('El informe no contiene el mapa "vulnerabilities".');
    return { ok: false, errors, allowed: [] };
  }

  // 2) Contadores de metadata coherentes con lo observado.
  const derived = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, v] of Object.entries(vulns)) {
    const sev = v && v.severity;
    if (!SEV.has(sev)) { errors.push(`Vulnerabilidad ${name} con severidad desconocida: ${JSON.stringify(sev)}.`); continue; }
    derived[sev] += 1; derived.total += 1;
  }
  const meta = audit.metadata && audit.metadata.vulnerabilities;
  if (!meta || typeof meta !== 'object') {
    errors.push('El informe no trae metadata.vulnerabilities para contrastar contadores.');
  } else {
    for (const sev of [...SEVERITIES, 'total']) {
      if (Number(meta[sev]) !== derived[sev]) {
        errors.push(`Contador incoherente para "${sev}": metadata=${meta[sev]} vs observado=${derived[sev]}.`);
      }
    }
  }

  // 3) Toda referencia `via` debe ser resoluble y todo advisory debe estar identificado (URL).
  for (const [name, v] of Object.entries(vulns)) {
    const via = v && Array.isArray(v.via) ? v.via : null;
    if (!via || via.length === 0) { errors.push(`La vulnerabilidad ${name} no declara "via" (informe incompleto).`); continue; }
    for (const ref of via) {
      if (typeof ref === 'string') {
        if (ref !== name && !vulns[ref]) errors.push(`Referencia via transitiva no resoluble en ${name}: "${ref}" no está en el informe.`);
      } else if (ref && typeof ref === 'object') {
        // Se validan los campos del advisory ANTES de filtrar por severidad: un
        // advisory sin URL o sin severidad conocida no puede desaparecer en
        // silencio (dejaría pasar la vulnerabilidad que explica).
        if (!ref.url) errors.push(`Advisory sin URL identificable en ${name} (title=${JSON.stringify(ref.title)}).`);
        if (!SEV.has(ref.severity)) errors.push(`Advisory en ${name} con severidad ausente o desconocida: ${JSON.stringify(ref.severity)}.`);
      } else {
        errors.push(`Entrada "via" inválida en ${name}: ${JSON.stringify(ref)}.`);
      }
    }
  }

  // 4) Toda vulnerabilidad high/critical debe quedar explicada por ≥1 advisory
  // identificado DE SEVERIDAD COMPATIBLE (high/critical). No basta con alcanzar
  // cualquier objeto con URL: un advisory de severidad menor (o sin severidad)
  // no explica un high/critical.
  for (const [name, v] of Object.entries(vulns)) {
    if (!HIGH.has(v && v.severity)) continue;
    const reached = reachableAdvisories(name, vulns, new Set());
    if (!reached.some((a) => HIGH.has(a.severity))) {
      errors.push(`La vulnerabilidad high/critical ${name} no está explicada por ningún advisory high/critical identificado.`);
    }
  }

  // 5) Advisories high/critical DISTINTOS (objetos con URL) y su contraste con las excepciones.
  const advObjs = [];
  const seenKey = new Set();
  for (const [name, v] of Object.entries(vulns)) {
    const via = v && Array.isArray(v.via) ? v.via : [];
    for (const ref of via) {
      if (!ref || typeof ref !== 'object' || !ref.url || !HIGH.has(ref.severity)) continue;
      const pkg = ref.name || name;
      const key = `${ref.url}|${pkg}|${ref.severity}|${ref.range}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      advObjs.push({ package: pkg, url: ref.url, ghsa: ghsaFromUrl(ref.url), severity: ref.severity, range: ref.range, fixAvailable: v.fixAvailable });
    }
  }

  const allowed = [];
  for (const a of advObjs) {
    const exc = exceptions.find((e) => e.ghsa === a.ghsa && e.package === a.package);
    if (!exc) {
      errors.push(`Advisory high/critical NO permitido: ${a.package} ${a.ghsa || a.url} (${a.severity}).`);
      continue;
    }
    if (exc.url !== a.url) errors.push(`URL del advisory ${a.ghsa} distinta de la declarada (${a.url} ≠ ${exc.url}).`);
    if (exc.severity !== a.severity) errors.push(`Severidad de ${a.ghsa} distinta de la declarada (${a.severity} ≠ ${exc.severity}).`);
    if (exc.affectedRange !== a.range) errors.push(`Rango afectado de ${a.ghsa} distinto del declarado (${a.range} ≠ ${exc.affectedRange}).`);
    const installed = installedVersions[a.package];
    if (!installed) errors.push(`No se pudo determinar la versión instalada de ${a.package}.`);
    else if (installed !== exc.version) errors.push(`Versión instalada de ${a.package} (${installed}) distinta de la declarada (${exc.version}).`);
    // fixAvailable: la FORMA se valida estrictamente (sólo `false`/`true`/ el objeto
    // canónico de npm {name,version,isSemVerMajor}); cualquier otra cosa (string,
    // número, objeto mal formado) hace fallar el gate. Un fix PUBLICADO del paquete
    // excepcionado (`true`, o un objeto cuyo `name` es el propio paquete) obliga a
    // retirar la excepción; un fix NO-mayor de OTRO paquete también. SÓLO se tolera
    // (dejando NOTA) un salto semver-MAJOR de OTRO paquete, y SÓLO si la excepción lo
    // declara explícitamente (`acceptTransitiveMajorFix: true`): es la heurística
    // transitiva de npm (p.ej. nodemon/tailwindcss), no una versión corregida de este
    // paquete, y adoptarlo queda fuera del alcance autorizado. node-forge NO declara
    // esa tolerancia, así que para él CUALQUIER fixAvailable sigue fallando (regla base).
    const fa = a.fixAvailable;
    // Forma estricta: SÓLO `false` representa "sin fix". El objeto de npm debe traer
    // name no vacío, version semver válida y booleano isSemVerMajor. Cualquier otra
    // cosa (undefined, null, número, string, objeto incompleto o con campos vacíos/
    // inválidos) hace fallar el gate.
    const isNonEmptyStr = (s) => typeof s === 'string' && s.trim().length > 0;
    const isValidVersion = (v) => typeof v === 'string' && SEMVER_RE.test(v);
    const faIsCanonicalObject = fa && typeof fa === 'object' && !Array.isArray(fa)
      && isNonEmptyStr(fa.name) && isValidVersion(fa.version) && typeof fa.isSemVerMajor === 'boolean';
    if (fa === false) {
      // sin fix: nada que objetar.
    } else if (fa === true) {
      errors.push(`Hay un fix disponible (in-place) para ${a.ghsa}: actualiza ${a.package} y elimina la excepción.`);
    } else if (faIsCanonicalObject) {
      if (fa.name === a.package) {
        errors.push(`Hay una versión corregida de ${a.package} (${fa.name}@${fa.version}): actualiza y elimina la excepción de ${a.ghsa}.`);
      } else if (fa.isSemVerMajor !== true) {
        errors.push(`Hay un fix NO-mayor disponible (${fa.name}@${fa.version}) que remedia ${a.ghsa}: aplícalo y elimina la excepción.`);
      } else if (exc.acceptTransitiveMajorFix === true) {
        notes.push(`${a.ghsa}: npm sugiere un salto semver-MAJOR de ${fa.name} (@${fa.version}); no es una versión corregida de ${a.package} y queda fuera del alcance autorizado — tolerado por la excepción documentada; NO elimina el aviso de npm audit.`);
      } else {
        errors.push(`Hay un salto semver-MAJOR de ${fa.name} (@${fa.version}) para ${a.ghsa} y la excepción no lo declara tolerado (acceptTransitiveMajorFix).`);
      }
    } else {
      errors.push(`Forma de fixAvailable inesperada para ${a.ghsa}: ${JSON.stringify(fa)} (sólo se acepta false, true o {name no vacío, version semver, isSemVerMajor booleano}; null/ausente no cuentan como "sin fix").`);
    }
    // El parche declarado debe estar APLICADO y VERIFICADO sobre la instalación real.
    if (exc.patch) {
      const pv = patchVerification[a.package];
      if (!pv || pv.ok !== true) {
        errors.push(`El parche requerido para ${a.ghsa} (${a.package}) no está aplicado/verificado: ${pv && pv.detail ? pv.detail : 'sin verificación disponible'}.`);
      }
    }
    if (isCanonicalDate(exc.expires) && nowDate > new Date(`${exc.expires}T00:00:00Z`)) {
      errors.push(`La excepción de ${a.ghsa} está vencida (venció el ${exc.expires}): actualiza o retira ${a.package}.`);
    }
    allowed.push(a);
  }

  if (allowed.length > exceptions.length) {
    errors.push(`Hay más advisories permitidos presentes (${allowed.length}) que excepciones declaradas (${exceptions.length}).`);
  }

  // 6) Excepción configurada cuyo advisory ya no aparece → forzar su retiro.
  for (const e of exceptions) {
    const present = advObjs.some((a) => a.ghsa === e.ghsa && a.package === e.package);
    if (!present) {
      errors.push(`La excepción ${e.ghsa} ya no aparece en npm audit: elimínala de audit-exceptions.json y vuelve a 'npm audit --audit-level=high'.`);
    }
  }

  return { ok: errors.length === 0, errors, allowed: allowed.map((a) => a.ghsa), notes };
}

/**
 * Encuentra TODA carpeta llamada `braces` cuyo PADRE es un `node_modules`, a
 * cualquier profundidad, INCLUIDAS las anidadas bajo la propia carpeta braces
 * (braces/node_modules/…/braces) y bajo paquetes con scope (@scope/pkg/node_modules).
 * Identifica por el nombre de la carpeta (NO por el manifiesto): un `braces`
 * cargable con package.json inválido NO debe poder esconderse; su validación la
 * hace verifyBracesPatch, que RECHAZA manifiestos inválidos.
 */
function findBracesCopies(root) {
  const out = new Set();
  const isDirEntry = (nm, e) => {
    if (e.isDirectory()) return true;
    if (e.isSymbolicLink()) { try { return fs.statSync(path.join(nm, e.name)).isDirectory(); } catch (_e) { return false; } }
    return false;
  };
  // `nm` es siempre un directorio node_modules.
  const visit = (nm) => {
    let entries;
    try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      if (!isDirEntry(nm, e)) continue;
      const full = path.join(nm, e.name);
      if (e.name === 'braces') {
        out.add(full);
        visit(path.join(full, 'node_modules')); // anidadas BAJO la propia copia braces
      } else if (e.name.startsWith('@')) {
        let subs; try { subs = fs.readdirSync(full, { withFileTypes: true }); } catch (_e) { subs = []; }
        for (const s of subs) { if (isDirEntry(full, s)) visit(path.join(full, s.name, 'node_modules')); }
      } else {
        visit(path.join(full, 'node_modules'));
      }
    }
  };
  visit(path.join(root, 'node_modules'));
  return [...out];
}

/** Lanza fn y exige que la excepción sea de PROFUNDIDAD (no una excepción arbitraria). */
function expectsDepthError(fn) {
  try { fn(); return { ok: false, detail: 'no lanzó (profundidad aceptada)' }; } catch (e) {
    if (/depth/i.test(String(e && e.message))) return { ok: true };
    return { ok: false, detail: `excepción no es de profundidad: ${e && e.name}: ${String(e && e.message).slice(0, 60)}` };
  }
}

/**
 * Cross-check de COMPORTAMIENTO del parche (complementa las huellas): controles
 * positivos (patrones válidos expanden bien — descarta una impl que lanza siempre),
 * aceptación dentro del límite, y guardas de profundidad en PARSE (string) Y en
 * COMPILE (AST suministrado directamente). Una sola prueba de profundidad por parseo
 * NO acredita el parche completo; una excepción arbitraria no cuenta como rechazo.
 */
function verifyBracesBehavior(braces) {
  const positives = [['a{b,c}d', 'abd,acd'], ['{1..3}', '1,2,3'], ['foo/{a,b}', 'foo/a,foo/b']];
  for (const [pat, exp] of positives) {
    let r; try { r = braces.expand(pat); } catch (e) { return { ok: false, detail: `control positivo ${pat} lanzó: ${e.message}` }; }
    if (!Array.isArray(r) || r.join(',') !== exp) return { ok: false, detail: `control positivo ${pat} inesperado: ${JSON.stringify(r)}` };
  }
  const nest = (d) => `${'{a,'.repeat(d)}z${'}'.repeat(d)}`;
  const deepAst = (d) => { let n = { type: 'text', value: 'x' }; for (let i = 0; i < d; i += 1) n = { type: 'brace', nodes: [{ type: 'brace.open', value: '{' }, { type: 'text', value: 'a' }, n, { type: 'brace.close', value: '}' }] }; return { type: 'root', nodes: [n] }; };
  try { braces(nest(100)); } catch (e) { return { ok: false, detail: `nest(100) dentro del límite lanzó: ${e.message}` }; }
  const g1 = expectsDepthError(() => braces(nest(101)));
  if (!g1.ok) return { ok: false, detail: `guarda de parse: ${g1.detail}` };
  try { braces.compile(deepAst(50)); } catch (e) { return { ok: false, detail: `compile(AST 50) dentro del límite lanzó: ${e.message}` }; }
  const g2 = expectsDepthError(() => braces.compile(deepAst(150)));
  if (!g2.ok) return { ok: false, detail: `guarda de compile: ${g2.detail}` };
  return { ok: true };
}

/**
 * Verifica sobre la INSTALACIÓN REAL que el parche de braces (PR micromatch/braces
 * #72) está aplicado:
 *   1) IDENTIDAD por HUELLAS: TODAS las copias (incl. anidadas) coinciden byte a byte
 *      con los archivos de la revisión fija aprobada (`fingerprints`, SHA-256). Esto
 *      es independiente de npm (que avisa "skipping integrity check for git dependency"
 *      y NO verifica el SRI del git dep), y cubre TODO el parche, no una sola guarda.
 *   2) COMPORTAMIENTO: controles positivos + guardas de parse Y compile (ver
 *      verifyBracesBehavior). El stock de braces@3.0.3, o un parche con la guarda de
 *      compile eliminada, FALLAN.
 */
function verifyBracesPatch(root, fingerprints) {
  if (!fingerprints || !fingerprints.files || typeof fingerprints.files !== 'object') {
    return { ok: false, detail: 'sin huellas de referencia (braces-patch-fingerprints.json)' };
  }
  const copies = findBracesCopies(root);
  if (copies.length === 0) return { ok: false, detail: `no se encontró braces instalado bajo ${root}` };
  for (const dir of copies) {
    // 1) Manifiesto VÁLIDO (si no, se RECHAZA; no se omite).
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) {
      return { ok: false, detail: `copia ${dir}: package.json ausente o ilegible (${e.message})` };
    }
    if (pkg.name !== 'braces') return { ok: false, detail: `copia ${dir}: manifiesto inválido (name=${JSON.stringify(pkg.name)}, se espera "braces")` };
    if (pkg.version !== fingerprints.version) return { ok: false, detail: `copia ${dir}: versión ${JSON.stringify(pkg.version)} ≠ ${fingerprints.version}` };
    // 2) ENTRADA que cargaría un CONSUMIDOR por NOMBRE (require('braces')), resuelta
    //    desde el contexto de ESTA copia. Honra `main` Y `exports`: require.resolve(dir)
    //    (resolución por RUTA) NO sirve porque IGNORA el campo `exports`. El contexto es
    //    <base> = el directorio cuyo node_modules contiene esta copia (dirname×2), así
    //    la resolución por nombre apunta a la copia más cercana (ésta).
    const expectedEntry = fs.realpathSync(path.join(dir, 'index.js'));
    const consumerCtx = path.dirname(path.dirname(dir));
    let resolvedEntry;
    try { resolvedEntry = fs.realpathSync(require.resolve('braces', { paths: [consumerCtx] })); } catch (e) {
      return { ok: false, detail: `copia ${dir}: no se pudo resolver 'braces' por nombre desde ${consumerCtx} (${e.message})` };
    }
    if (resolvedEntry !== expectedEntry) {
      return { ok: false, detail: `copia ${dir}: la entrada que carga el consumidor por nombre (${resolvedEntry}) no es el index.js autenticado (main/exports la redirige)` };
    }
    // 3) HUELLAS de los 7 archivos de código.
    for (const [rel, want] of Object.entries(fingerprints.files)) {
      let got;
      try { got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex'); } catch (e) {
        return { ok: false, detail: `copia ${dir}: no se pudo leer ${rel}: ${e.message}` };
      }
      if (got !== want) return { ok: false, detail: `copia ${dir}: ${rel} no coincide con la revisión aprobada ${fingerprints.commit || ''}` };
    }
    // 4) COMPORTAMIENTO de ESTA copia (carga su entrada autenticada, no la raíz).
    let braces;
    try {
      delete require.cache[resolvedEntry];
      braces = require(resolvedEntry);
    } catch (e) { return { ok: false, detail: `copia ${dir}: no se pudo cargar (${e.message})` }; }
    const beh = verifyBracesBehavior(braces);
    if (!beh.ok) return { ok: false, detail: `copia ${dir}: ${beh.detail}` };
  }
  return { ok: true, detail: `${copies.length} copia(s) con huellas de ${fingerprints.commit || 'la revisión aprobada'}; manifiesto, entrada resuelta, huellas y guardas parse+compile verificadas por copia` };
}

const PATCH_VERIFIERS = { 'braces-patch-fingerprint': verifyBracesPatch };

/** Parsea `--root <dir>` y `--exceptions <file>` (ambos opcionales). */
function parseArgs(argv) {
  const out = { root: null, exceptions: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { out.root = argv[i + 1]; i += 1; } else if (argv[i] === '--exceptions') { out.exceptions = argv[i + 1]; i += 1; }
  }
  return out;
}

/** Lee la versión instalada de un paquete desde node_modules, o null. */
function readInstalledVersion(pkg, baseDir) {
  try {
    const pj = require.resolve(path.join(pkg, 'package.json'), { paths: [baseDir] });
    return JSON.parse(fs.readFileSync(pj, 'utf8')).version || null;
  } catch (_e) { return null; }
}

/** Ejecuta `npm audit --json` y devuelve el objeto parseado (stdout aun con exit≠0). */
function runNpmAudit(cwd) {
  let stdout;
  try {
    stdout = execFileSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    stdout = err.stdout ? String(err.stdout) : '';
  }
  if (!stdout.trim()) throw new Error('npm audit no devolvió JSON');
  return JSON.parse(stdout);
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  // Por defecto audita el API (compatibilidad). Con `--root`/`--exceptions` el
  // MISMO evaluador sirve a Bridge y Web, cada uno con su propio archivo de
  // excepciones (que sólo tolera braces).
  const defaultRoot = path.resolve(__dirname, '..', '..');
  const root = cli.root ? path.resolve(process.cwd(), cli.root) : defaultRoot;
  const excFile = cli.exceptions ? path.resolve(process.cwd(), cli.exceptions) : path.join(__dirname, 'audit-exceptions.json');
  const exceptions = JSON.parse(fs.readFileSync(excFile, 'utf8')).exceptions || [];

  let audit;
  try {
    audit = runNpmAudit(root);
  } catch (err) {
    process.stderr.write(`\n❌ El gate de npm audit falló: no se pudo ejecutar npm audit (${err.message}).\n`);
    process.exit(1);
  }
  // Huellas de la revisión fija aprobada (compartidas por los tres paquetes), junto
  // al gate para ser una única fuente de verdad.
  let fingerprints = null;
  try { fingerprints = JSON.parse(fs.readFileSync(path.join(__dirname, 'braces-patch-fingerprints.json'), 'utf8')); } catch (_e) { fingerprints = null; }

  const installedVersions = {};
  const patchVerification = {};
  for (const e of exceptions) {
    installedVersions[e.package] = readInstalledVersion(e.package, root);
    if (e.patch) {
      const verifier = PATCH_VERIFIERS[e.patch.verify];
      patchVerification[e.package] = verifier
        ? verifier(root, fingerprints)
        : { ok: false, detail: `verificador de parche desconocido: ${JSON.stringify(e.patch.verify)}` };
    }
  }

  const { ok, errors, allowed, notes } = evaluate(audit, exceptions, { now: new Date(), installedVersions, patchVerification });

  process.stdout.write('── Gate de npm audit (mitigación TEMPORAL, acotada y vencible) ─────────────\n');
  process.stdout.write(`Objetivo: ${root}\n`);
  for (const e of exceptions) {
    const pv = patchVerification[e.package];
    const patchNote = e.patch ? ` · parche ${e.patch.source || e.patch.verify} [${pv && pv.ok ? 'verificado' : 'NO verificado'}]` : '';
    process.stdout.write(`Excepción declarada: ${e.ghsa} / ${e.cve || '-'} · ${e.package}@${e.version} · vence ${e.expires}${patchNote}\n`);
  }
  for (const n of notes || []) process.stdout.write(`Nota: ${n}\n`);
  if (ok) {
    process.stdout.write('✓ Sin avisos high/critical fuera de las excepciones declaradas (una aceptación temporal del riesgo; el aviso SIGUE en npm audit).\n');
    process.exit(0);
  }
  process.stderr.write('\n❌ El gate de npm audit falló:\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.stderr.write('\nUna excepción es temporal: si hay versión corregida publicada, actualiza y retírala.\n');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { evaluate, reachableAdvisories, ghsaFromUrl, isCanonicalDate, readInstalledVersion, verifyBracesPatch, verifyBracesBehavior, findBracesCopies, expectsDepthError, parseArgs };
