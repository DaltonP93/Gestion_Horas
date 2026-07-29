const { capsForRole, classifyField, LEGAL_FIELDS } = require('../src/services/employeeCaps');

describe('employeeCaps.capsForRole', () => {
  test('admin y super_admin tienen todas las sub-acciones', () => {
    for (const r of ['admin', 'super_admin']) {
      const c = capsForRole(r);
      expect(c).toMatchObject({
        personal_update: true, legal_view: true, legal_update: true,
        biometrics_link: true, status_change: true,
      });
    }
  });

  test('hr y gth tienen legal.update y vinculación biometría', () => {
    for (const r of ['hr', 'gth']) {
      const c = capsForRole(r);
      expect(c.personal_update).toBe(true);
      expect(c.legal_view).toBe(true);
      expect(c.legal_update).toBe(true);
      expect(c.biometrics_link).toBe(true);
      expect(c.status_change).toBe(true);
    }
  });

  test('supervisor NO puede editar ni ver datos legales por defecto', () => {
    const c = capsForRole('supervisor');
    expect(c.personal_update).toBe(false);
    expect(c.legal_view).toBe(false);
    expect(c.legal_update).toBe(false);
    expect(c.biometrics_link).toBe(false);
    expect(c.status_change).toBe(false);
  });

  test('manager/coordinator ve legal pero no lo edita', () => {
    for (const r of ['manager', 'coordinator', 'gestor']) {
      const c = capsForRole(r);
      expect(c.legal_view).toBe(true);
      expect(c.legal_update).toBe(false);
      expect(c.personal_update).toBe(false);
    }
  });

  test('rol desconocido no otorga nada', () => {
    const c = capsForRole('marciano');
    for (const k of Object.keys(c)) expect(c[k]).toBe(false);
  });

  test('cambiar el objeto devuelto no altera al siguiente', () => {
    const c1 = capsForRole('supervisor');
    c1.legal_update = true;
    const c2 = capsForRole('supervisor');
    expect(c2.legal_update).toBe(false);
  });
});

describe('employeeCaps.classifyField', () => {
  test('campos legales conocidos', () => {
    for (const f of LEGAL_FIELDS) {
      expect(classifyField(f)).toBe('legal');
    }
  });
  test('campos no-legales caen en personal', () => {
    for (const f of ['first_name', 'last_name', 'email', 'phone', 'position', 'hire_date', 'birth_date', 'schedule_id']) {
      expect(classifyField(f)).toBe('personal');
    }
  });
});
