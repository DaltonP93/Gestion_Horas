const {
  LEGAL_FIELDS,
  maskEmployeeRow,
  maskEmployeeList,
  privacyDescriptor,
} = require('../src/services/employeePrivacy');

function fixture() {
  return {
    id: 1,
    first_name: 'Ana',
    last_name: 'Pérez',
    email: 'ana@x.py',
    phone: '0981',
    position: 'Analista',
    department_id: 3,
    document_number: '3.456.789',
    ips_number: 'IPS-1',
    salary_base: 5000000,
    gender: 'F',
    pay_type: 'monthly',
    children_count: 2,
    antiguedad_rate: 0.1,
    birth_date: '1990-01-01',
  };
}

describe('employeePrivacy.maskEmployeeRow', () => {
  test('mantiene todo cuando el rol tiene legal_view', () => {
    const row = fixture();
    maskEmployeeRow(row, { user: { role: 'admin' } });
    expect(row.document_number).toBe('3.456.789');
    expect(row.salary_base).toBe(5000000);
    expect(row.email).toBe('ana@x.py');
  });

  test('enmascara TODOS los campos legales cuando no hay legal_view', () => {
    const row = fixture();
    maskEmployeeRow(row, { user: { role: 'supervisor' } });
    for (const f of LEGAL_FIELDS) expect(row[f]).toBeNull();
    // Los personales quedan intactos.
    expect(row.first_name).toBe('Ana');
    expect(row.phone).toBe('0981');
    expect(row.department_id).toBe(3);
  });

  test('acepta caps precomputados y no falla sin user', () => {
    const row = fixture();
    maskEmployeeRow(row, { caps: { legal_view: false } });
    expect(row.document_number).toBeNull();
  });

  test('no toca claves ausentes (no las añade)', () => {
    const row = { id: 9, first_name: 'X' };
    maskEmployeeRow(row, { user: { role: 'supervisor' } });
    expect(row).toEqual({ id: 9, first_name: 'X' });
  });

  test('rol desconocido enmascara por defecto', () => {
    const row = fixture();
    maskEmployeeRow(row, { user: { role: 'marciano' } });
    expect(row.salary_base).toBeNull();
  });

  test('null / undefined row → devuelve tal cual sin lanzar', () => {
    expect(maskEmployeeRow(null, { user: { role: 'admin' } })).toBeNull();
    expect(maskEmployeeRow(undefined)).toBeUndefined();
  });
});

describe('employeePrivacy.maskEmployeeList', () => {
  test('recorre y mutila cada fila cuando falta legal_view', () => {
    const rows = [fixture(), fixture()];
    maskEmployeeList(rows, { user: { role: 'employee' } });
    for (const r of rows) expect(r.ips_number).toBeNull();
  });
  test('no hace trabajo cuando legal_view=true', () => {
    const rows = [fixture(), fixture()];
    maskEmployeeList(rows, { user: { role: 'admin' } });
    for (const r of rows) expect(r.ips_number).toBe('IPS-1');
  });
});

describe('employeePrivacy.privacyDescriptor', () => {
  test('reporta lista de campos enmascarados', () => {
    const d = privacyDescriptor({ user: { role: 'supervisor' } });
    expect(d.legal_visible).toBe(false);
    expect(d.masked_fields).toEqual(LEGAL_FIELDS);
  });
  test('lista vacía cuando legal_view=true', () => {
    const d = privacyDescriptor({ user: { role: 'admin' } });
    expect(d.legal_visible).toBe(true);
    expect(d.masked_fields).toEqual([]);
  });
});
