'use strict';

/**
 * phaseEPreflightWrapper.test.js — veredicto del orquestador GO/NO-GO de FASE E.
 *
 * computeVerdict es pura (no lanza procesos ni toca DB): el módulo guarda su
 * main() bajo require.main === module, así que requerirlo no ejecuta nada.
 */

const { computeVerdict } = require('../scripts/phase-e-preflight');

const ok = (label) => ({ label, passed: true, gate: true });
const fail = (label) => ({ label, passed: false, gate: true });

describe('computeVerdict', () => {
  test('todos los gates verdes + impacto corrido → GO', () => {
    expect(computeVerdict([ok('a'), ok('b'), ok('c'), ok('impact')], false)).toBe('GO');
  });

  test('algún gate en rojo → NO_GO (aunque el resto pase)', () => {
    expect(computeVerdict([ok('a'), fail('b'), ok('c')], false)).toBe('NO_GO');
    expect(computeVerdict([ok('a'), ok('b'), fail('impact')], false)).toBe('NO_GO');
  });

  test('gates verdes pero impacto OMITIDO → INCOMPLETE (nunca GO)', () => {
    expect(computeVerdict([ok('a'), ok('b'), ok('c')], true)).toBe('INCOMPLETE');
  });

  test('un paso no-gate en rojo no baja el veredicto', () => {
    const steps = [ok('a'), { label: 'info', passed: false, gate: false }, ok('c'), ok('impact')];
    expect(computeVerdict(steps, false)).toBe('GO');
  });
});
