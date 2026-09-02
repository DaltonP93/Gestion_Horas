/**
 * redact.test.js — la redacción enmascara claves sensibles sin mutar la entrada.
 */
const { redactDetails, REDACTED } = require('../src/utils/redact');

describe('redactDetails', () => {
  test('enmascara claves sensibles conocidas (incluida coincidencia por inclusión)', () => {
    const input = {
      code: 'EMP-1',
      tax_id: '80012345-6',
      after: { legal_name: 'ACME SA', salary_base: 5000000, password: 'x' },
    };
    const out = redactDetails(input);
    expect(out.code).toBe('EMP-1');
    expect(out.tax_id).toBe(REDACTED);
    expect(out.after.legal_name).toBe('ACME SA');
    expect(out.after.salary_base).toBe(REDACTED);
    expect(out.after.password).toBe(REDACTED);
  });

  test('no muta el objeto original', () => {
    const input = { tax_id: '123', nested: { document_number: '999' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactDetails(input);
    expect(input).toEqual(snapshot);
  });

  test('redacta dentro de arreglos y respeta claves adicionales', () => {
    const input = { list: [{ ci: '111', foo: 'ok' }], custom_field: 'secreto' };
    const out = redactDetails(input, ['custom_field']);
    expect(out.list[0].ci).toBe(REDACTED);
    expect(out.list[0].foo).toBe('ok');
    expect(out.custom_field).toBe(REDACTED);
  });

  test('es case-insensitive', () => {
    expect(redactDetails({ TaxId: '1', Password: 'p' })).toEqual({ TaxId: REDACTED, Password: REDACTED });
  });

  test('★ texto libre de auditoría: reason y change_reason quedan enmascarados', () => {
    const out = redactDetails({
      to: 'closed',
      reason: 'el empleado pidió licencia por motivos personales de salud',
      change_reason: 'traslado a la sucursal de Encarnación',
      snapshot_created: true,
    });
    // La clave se conserva como marcador, pero NUNCA el contenido libre.
    expect(out.reason).toBe(REDACTED);
    expect(out.change_reason).toBe(REDACTED); // cubierto por inclusión de 'reason'
    expect(out.to).toBe('closed');
    expect(out.snapshot_created).toBe(true);
    // Ni un fragmento del texto libre sobrevive.
    expect(JSON.stringify(out)).not.toMatch(/licencia|Encarnaci/i);
  });

  test('otras notas de texto libre (note/notes/observacion) también se enmascaran', () => {
    const out = redactDetails({ note: 'x', notes: 'y', observacion: 'z', id: 5 });
    expect(out.note).toBe(REDACTED);
    expect(out.notes).toBe(REDACTED);
    expect(out.observacion).toBe(REDACTED);
    expect(out.id).toBe(5);
  });
});
