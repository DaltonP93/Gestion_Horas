#!/usr/bin/env node
'use strict';

/**
 * audit-gate.js — gate de `npm audit` del API con una excepción TEMPORAL,
 * acotada y vencible para GHSA-86w9-cpqp-85rv / CVE-2026-85393 (node-forge
 * 1.4.0, sin fix publicado; usado sólo para parseo CMS/ASN.1).
 *
 * Reemplaza a `npm audit --audit-level=high` SÓLO en el API. Mantiene el nivel
 * alto/crítico y además:
 *   - tolera EXACTAMENTE los advisories declarados en audit-exceptions.json;
 *   - falla ante cualquier otro high/critical;
 *   - falla si hay más de un advisory permitido;
 *   - falla si cambia paquete, URL/GHSA, severidad, rango o versión instalada;
 *   - falla si aparece una versión corregida (fixAvailable);
 *   - falla si la excepción venció (fecha `expires`);
 *   - falla si el advisory DESAPARECE (hay que retirar la excepción y volver a
 *     `npm audit --audit-level=high`).
 *
 * Es una mitigación temporal: la función vulnerable de node-forge
 * (cert.publicKey.verify) ya NO se usa en producción; la verificación real la
 * hace node:crypto/OpenSSL (ver verifyPdfSignature.js).
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const HIGH = new Set(['high', 'critical']);
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
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
function evaluate(audit, exceptions, { now = new Date(), installedVersions = {} } = {}) {
  const errors = [];
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
    if (a.fixAvailable) errors.push(`Hay un fix disponible para ${a.ghsa}: actualiza ${a.package} y elimina la excepción (no excepcionar).`);
    if (isCanonicalDate(exc.expires) && nowDate > new Date(`${exc.expires}T00:00:00Z`)) {
      errors.push(`La excepción de ${a.ghsa} está vencida (venció el ${exc.expires}): actualiza o retira node-forge.`);
    }
    allowed.push(a);
  }

  if (allowed.length > 1) {
    errors.push(`Hay más de un advisory permitido presente (${allowed.length}); la excepción cubre exactamente uno.`);
  }

  // 6) Excepción configurada cuyo advisory ya no aparece → forzar su retiro.
  for (const e of exceptions) {
    const present = advObjs.some((a) => a.ghsa === e.ghsa && a.package === e.package);
    if (!present) {
      errors.push(`La excepción ${e.ghsa} ya no aparece en npm audit: elimínala de audit-exceptions.json y vuelve a 'npm audit --audit-level=high'.`);
    }
  }

  return { ok: errors.length === 0, errors, allowed: allowed.map((a) => a.ghsa) };
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
  const apiRoot = path.resolve(__dirname, '..', '..');
  const excFile = path.join(__dirname, 'audit-exceptions.json');
  const exceptions = JSON.parse(fs.readFileSync(excFile, 'utf8')).exceptions || [];

  let audit;
  try {
    audit = runNpmAudit(apiRoot);
  } catch (err) {
    process.stderr.write(`\n❌ El gate de npm audit falló: no se pudo ejecutar npm audit (${err.message}).\n`);
    process.exit(1);
  }
  const installedVersions = {};
  for (const e of exceptions) installedVersions[e.package] = readInstalledVersion(e.package, apiRoot);

  const { ok, errors, allowed } = evaluate(audit, exceptions, { now: new Date(), installedVersions });

  process.stdout.write('── Gate de npm audit (API) ─ mitigación TEMPORAL ──────────────────────────\n');
  process.stdout.write('node-forge se mantiene SÓLO para parseo CMS/ASN.1; la verificación de firma\n');
  process.stdout.write('la hace node:crypto/OpenSSL (cert.publicKey.verify de forge NO se usa).\n');
  if (allowed.length) {
    for (const e of exceptions) {
      process.stdout.write(`Excepción activa: ${e.ghsa} / ${e.cve} · ${e.package}@${e.version} · vence ${e.expires}\n`);
    }
  }
  if (ok) {
    process.stdout.write('✓ Sin avisos high/critical fuera de la excepción declarada.\n');
    process.exit(0);
  }
  process.stderr.write('\n❌ El gate de npm audit falló:\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.stderr.write('\nSi node-forge publicó una versión corregida, actualiza y retira la excepción.\n');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { evaluate, reachableAdvisories, ghsaFromUrl, isCanonicalDate, readInstalledVersion };
