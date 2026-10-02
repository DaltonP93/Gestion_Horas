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

function ghsaFromUrl(url) {
  const m = String(url || '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : null;
}

/** Aplana los advisories (via[] con objeto) de un reporte `npm audit --json` (v7+). */
function collectAdvisories(audit) {
  const out = [];
  const vulns = (audit && audit.vulnerabilities) || {};
  for (const [pkg, v] of Object.entries(vulns)) {
    const via = Array.isArray(v.via) ? v.via : [];
    for (const adv of via) {
      if (!adv || typeof adv !== 'object' || !adv.url) continue; // string = nombre de dep transitiva
      out.push({
        package: adv.name || pkg,
        url: adv.url,
        ghsa: ghsaFromUrl(adv.url),
        severity: adv.severity,
        range: adv.range,
        fixAvailable: v.fixAvailable,
      });
    }
  }
  return out;
}

/**
 * Evalúa un reporte de npm audit contra las excepciones. PURA (testeable).
 * @returns {{ok:boolean, errors:string[], allowed:string[]}}
 */
function evaluate(audit, exceptions, { now = new Date(), installedVersions = {} } = {}) {
  const errors = [];
  const advisories = collectAdvisories(audit).filter((a) => HIGH.has(a.severity));
  const nowDate = now instanceof Date ? now : new Date(now);

  const allowed = [];
  for (const a of advisories) {
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
    const expires = new Date(`${exc.expires}T00:00:00Z`);
    if (nowDate > expires) errors.push(`La excepción de ${a.ghsa} está vencida (venció el ${exc.expires}): actualiza o retira node-forge.`);
    allowed.push(a);
  }

  if (allowed.length > 1) {
    errors.push(`Hay más de un advisory permitido presente (${allowed.length}); la excepción cubre exactamente uno.`);
  }

  // Si una excepción está configurada pero su advisory ya no aparece, forzar su retiro.
  for (const e of exceptions) {
    const present = advisories.some((a) => a.ghsa === e.ghsa && a.package === e.package);
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

  const audit = runNpmAudit(apiRoot);
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

module.exports = { evaluate, collectAdvisories, ghsaFromUrl, readInstalledVersion };
