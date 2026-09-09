/**
 * peopleMigration.test.js — contrato de forma de la migración 078.
 * Aditiva, idempotente, no destructiva, sin backfill, sin tocar asistencia.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const stripComments = (s) => s.replace(/--[^\n]*/g, '');
const sql = stripComments(fs.readFileSync(path.join(DIR, '078_people_candidates_assignments.sql'), 'utf8'));

describe('migración 078 (candidatos + asignaciones)', () => {
  test('crea candidates y employee_assignments idempotentes', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS candidates/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS employee_assignments/i);
  });

  test('conversión trazable: candidates.converted_employee_id con FK SET NULL', () => {
    expect(sql).toMatch(/converted_employee_id/i);
    expect(sql).toMatch(/FOREIGN KEY \(converted_employee_id\) REFERENCES employees\(id\) ON DELETE SET NULL/i);
  });

  test('asignaciones con vigencia efectiva (valid_from/valid_to)', () => {
    expect(sql).toMatch(/valid_from\s+DATE NOT NULL/i);
    expect(sql).toMatch(/valid_to\s+DATE NULL/i);
    // Historial auditable: RESTRICT (no CASCADE) para no borrar el historial al
    // eliminar un empleado.
    expect(sql).toMatch(/FOREIGN KEY \(employee_id\)\s+REFERENCES employees\(id\)\s+ON DELETE RESTRICT/i);
    expect(sql).not.toMatch(/FOREIGN KEY \(employee_id\)\s+REFERENCES employees\(id\)\s+ON DELETE CASCADE/i);
  });

  test('candidates: alcance aditivo (company_id/branch_id) con FKs SET NULL', () => {
    expect(sql).toMatch(/company_id\s+INT NULL/i);
    expect(sql).toMatch(/branch_id\s+INT NULL/i);
    expect(sql).toMatch(/KEY ix_candidates_scope \(company_id, branch_id\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(company_id\) REFERENCES companies\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(branch_id\)\s+REFERENCES branches\(id\)\s+ON DELETE SET NULL/i);
  });

  test('access_level aditivo e idempotente en employee_documents', () => {
    expect(sql).toMatch(/ADD COLUMN access_level VARCHAR\(20\)/i);
    expect(sql).toMatch(/IF NOT EXISTS/i);
  });

  test('no destructiva y sin backfill', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE(?!\s+IF\s+EXISTS\s+mig_)/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+candidates/i);
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+employee_assignments/i);
    expect(sql).toMatch(/Migración 078 aplicada/);
  });

  test('no toca asistencia ni att2000', () => {
    expect(sql).not.toMatch(/attendance_logs/i);
    expect(sql).not.toMatch(/daily_summary/i);
    expect(sql).not.toMatch(/CHECKINOUT/i);
    expect(sql).not.toMatch(/att2000/i);
  });
});
