'use strict';

/**
 * auditGate.test.js — pruebas unitarias del gate de `npm audit` del API con la
 * excepción temporal, acotada y vencible para GHSA-86w9-cpqp-85rv
 * (node-forge 1.4.0). JSON SINTÉTICO; no ejecuta npm.
 */

const { evaluate } = require('../audit-gate');

const GHSA = 'GHSA-86w9-cpqp-85rv';
const URL = `https://github.com/advisories/${GHSA}`;

const EXCEPTIONS = [{
  ghsa: GHSA,
  cve: 'CVE-2026-85393',
  package: 'node-forge',
  version: '1.4.0',
  affectedRange: '<=1.4.0',
  severity: 'high',
  url: URL,
  expires: '2026-11-01',
}];

const installed = { 'node-forge': '1.4.0' };
const now = new Date('2026-10-02T00:00:00Z');

/** npm audit v7: un advisory bajo un paquete. */
function auditWith(vulns) {
  const vulnerabilities = {};
  const meta = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const v of vulns) {
    vulnerabilities[v.name] = {
      name: v.name,
      severity: v.severity,
      via: [{ source: v.source || 1, name: v.name, dependency: v.name, title: v.title || 't', url: v.url, severity: v.severity, range: v.range }],
      range: v.range,
      nodes: [`node_modules/${v.name}`],
      fixAvailable: v.fixAvailable === undefined ? false : v.fixAvailable,
    };
    meta[v.severity] += 1;
    meta.total += 1;
  }
  return { vulnerabilities, metadata: { vulnerabilities: meta } };
}

const forgeAdvisory = { name: 'node-forge', severity: 'high', url: URL, range: '<=1.4.0', source: 1240912 };

describe('audit-gate.evaluate', () => {
  test('sólo el advisory permitido → pasa', () => {
    const r = evaluate(auditWith([forgeAdvisory]), EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('otro high/critical además del permitido → falla', () => {
    const r = evaluate(auditWith([
      forgeAdvisory,
      { name: 'otra-lib', severity: 'critical', url: 'https://github.com/advisories/GHSA-xxxx', range: '*' },
    ]), EXCEPTIONS, { now, installedVersions: { ...installed, 'otra-lib': '2.0.0' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/otra-lib|no permitido/i);
  });

  test('un high/critical NO permitido (sin excepción) → falla', () => {
    const r = evaluate(auditWith([
      { name: 'otra-lib', severity: 'high', url: 'https://github.com/advisories/GHSA-yyyy', range: '*' },
    ]), EXCEPTIONS, { now, installedVersions: { 'otra-lib': '1.0.0' } });
    expect(r.ok).toBe(false);
  });

  test('dos advisories del mismo paquete permitido → falla (más de uno permitido)', () => {
    const audit = auditWith([forgeAdvisory]);
    // Segundo advisory bajo el mismo paquete.
    audit.vulnerabilities['node-forge'].via.push({ source: 2, name: 'node-forge', dependency: 'node-forge', title: 'x', url: 'https://github.com/advisories/GHSA-zzzz', severity: 'high', range: '<=1.4.0' });
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/más de un|GHSA-zzzz/i);
  });

  test('versión instalada distinta de la declarada → falla', () => {
    const r = evaluate(auditWith([forgeAdvisory]), EXCEPTIONS, { now, installedVersions: { 'node-forge': '1.3.1' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/versi[oó]n/i);
  });

  test('rango afectado distinto del declarado → falla', () => {
    const r = evaluate(auditWith([{ ...forgeAdvisory, range: '<=1.5.0' }]), EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/rango|range/i);
  });

  test('severidad distinta de la declarada → falla', () => {
    const r = evaluate(auditWith([{ ...forgeAdvisory, severity: 'critical' }]), EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
  });

  test('URL/GHSA distinto del declarado → falla', () => {
    const r = evaluate(auditWith([{ ...forgeAdvisory, url: 'https://github.com/advisories/GHSA-0000-0000-0000' }]), EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
  });

  test('fix disponible → falla (hay que actualizar, no excepcionar)', () => {
    const r = evaluate(auditWith([{ ...forgeAdvisory, fixAvailable: true }]), EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/fix|correg|actualiz/i);
  });

  test('excepción vencida (después del 2026-11-01) → falla', () => {
    const r = evaluate(auditWith([forgeAdvisory]), EXCEPTIONS, { now: new Date('2026-11-02T00:00:00Z'), installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/vencid|expir/i);
  });

  test('audit limpio con la excepción todavía configurada → falla y pide eliminarla', () => {
    const r = evaluate(auditWith([]), EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/elimin|retir|ya no|desaparec/i);
  });

  test('sin excepciones y audit limpio → pasa', () => {
    const r = evaluate(auditWith([]), [], { now, installedVersions: {} });
    expect(r.ok).toBe(true);
  });
});
