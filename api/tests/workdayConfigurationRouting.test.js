/**
 * workdayConfigurationRouting.test.js — contrato mínimo de FASE C.
 *
 * No prueba Express internamente; fija las invariantes que no deben desaparecer
 * por una edición posterior: mount, RBAC existente, auditoría y ausencia de
 * escritura sobre attendance_logs/ATT2000 en el nuevo módulo.
 */

const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'routes', 'workdayConfiguration.js'),
  'utf8',
);
const service = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'services', 'workdayConfigurationService.js'),
  'utf8',
);
const index = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'index.js'),
  'utf8',
);

describe('FASE C routing/RBAC/audit', () => {
  test('la API queda montada bajo /api/workday-config', () => {
    expect(index).toMatch(/app\.use\(['"]\/api\/workday-config['"],\s*workdayConfigurationRoutes\)/);
  });

  test('reutiliza roles y módulo configuracion existentes', () => {
    expect(route).toMatch(/authorize\(['"]super_admin['"],\s*['"]admin['"],\s*['"]gth['"],\s*['"]hr['"]\)/);
    expect(route).toMatch(/requirePermission\(['"]configuracion['"],\s*['"]view['"]\)/);
    expect(route).toMatch(/requirePermission\(['"]configuracion['"],\s*['"]update['"]\)/);
  });

  test('create/update/close registran auditoría', () => {
    expect(route).toMatch(/workday_config\.create/);
    expect(route).toMatch(/workday_config\.update/);
    expect(route).toMatch(/workday_config\.close/);
    expect(route).toMatch(/before:\s*auditSnapshot/);
    expect(route).toMatch(/after:\s*auditSnapshot/);
  });

  test('expone historial, perfil, cierre y effective-config', () => {
    expect(route).toMatch(/employees\/:employeeId\/history/);
    expect(route).toMatch(/employees\/:employeeId\/profiles/);
    expect(route).toMatch(/history\/:id\/close/);
    expect(route).toMatch(/employees\/:employeeId\/effective/);
  });
});

describe('FASE C safety del nuevo backend', () => {
  test('el servicio no escribe attendance_logs ni conoce ATT2000', () => {
    expect(service).not.toMatch(/INSERT\s+INTO\s+attendance_logs/i);
    expect(service).not.toMatch(/UPDATE\s+attendance_logs/i);
    expect(service).not.toMatch(/DELETE\s+FROM\s+attendance_logs/i);
    expect(service).not.toMatch(/CHECKINOUT/i);
    expect(service).not.toMatch(/mssql/i);
    expect(service).not.toMatch(/process\.env\.ATT/i);
  });

  test('no escribe daily_summary', () => {
    expect(service).not.toMatch(/INSERT\s+INTO\s+daily_summary/i);
    expect(service).not.toMatch(/UPDATE\s+daily_summary/i);
    expect(service).not.toMatch(/DELETE\s+FROM\s+daily_summary/i);
  });

  test('el snapshot writer no lee employees.schedule_id', () => {
    expect(service).not.toMatch(/employees[\s\S]{0,120}schedule_id/i);
  });
});
