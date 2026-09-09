/**
 * governanceMigration.test.js — contrato de forma de las migraciones 076/077.
 *
 * Como el resto de la suite corre sin MySQL, se valida por inspección del
 * fuente que las migraciones son ADITIVAS, IDEMPOTENTES y NO DESTRUCTIVAS,
 * y que no fabrican datos (sin backfill) ni tocan asistencia/att2000.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
// SQL ejecutable, sin comentarios `-- ...` (que legítimamente nombran tablas
// que la migración NO toca, al explicar su alcance).
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

const M076 = '076_governance_companies_cost_centers.sql';
const M077 = '077_audit_correlation_id.sql';

describe('migración 076 (empresas + centros de costo)', () => {
  const sql = stripComments(read(M076));

  test('crea companies y cost_centers de forma idempotente', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS companies/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cost_centers/i);
  });

  test('agrega enlaces nuleables sin backfill', () => {
    expect(sql).toMatch(/ADD COLUMN company_id INT NULL/i);
    expect(sql).toMatch(/ADD COLUMN cost_center_id INT NULL/i);
    // Sin seeding/backfill que fabrique gobierno.
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+companies/i);
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+cost_centers/i);
    expect(sql).not.toMatch(/UPDATE\s+branches/i);
    expect(sql).not.toMatch(/UPDATE\s+departments/i);
  });

  test('las FKs usan ON DELETE SET NULL (no CASCADE destructivo)', () => {
    expect(sql).toMatch(/FOREIGN KEY \(company_id\) REFERENCES companies\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/FOREIGN KEY \(cost_center_id\) REFERENCES cost_centers\(id\) ON DELETE SET NULL/i);
  });

  test('es no destructiva y usa guardas idempotentes', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE(?!\s+IF\s+EXISTS\s+mig_)/i); // sólo el DROP del procedimiento
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).toMatch(/IF NOT EXISTS/i);
    expect(sql).toMatch(/Migración 076 aplicada/);
  });

  test('no toca asistencia ni att2000', () => {
    expect(sql).not.toMatch(/attendance_logs/i);
    expect(sql).not.toMatch(/daily_summary/i);
    expect(sql).not.toMatch(/CHECKINOUT/i);
    expect(sql).not.toMatch(/att2000/i);
  });
});

describe('migración 077 (correlation id en auditoría)', () => {
  const sql = stripComments(read(M077));

  test('agrega audit_events.correlation_id de forma aditiva e idempotente', () => {
    expect(sql).toMatch(/ADD COLUMN correlation_id VARCHAR\(64\) NULL/i);
    expect(sql).toMatch(/IF NOT EXISTS/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).toMatch(/Migración 077 aplicada/);
  });
});
