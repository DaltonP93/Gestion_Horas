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

  test('FKs de alcance con ON DELETE SET NULL y excepciones CASCADE', () => {
    expect(sql).toMatch(/FOREIGN KEY \(company_id\) REFERENCES companies\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(branch_id\)  REFERENCES branches\(id\)  ON DELETE SET NULL/i);
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
