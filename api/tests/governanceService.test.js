/**
 * governanceService.test.js — kill switch fail-closed + acceso a datos.
 */
jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));

const { sequelize } = require('../src/config/database');
const governance = require('../src/services/governance');

const ORIG = process.env.GOVERNANCE_WRITE_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.GOVERNANCE_WRITE_ENABLED;
  else process.env.GOVERNANCE_WRITE_ENABLED = ORIG;
  jest.clearAllMocks();
});

describe('kill switch de escritura (fail-closed)', () => {
  test('sólo el string exacto "true" habilita escrituras', () => {
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes', 'True']) {
      if (v === undefined) delete process.env.GOVERNANCE_WRITE_ENABLED;
      else process.env.GOVERNANCE_WRITE_ENABLED = v;
      expect(governance.isWriteEnabled()).toBe(false);
    }
    process.env.GOVERNANCE_WRITE_ENABLED = 'true';
    expect(governance.isWriteEnabled()).toBe(true);
  });

  test('assertWriteEnabled lanza 503 GOVERNANCE_WRITES_DISABLED cuando está apagado', () => {
    delete process.env.GOVERNANCE_WRITE_ENABLED;
    expect(() => governance.assertWriteEnabled()).toThrow(/sólo lectura/i);
    try {
      governance.assertWriteEnabled();
    } catch (err) {
      expect(err.status).toBe(503);
      expect(err.code).toBe('GOVERNANCE_WRITES_DISABLED');
    }
  });

  test('assertWriteEnabled no lanza cuando está habilitado', () => {
    process.env.GOVERNANCE_WRITE_ENABLED = 'true';
    expect(() => governance.assertWriteEnabled()).not.toThrow();
  });
});

describe('acceso a datos de companies', () => {
  test('listCompanies devuelve filas', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, code: 'A', legal_name: 'ACME' }]]);
    const rows = await governance.listCompanies();
    expect(rows).toHaveLength(1);
    expect(sequelize.query.mock.calls[0][0]).toMatch(/FROM companies/i);
  });

  test('createCompany inserta y devuelve insertId', async () => {
    sequelize.query.mockResolvedValueOnce([{ insertId: 42 }]);
    const id = await governance.createCompany(
      { code: 'A', legal_name: 'ACME', trade_name: null, tax_id: null, active: true }, 7,
    );
    expect(id).toBe(42);
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO companies/i);
    expect(opts.replacements).toEqual(['A', 'ACME', null, null, 1, 7]);
  });

  test('updateCompany arma el SET dinámico', async () => {
    sequelize.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const n = await governance.updateCompany(5, { legal_name: 'Nuevo', active: false });
    expect(n).toBe(1);
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE companies SET legal_name = \?, active = \? WHERE id = \?/i);
    expect(opts.replacements).toEqual(['Nuevo', 0, 5]);
  });
});

describe('acceso a datos de cost_centers', () => {
  test('companyExists=true cuando company_id es null (opcional)', async () => {
    expect(await governance.companyExists(null)).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('companyExists consulta cuando hay id', async () => {
    sequelize.query.mockResolvedValueOnce([[{ ok: 1 }]]);
    expect(await governance.companyExists(3)).toBe(true);
  });

  test('createCostCenter inserta con company_id opcional', async () => {
    sequelize.query.mockResolvedValueOnce([{ insertId: 9 }]);
    const id = await governance.createCostCenter({ company_id: null, code: 'CC1', name: 'Admin', active: true }, 1);
    expect(id).toBe(9);
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO cost_centers/i);
    expect(opts.replacements).toEqual([null, 'CC1', 'Admin', 1, 1]);
  });
});
