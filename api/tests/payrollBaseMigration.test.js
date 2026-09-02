/**
 * payrollBaseMigration.test.js — contrato de forma de la migración 080.
 * Aditiva, idempotente, no destructiva, sin backfill; sandbox (is_official=0).
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const stripComments = (s) => s.replace(/--[^\n]*/g, '');
const sql = stripComments(fs.readFileSync(path.join(DIR, '080_payroll_base.sql'), 'utf8'));

describe('migración 080 (base de nómina — sandbox)', () => {
  test('crea las tres tablas idempotentes', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payroll_concepts/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payroll_periods/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payroll_period_snapshots/i);
  });

  test('conceptos versionados (UNIQUE code+version) y máquina de estados', () => {
    expect(sql).toMatch(/UNIQUE KEY uq_payroll_concepts_code_ver \(code, version\)/i);
    expect(sql).toMatch(/status\s+ENUM\('draft','preview','locked','closed'\)/i);
  });

  test('sandbox: is_official default 0', () => {
    expect(sql).toMatch(/is_official\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/i);
  });

  test('snapshot: exactamente uno por período (UNIQUE) y sin CASCADE (RESTRICT)', () => {
    expect(sql).toMatch(/UNIQUE KEY uq_pps_period \(period_id\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(period_id\) REFERENCES payroll_periods\(id\) ON DELETE RESTRICT/i);
    expect(sql).not.toMatch(/FOREIGN KEY \(period_id\) REFERENCES payroll_periods\(id\) ON DELETE CASCADE/i);
  });

  test('no destructiva, sin backfill, no toca asistencia/att2000', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE(?!\s+IF\s+EXISTS\s+mig_)/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+payroll_/i);
    expect(sql).not.toMatch(/attendance_logs/i);
    expect(sql).not.toMatch(/daily_summary/i);
    expect(sql).not.toMatch(/CHECKINOUT/i);
    expect(sql).not.toMatch(/att2000/i);
    expect(sql).toMatch(/Migración 080 aplicada/);
  });
});
