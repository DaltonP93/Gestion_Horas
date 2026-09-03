/**
 * monthlyReportApproval.test.js — FASE 2.
 *
 * Cubre la lógica pura del servicio de aprobación mensual + firma:
 *   - computeNeeds / initialStatus derivan los niveles del departamento y
 *     saltean los que no tienen actor (org-wide → sólo RR.HH.).
 *   - roleForState / nextApprovedState son los REUSADOS del workflow de
 *     permisos (coordinador → gerente → RR.HH.).
 *   - computeReportIntegrity produce un SHA-256 estable que CAMBIA si cambian
 *     los datos del reporte (detección de manipulación) y sólo usa el código
 *     del empleado (sin nombres) en la representación canónica.
 *   - Las tablas de la migración 081 NO guardan PII ni texto libre.
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  return { sequelize: { query } };
});

const { sequelize } = require('../src/config/database');
const svc = require('../src/services/monthlyReportApproval');

beforeEach(() => { sequelize.query.mockReset(); });

describe('computeNeeds / initialStatus', () => {
  test('depto con coordinador y gerente requiere los 3 niveles y arranca en pending', () => {
    const needs = svc.computeNeeds({ coordinator_id: 3, manager_id: 4 });
    expect(needs).toEqual({ needs_level1: 1, needs_level2: 1, needs_final: 1 });
    expect(svc.initialStatus(needs)).toBe('pending');
  });

  test('depto sin coordinador arranca directamente en level1_ok', () => {
    const needs = svc.computeNeeds({ coordinator_id: null, manager_id: 4 });
    expect(needs.needs_level1).toBe(0);
    expect(svc.initialStatus(needs)).toBe('level1_ok');
  });

  test('org-wide (sin departamento) sólo requiere firma de RR.HH.', () => {
    const needs = svc.computeNeeds(null);
    expect(needs).toEqual({ needs_level1: 0, needs_level2: 0, needs_final: 1 });
    expect(svc.initialStatus(needs)).toBe('level2_ok');
  });
});

describe('secuencia de estados reutilizada del workflow de permisos', () => {
  const needs = { needs_level1: 1, needs_level2: 1, needs_final: 1 };
  test('pending → level1_ok → level2_ok → approved', () => {
    expect(svc.nextApprovedState('pending', needs)).toBe('level1_ok');
    expect(svc.nextApprovedState('level1_ok', needs)).toBe('level2_ok');
    expect(svc.nextApprovedState('level2_ok', needs)).toBe('approved');
  });
  test('roleForState mapea coordinador → gerente → RR.HH.', () => {
    expect(svc.roleForState('pending').roles).toEqual(['coordinator']);
    expect(svc.roleForState('level1_ok').roles).toEqual(['manager']);
    expect(svc.roleForState('level2_ok').roles).toEqual(expect.arrayContaining(['admin', 'gth']));
  });
});

describe('canUserActOn reutiliza la validación de depto de permisos', () => {
  test('coordinador de OTRO depto no puede actuar', async () => {
    sequelize.query.mockResolvedValueOnce([[{ coordinator_id: 999, manager_id: 4 }]]);
    const ok = await svc.canUserActOn(
      { id: 5, role: 'coordinator' },
      { status: 'pending', department_id: 7 }
    );
    expect(ok).toBe(false);
  });

  test('coordinador del depto sí puede actuar en pending', async () => {
    sequelize.query.mockResolvedValueOnce([[{ coordinator_id: 5, manager_id: 4 }]]);
    const ok = await svc.canUserActOn(
      { id: 5, role: 'coordinator' },
      { status: 'pending', department_id: 7 }
    );
    expect(ok).toBe(true);
  });

  test('RR.HH. (gth) puede destrabar cualquier nivel sin consultar depto', async () => {
    const ok = await svc.canUserActOn(
      { id: 9, role: 'gth' },
      { status: 'level2_ok', department_id: 7 }
    );
    expect(ok).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('computeReportIntegrity — hash estable y sensible a cambios', () => {
  const rowsA = [
    { employee_code: 'E001', date: '2026-08-01', status: 'present', first_in: '08:00:00', last_out: '17:00:00', worked_minutes: 480, late_minutes: 0, overtime_minutes: 0 },
    { employee_code: 'E002', date: '2026-08-01', status: 'late', first_in: '08:15:00', last_out: '17:00:00', worked_minutes: 465, late_minutes: 15, overtime_minutes: 0 },
  ];

  test('mismos datos → mismo hash (determinístico)', async () => {
    sequelize.query.mockResolvedValueOnce([rowsA]);
    const a = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
    sequelize.query.mockResolvedValueOnce([rowsA]);
    const b = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('un minuto de atraso distinto cambia el hash', async () => {
    sequelize.query.mockResolvedValueOnce([rowsA]);
    const base = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });

    const rowsB = JSON.parse(JSON.stringify(rowsA));
    rowsB[1].late_minutes = 16; // el dato subyacente cambió
    sequelize.query.mockResolvedValueOnce([rowsB]);
    const changed = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });

    expect(changed.hash).not.toBe(base.hash);
  });

  test('el alcance (department_id) forma parte del hash', async () => {
    sequelize.query.mockResolvedValueOnce([rowsA]);
    const dept = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
    sequelize.query.mockResolvedValueOnce([rowsA]);
    const org = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: null });
    expect(dept.hash).not.toBe(org.hash);
  });

  test('la representación canónica no incluye nombres, sólo el código', async () => {
    sequelize.query.mockResolvedValueOnce([rowsA]);
    const { canonical } = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
    expect(canonical).toContain('E001');
    expect(canonical).not.toMatch(/first_name|last_name|nombre/i);
    // La query de origen es daily_summary, nunca att2000/CHECKINOUT.
    const sql = sequelize.query.mock.calls[0][0];
    expect(sql).toMatch(/daily_summary/);
    expect(sql).not.toMatch(/CHECKINOUT|att2000/i);
  });
});

describe('migración 081 — sin PII ni texto libre', () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', '..', 'database', 'migrations', '081_monthly_report_approvals.sql'),
    'utf8'
  );

  test('es idempotente y aditiva (CREATE TABLE IF NOT EXISTS, sin DROP/ALTER de tablas existentes)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS monthly_report_approvals/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS monthly_report_approval_events/);
    // No debe alterar ni borrar tablas existentes (los DROP sólo aparecen en el ROLLBACK comentado).
    const sinComentarios = sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');
    expect(sinComentarios).not.toMatch(/\bALTER TABLE\b/i);
    expect(sinComentarios).not.toMatch(/\bDROP TABLE\b/i);
    expect(sinComentarios).not.toMatch(/\bDELETE\s+FROM\b/i); // sin DML DELETE (ON DELETE RESTRICT sí es válido)
    expect(sinComentarios).not.toMatch(/attendance_logs|daily_summary|CHECKINOUT/i);
  });

  test('FKs con ON DELETE RESTRICT para no perder traza', () => {
    const restricts = sql.match(/ON DELETE RESTRICT/g) || [];
    expect(restricts.length).toBeGreaterThanOrEqual(5);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });

  test('las tablas no tienen columnas de nombres ni comentarios libres', () => {
    const sinComentarios = sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');
    for (const prohibido of ['note', 'notes', 'comment', 'comentario', 'observ', 'first_name', 'last_name', 'employee_name', 'description']) {
      expect(sinComentarios.toLowerCase()).not.toContain(prohibido);
    }
    // Lo que SÍ debe guardar la firma:
    expect(sql).toMatch(/integrity_hash/);
    expect(sql).toMatch(/signed_by/);
    expect(sql).toMatch(/signed_at/);
  });

  test('la traza guarda ids/rol/acción/estado/timestamp, no texto libre', () => {
    const start = sql.indexOf('monthly_report_approval_events');
    const block = sql.slice(start);
    for (const col of ['actor_user_id', 'actor_role', 'action', 'to_state', 'at']) {
      expect(block).toContain(col);
    }
  });
});
