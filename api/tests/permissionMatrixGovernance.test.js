/**
 * permissionMatrixGovernance.test.js — los módulos de gobierno (empresas,
 * centros_costo) existen y heredan los defaults de la sección admin por rol.
 */
const { MODULES, defaultsForRole } = require('../src/services/permissionMatrix');

describe('módulos de gobierno en la matriz de permisos', () => {
  test('empresas y centros_costo están declarados en la sección admin', () => {
    const byKey = Object.fromEntries(MODULES.map((m) => [m.key, m]));
    expect(byKey.empresas).toBeDefined();
    expect(byKey.empresas.section).toBe('admin');
    expect(byKey.centros_costo).toBeDefined();
    expect(byKey.centros_costo.section).toBe('admin');
  });

  test('super_admin tiene control total sobre empresas', () => {
    const d = defaultsForRole('super_admin');
    expect(d.empresas).toEqual({ can_view: 1, can_create: 1, can_update: 1, can_delete: 1 });
  });

  test('gth ve/crea/edita pero no borra gobierno (defaults admin de gth)', () => {
    const d = defaultsForRole('gth');
    expect(d.empresas).toEqual({ can_view: 1, can_create: 1, can_update: 1, can_delete: 0 });
    expect(d.centros_costo).toEqual({ can_view: 1, can_create: 1, can_update: 1, can_delete: 0 });
  });

  test('empleado no tiene acceso a gobierno', () => {
    const d = defaultsForRole('employee');
    expect(d.empresas).toEqual({ can_view: 0, can_create: 0, can_update: 0, can_delete: 0 });
    expect(d.centros_costo).toEqual({ can_view: 0, can_create: 0, can_update: 0, can_delete: 0 });
  });

  test('hr no tiene sección admin, por lo tanto no ve gobierno', () => {
    const d = defaultsForRole('hr');
    expect(d.empresas.can_view).toBe(0);
  });
});
