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

describe('endurecimiento del gate (reproducciones que fallan sobre ebbc25c)', () => {
  const forgeVuln = () => ({
    name: 'node-forge', severity: 'high', range: '<=1.4.0',
    via: [{ source: 1240912, name: 'node-forge', dependency: 'node-forge', title: 't', url: URL, severity: 'high', range: '<=1.4.0' }],
    nodes: ['node_modules/node-forge'], fixAvailable: false,
  });
  const meta = (o) => ({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...o });

  test('otro high cuyo via no trae advisory con URL → falla (no se ignora en silencio)', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        'oculto': {
          name: 'oculto', severity: 'high', range: '*',
          // via con un objeto SIN url: hoy el gate lo ignora y queda ok.
          via: [{ name: 'oculto', dependency: 'oculto', title: 'sin url', severity: 'high', range: '*' }],
          nodes: ['node_modules/oculto'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 2, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: { ...installed, oculto: '1.0.0' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/URL|oculto|no está explicada/i);
  });

  test('referencia via transitiva no resoluble → falla', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        'padre': {
          name: 'padre', severity: 'high', range: '*',
          via: ['dependencia-ausente'], // no está en el informe
          nodes: ['node_modules/padre'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 2, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: { ...installed, padre: '1.0.0' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/transitiv|no resoluble|dependencia-ausente/i);
  });

  test('contadores de metadata incoherentes con el informe → falla', () => {
    const audit = {
      vulnerabilities: { 'node-forge': forgeVuln() },
      metadata: { vulnerabilities: meta({ high: 2, total: 2 }) }, // dice 2, hay 1
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/contador|incoheren/i);
  });

  test('informe con objeto "error" (fallo de npm audit) → falla aunque esté el advisory permitido', () => {
    const audit = {
      error: { code: 'EAUDITNOLOCK', summary: 'npm no pudo auditar' },
      vulnerabilities: { 'node-forge': forgeVuln() },
      metadata: { vulnerabilities: meta({ high: 1, total: 1 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/error|ejecuci/i);
  });

  test('fecha de vencimiento inválida en la excepción → falla', () => {
    const bad = [{ ...EXCEPTIONS[0], expires: 'pronto' }];
    const r = evaluate(auditWith([{ name: 'node-forge', severity: 'high', url: URL, range: '<=1.4.0' }]), bad, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/fecha|vencimiento|inv[aá]lid/i);
  });

  test('fecha de vencimiento con desbordamiento (2026-13-40) → falla', () => {
    const bad = [{ ...EXCEPTIONS[0], expires: '2026-13-40' }];
    const r = evaluate(auditWith([{ name: 'node-forge', severity: 'high', url: URL, range: '<=1.4.0' }]), bad, { now, installedVersions: installed });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/fecha|vencimiento|inv[aá]lid/i);
  });

  test('un high explicado SÓLO por una referencia transitiva resoluble al advisory permitido → pasa', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        'consumidor': {
          name: 'consumidor', severity: 'high', range: '*',
          via: ['node-forge'], // explicado transitivamente por el advisory permitido
          nodes: ['node_modules/consumidor'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 2, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: installed });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('validación de severidad del advisory (reproducciones sobre 4797055)', () => {
  const forgeVuln = () => ({
    name: 'node-forge', severity: 'high', range: '<=1.4.0',
    via: [{ source: 1240912, name: 'node-forge', dependency: 'node-forge', title: 't', url: URL, severity: 'high', range: '<=1.4.0' }],
    nodes: ['node_modules/node-forge'], fixAvailable: false,
  });
  const meta = (o) => ({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...o });
  const OTHER = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';

  test('critical con advisory (con URL) SIN severidad → falla (no desaparece en silencio)', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        mal: {
          name: 'mal', severity: 'critical', range: '*',
          via: [{ name: 'mal', dependency: 'mal', title: 'x', url: OTHER, range: '*' }], // sin severity
          nodes: ['node_modules/mal'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 1, critical: 1, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: { ...installed, mal: '1.0.0' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/severidad|mal/i);
  });

  test('critical con advisory de severidad desconocida → falla', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        mal: {
          name: 'mal', severity: 'critical', range: '*',
          via: [{ name: 'mal', dependency: 'mal', title: 'x', url: OTHER, severity: 'bogus', range: '*' }],
          nodes: ['node_modules/mal'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 1, critical: 1, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: { ...installed, mal: '1.0.0' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/severidad|bogus|mal/i);
  });

  test('critical "explicada" sólo por un advisory de severidad incompatible (moderate) → falla', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        mal: {
          name: 'mal', severity: 'critical', range: '*',
          via: [{ name: 'mal', dependency: 'mal', title: 'x', url: OTHER, severity: 'moderate', range: '*' }],
          nodes: ['node_modules/mal'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 1, critical: 1, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: { ...installed, mal: '1.0.0' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/no está explicada|incompatible|severidad/i);
  });

  test('control positivo: una vulnerabilidad moderate (bajo el umbral) con severidad conocida → pasa', () => {
    const audit = {
      vulnerabilities: {
        'node-forge': forgeVuln(),
        menor: {
          name: 'menor', severity: 'moderate', range: '*',
          via: [{ name: 'menor', dependency: 'menor', title: 'x', url: OTHER, severity: 'moderate', range: '*' }],
          nodes: ['node_modules/menor'], fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: meta({ high: 1, moderate: 1, total: 2 }) },
    };
    const r = evaluate(audit, EXCEPTIONS, { now, installedVersions: { ...installed, menor: '1.0.0' } });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
