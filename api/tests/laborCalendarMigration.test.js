/**
 * laborCalendarMigration.test.js — contrato de forma de la migración 079.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const stripComments = (s) => s.replace(/--[^\n]*/g, '');
const sql = stripComments(fs.readFileSync(path.join(DIR, '079_labor_calendars.sql'), 'utf8'));

describe('migración 079 (calendarios laborales)', () => {
  test('crea labor_calendars y calendar_exceptions idempotentes', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS labor_calendars/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS calendar_exceptions/i);
  });

  test('versión con vigencia efectiva y timezone por defecto Asunción', () => {
    expect(sql).toMatch(/valid_from\s+DATE\s+NOT NULL/i);
    expect(sql).toMatch(/valid_to\s+DATE\s+NULL/i);
    expect(sql).toMatch(/timezone\s+VARCHAR\(64\)\s+NOT NULL DEFAULT 'America\/Asuncion'/i);
  });

  test('versionado real + código por ALCANCE: UNIQUE(scope_key, code, valid_from)', () => {
    // Código único por alcance (no global): dos empresas/sucursales pueden repetir
    // el mismo code. scope_key es columna generada determinista.
    expect(sql).toMatch(/scope_key\s+VARCHAR\(41\)\s+AS \(CONCAT\(COALESCE\(company_id, 0\), ':', COALESCE\(branch_id, 0\)\)\) STORED/i);
    expect(sql).toMatch(/UNIQUE KEY uq_labor_calendars_scope_code_from \(scope_key, code, valid_from\)/i);
    // No debe existir una UNIQUE sólo por code (impediría versiones/otras empresas).
    expect(sql).not.toMatch(/UNIQUE KEY uq_labor_calendars_code \(code\)/i);
    expect(sql).not.toMatch(/UNIQUE KEY uq_labor_calendars_code_from \(code, valid_from\)/i);
    expect(sql).toMatch(/work_days\s+VARCHAR\(20\)\s+NULL/i);
  });

  test('FKs de alcance con ON DELETE RESTRICT (base de columna generada) y excepciones CASCADE', () => {
    // company_id/branch_id son base de la columna generada indexada scope_key:
    // MySQL prohíbe SET NULL/CASCADE sobre ellas → RESTRICT (además preserva la
    // config: no orfana el calendario al borrar empresa/sucursal).
    expect(sql).toMatch(/FOREIGN KEY \(company_id\) REFERENCES companies\(id\) ON DELETE RESTRICT/i);
    expect(sql).toMatch(/FOREIGN KEY \(branch_id\)  REFERENCES branches\(id\)  ON DELETE RESTRICT/i);
    expect(sql).not.toMatch(/FOREIGN KEY \(company_id\) REFERENCES companies\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(calendar_id\) REFERENCES labor_calendars\(id\) ON DELETE CASCADE/i);
  });

  test('no destructiva, sin backfill, no toca asistencia/att2000', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE(?!\s+IF\s+EXISTS\s+mig_)/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+labor_calendars/i);
    expect(sql).not.toMatch(/attendance_logs/i);
    expect(sql).not.toMatch(/daily_summary/i);
    expect(sql).not.toMatch(/CHECKINOUT/i);
    expect(sql).not.toMatch(/att2000/i);
    expect(sql).toMatch(/Migración 079 aplicada/);
  });
});
