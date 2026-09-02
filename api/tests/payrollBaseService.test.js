/**
 * payrollBaseService.test.js — kill-switch, máquina de estados, inmutabilidad
 * del período cerrado, snapshot de cierre, preview NO OFICIAL e integraciones
 * apagadas.
 */
jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const transaction = jest.fn().mockResolvedValue({ commit, rollback });
  return { sequelize: { query, transaction, _handles: { commit, rollback } } };
});

const { sequelize } = require('../src/config/database');
const payroll = require('../src/services/payrollBase');

const FLAGS = ['PAYROLL_WRITE_ENABLED', 'IPS_INTEGRATION_ENABLED'];
const ORIG = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
afterEach(() => {
  for (const f of FLAGS) { if (ORIG[f] === undefined) delete process.env[f]; else process.env[f] = ORIG[f]; }
  jest.clearAllMocks();
});

describe('kill switch fail-closed', () => {
  test('sólo "true" habilita; assert → 503', () => {
    delete process.env.PAYROLL_WRITE_ENABLED;
    expect(payroll.isWriteEnabled()).toBe(false);
    try { payroll.assertWriteEnabled(); throw new Error('no lanzó'); }
    catch (e) { expect(e.status).toBe(503); expect(e.code).toBe('PAYROLL_WRITES_DISABLED'); }
  });
});

describe('máquina de estados', () => {
  test('transiciones permitidas', () => {
    expect(payroll.canTransition('draft', 'preview')).toBe(true);
    expect(payroll.canTransition('preview', 'locked')).toBe(true);
    expect(payroll.canTransition('locked', 'closed')).toBe(true);
    expect(payroll.canTransition('draft', 'closed')).toBe(false);
    expect(payroll.canTransition('closed', 'draft')).toBe(false);
  });

  test('transición inválida → 400', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'draft' }]]); // getPeriod
    await expect(payroll.transition(1, 'closed', 9)).rejects.toMatchObject({ status: 400, code: 'INVALID_TRANSITION' });
  });

  test('período cerrado es inmutable → 409', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'closed' }]]);
    await expect(payroll.transition(1, 'preview', 9)).rejects.toMatchObject({ status: 409, code: 'PERIOD_CLOSED' });
  });

  test('cerrar persiste snapshot agregado en transacción', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, status: 'locked', code: 'P1', period_start: '2026-01-01', period_end: '2026-01-31' }]]) // getPeriod
      .mockResolvedValueOnce([[{ status: 'active', n: 10 }]]) // headcount
      .mockResolvedValueOnce([[{ kind: 'earning', n: 3 }]])   // conceptCounts
      .mockResolvedValueOnce([{}])  // UPDATE close
      .mockResolvedValueOnce([{}]); // INSERT snapshot
    const r = await payroll.transition(1, 'closed', 9);
    expect(r).toEqual({ id: 1, status: 'closed', snapshot_created: true });
    const insert = sequelize.query.mock.calls.find(([sql]) => /INSERT INTO payroll_period_snapshots/.test(sql));
    expect(insert).toBeTruthy();
    expect(sequelize._handles.commit).toHaveBeenCalled();
  });
});

describe('preview NO OFICIAL', () => {
  test('marca official=false, disclaimer y sólo agregados', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, code: 'P1', status: 'preview' }]]) // getPeriod
      .mockResolvedValueOnce([[{ status: 'active', n: 5 }]]) // headcount
      .mockResolvedValueOnce([[{ kind: 'deduction', n: 2 }]]); // conceptCounts
    const r = await payroll.computePreview(1);
    expect(r.official).toBe(false);
    expect(r.disclaimer).toMatch(/NO OFICIAL/i);
    expect(r.headcount.active).toBe(5);
    expect(r.active_concepts.deductions).toBe(2);
    // Sin montos ni PII individual
    expect(JSON.stringify(r)).not.toMatch(/salary|name|first_name/i);
  });
});

describe('integraciones', () => {
  test('todas apagadas por defecto', () => {
    delete process.env.IPS_INTEGRATION_ENABLED;
    const st = payroll.integrationsStatus();
    expect(st.every((a) => a.enabled === false)).toBe(true);
    expect(st.map((a) => a.key)).toEqual(expect.arrayContaining(['ips', 'mtess_reop', 'firma', 'bancos', 'notificaciones', 'pagos']));
  });
});
