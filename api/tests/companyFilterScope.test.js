/**
 * companyFilterScope.test.js — companyFilter valida el alcance ANTES de
 * aplicar `includeNull`: un alcance ausente, nulo, mal formado, un literal
 * global no emitido o vacío (sin sede activa) no puede habilitar las filas
 * sin empresa (`col IS NULL`); devuelve `AND 1=0`.
 */
const { issuedGlobal } = require('./helpers/scopes');
const orgScope = require('../src/services/orgScope');

const OPTS = { includeNull: true };

describe('companyFilter con includeNull: alcance inválido o vacío → sin filas', () => {
  test.each([
    ['ausente', undefined],
    ['null', null],
    ['mal formado', { unrestricted: false, companyIds: ['1'] }],
    ['literal { unrestricted: true } no emitido', { unrestricted: true }],
    ['vacío por sede inactiva', { unrestricted: false, companyIds: [], branchIds: [], departmentIds: [] }],
  ])('%s', (_label, scope) => {
    expect(orgScope.companyFilter(scope, 'company_id', OPTS)).toEqual({ clause: 'AND 1=0', params: [] });
  });
});

describe('controles positivos', () => {
  test('global emitido → sin filtro', () => {
    expect(orgScope.companyFilter(issuedGlobal(), 'company_id', OPTS)).toEqual({ clause: '', params: [] });
  });

  test('restringido con empresa → su empresa o sin empresa', () => {
    const s = { unrestricted: false, companyIds: [9], branchIds: [2], departmentIds: [4] };
    expect(orgScope.companyFilter(s, 'company_id', OPTS))
      .toEqual({ clause: 'AND (company_id IN (?) OR company_id IS NULL)', params: [9] });
    // Sin includeNull no cambia.
    expect(orgScope.companyFilter(s, 'company_id')).toEqual({ clause: 'AND (company_id IN (?))', params: [9] });
  });

  test('sede activa aún sin empresa vinculada → sólo filas sin empresa', () => {
    const s = { unrestricted: false, companyIds: [], branchIds: [2], departmentIds: [4] };
    expect(orgScope.companyFilter(s, 'company_id', OPTS)).toEqual({ clause: 'AND company_id IS NULL', params: [] });
  });
});
