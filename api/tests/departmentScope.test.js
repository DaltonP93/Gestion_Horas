const {
  isScoped,
  isUnrestricted,
  applyDepartmentScope,
  canSeeEmployee,
  SCOPED_ROLES,
  UNRESTRICTED_ROLES,
} = require('../src/services/departmentScope');

describe('departmentScope.isScoped / isUnrestricted', () => {
  test('roles admin/hr/gth/super_admin son unrestricted', () => {
    for (const r of ['super_admin', 'admin', 'gth', 'hr']) {
      expect(isUnrestricted(r)).toBe(true);
      expect(isScoped(r)).toBe(false);
    }
  });
  test('manager/coordinator/supervisor/gestor son scoped', () => {
    for (const r of ['manager', 'coordinator', 'supervisor', 'gestor']) {
      expect(isScoped(r)).toBe(true);
      expect(isUnrestricted(r)).toBe(false);
    }
  });
  test('employee no es scoped ni unrestricted (sin visibilidad de listas)', () => {
    expect(isScoped('employee')).toBe(false);
    expect(isUnrestricted('employee')).toBe(false);
  });
  test('rol desconocido cae a sin-visibilidad', () => {
    expect(isScoped('marciano')).toBe(false);
    expect(isUnrestricted('marciano')).toBe(false);
  });
  test('los sets son inmutables externamente (Set)', () => {
    expect(SCOPED_ROLES.has('manager')).toBe(true);
    expect(UNRESTRICTED_ROLES.has('admin')).toBe(true);
  });
});

describe('departmentScope.applyDepartmentScope', () => {
  test('unrestricted → no-op', () => {
    const out = applyDepartmentScope('WHERE 1=1', [], { unrestricted: true });
    expect(out.where).toBe('WHERE 1=1');
    expect(out.params).toEqual([]);
  });
  test('ids vacío → añade 1=0 (0 filas)', () => {
    const out = applyDepartmentScope('WHERE 1=1', [], { unrestricted: false, ids: [] });
    expect(out.where).toContain('AND 1=0');
  });
  test('ids → cláusula IN con placeholders y params concatenados', () => {
    const out = applyDepartmentScope('WHERE 1=1 AND e.status = ?', ['active'], { unrestricted: false, ids: [3, 4, 7] });
    expect(out.where).toBe('WHERE 1=1 AND e.status = ? AND e.department_id IN (?,?,?)');
    expect(out.params).toEqual(['active', 3, 4, 7]);
  });
  test('col personalizado', () => {
    const out = applyDepartmentScope('WHERE 1=1', [], { unrestricted: false, ids: [9] }, 'x.dept');
    expect(out.where).toContain('x.dept IN (?)');
    expect(out.params).toEqual([9]);
  });
  test('scope falsy → no-op defensivo', () => {
    const out = applyDepartmentScope('WHERE 1=1', ['x'], null);
    expect(out.where).toBe('WHERE 1=1');
    expect(out.params).toEqual(['x']);
  });
});

describe('departmentScope.canSeeEmployee', () => {
  test('unrestricted ve a todos', () => {
    expect(canSeeEmployee({ unrestricted: true }, { department_id: 1 })).toBe(true);
    expect(canSeeEmployee({ unrestricted: true }, { department_id: null })).toBe(true);
  });
  test('scoped ve sólo empleados de su lista de deptos', () => {
    const s = { unrestricted: false, ids: [3, 4] };
    expect(canSeeEmployee(s, { department_id: 3 })).toBe(true);
    expect(canSeeEmployee(s, { department_id: 4 })).toBe(true);
    expect(canSeeEmployee(s, { department_id: 5 })).toBe(false);
  });
  test('scoped no ve empleados sin depto', () => {
    expect(canSeeEmployee({ unrestricted: false, ids: [3] }, { department_id: null })).toBe(false);
  });
  test('scope sin ids → nada visible', () => {
    expect(canSeeEmployee({ unrestricted: false, ids: [] }, { department_id: 1 })).toBe(false);
  });
});
