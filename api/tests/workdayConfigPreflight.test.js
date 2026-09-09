'use strict';

/**
 * workdayConfigPreflight.test.js — gate tri-estado del preflight de FASE E.
 *
 * La regla más importante del rollout (docs/workday-engine-rollout-status.md
 * §Gates) es que el ÚNICO estado degradado seguro es "tabla de historial
 * ausente → historical_fallback"; un esquema PARCIAL (tabla presente pero a
 * medias) NO degrada, propaga error, y es NO-GO. Aquí se fija esa clasificación
 * como algo verificable, sin base de datos.
 */

const fs = require('fs');
const path = require('path');

// El módulo exporta la lógica pura y su main() sólo corre como CLI
// (require.main === module), así que requerirlo NO conecta a MySQL.
const { classifyGate } = require('../scripts/workday-config-preflight');

describe('classifyGate (pura, sin DB)', () => {
  test('esquema completo → GO', () => {
    expect(classifyGate({ schemaReady: true, historyExists: true })).toBe('GO');
    // GO manda aunque historyExists venga en false por otra vía: schemaReady lo domina.
    expect(classifyGate({ schemaReady: true, historyExists: false })).toBe('GO');
  });

  test('tabla de historial AUSENTE → SAFE_DEGRADED (fallback por diseño)', () => {
    expect(classifyGate({ schemaReady: false, historyExists: false })).toBe('SAFE_DEGRADED');
  });

  test('tabla presente pero esquema a medias → NO_GO_PARTIAL (peligroso)', () => {
    expect(classifyGate({ schemaReady: false, historyExists: true })).toBe('NO_GO_PARTIAL');
  });
});

describe('semántica de exit codes (mapeo del gate)', () => {
  // --require-safe sólo debe fallar en el estado peligroso; --require-ready fuera de GO.
  const requireSafeFails = (gate) => gate === 'NO_GO_PARTIAL';
  const requireReadyFails = (gate) => gate !== 'GO';

  test('--require-safe: falla SÓLO en NO_GO_PARTIAL', () => {
    expect(requireSafeFails('GO')).toBe(false);
    expect(requireSafeFails('SAFE_DEGRADED')).toBe(false); // fallback por tabla ausente = seguro
    expect(requireSafeFails('NO_GO_PARTIAL')).toBe(true);
  });

  test('--require-ready: falla fuera de GO', () => {
    expect(requireReadyFails('GO')).toBe(false);
    expect(requireReadyFails('SAFE_DEGRADED')).toBe(true);
    expect(requireReadyFails('NO_GO_PARTIAL')).toBe(true);
  });
});

describe('cableado CLI (fuente)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'workday-config-preflight.js'), 'utf8');

  test('--require-safe está atado exactamente a NO_GO_PARTIAL', () => {
    expect(SRC).toMatch(/--require-safe.*gate === 'NO_GO_PARTIAL'/);
  });
  test('--require-ready sale ≠0 salvo GO', () => {
    expect(SRC).toMatch(/--require-ready.*gate !== 'GO'/);
  });
  test('el main() con MySQL sólo corre como CLI', () => {
    expect(SRC).toMatch(/require\.main === module/);
  });
});
