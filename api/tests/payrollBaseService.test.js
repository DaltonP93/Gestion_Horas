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

describe('getSnapshot (evidencia de cierre, read-only)', () => {
  test('parsea el snapshot_json persistido y devuelve created_at', async () => {
    const snap = { period: { id: 1, code: '2026-01' }, headcount: { active: 42 }, active_concepts: { earnings: 3, deductions: 2 }, official: false };
    sequelize.query.mockResolvedValueOnce([[{ snapshot_json: JSON.stringify(snap), created_at: '2026-02-01T10:00:00Z' }]]);
    const out = await payroll.getSnapshot(1);
    expect(out.snapshot).toEqual(snap);
    expect(out.created_at).toBe('2026-02-01T10:00:00Z');
    // Es una sola lectura, sin escrituras.
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    expect(sequelize.query.mock.calls[0][0]).toMatch(/SELECT snapshot_json/i);
  });

  test('sin snapshot → null (período no cerrado / sin evidencia)', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    expect(await payroll.getSnapshot(99)).toBeNull();
  });

  test('snapshot_json ya objeto (driver que deserializa JSON) también funciona', async () => {
    const snap = { headcount: { active: 7 }, official: false };
    sequelize.query.mockResolvedValueOnce([[{ snapshot_json: snap, created_at: 'x' }]]);
    const out = await payroll.getSnapshot(2);
    expect(out.snapshot).toEqual(snap);
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

  test('transición inválida → 400 (bajo lock FOR UPDATE)', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'draft' }]]); // SELECT ... FOR UPDATE
    await expect(payroll.transition(1, 'closed', 9)).rejects.toMatchObject({ status: 400, code: 'INVALID_TRANSITION' });
    expect(sequelize.query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
  });

  test('período cerrado es inmutable → 409', async () => {
    sequelize.query.mockResolvedValueOnce([[{ id: 1, status: 'closed' }]]);
    await expect(payroll.transition(1, 'preview', 9)).rejects.toMatchObject({ status: 409, code: 'PERIOD_CLOSED' });
    expect(sequelize._handles.rollback).toHaveBeenCalled();
  });

  test('cerrar: UPDATE condicional (affectedRows=1) + un snapshot, commit', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, status: 'locked', code: 'P1', period_start: '2026-01-01', period_end: '2026-01-31' }]]) // FOR UPDATE
      .mockResolvedValueOnce([[{ status: 'active', n: 10 }]]) // headcount
      .mockResolvedValueOnce([[{ kind: 'earning', n: 3 }]])   // conceptCounts
      .mockResolvedValueOnce([{ affectedRows: 1 }])           // UPDATE close condicional
      .mockResolvedValueOnce([{}]);                           // INSERT snapshot
    const r = await payroll.transition(1, 'closed', 9);
    expect(r).toEqual({ id: 1, status: 'closed', snapshot_created: true });
    const upd = sequelize.query.mock.calls.find(([sql]) => /UPDATE payroll_periods SET status = 'closed'/.test(sql));
    expect(upd[0]).toMatch(/WHERE id = \? AND status = \?/);
    expect(sequelize._handles.commit).toHaveBeenCalled();
  });

  test('cierre obsoleto (affectedRows=0) → 409 STALE y rollback', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, status: 'locked', code: 'P1', period_start: '2026-01-01', period_end: '2026-01-31' }]])
      .mockResolvedValueOnce([[{ status: 'active', n: 1 }]])
      .mockResolvedValueOnce([[{ kind: 'earning', n: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // otra tx cambió el estado
    await expect(payroll.transition(1, 'closed', 9)).rejects.toMatchObject({ status: 409, code: 'STALE_TRANSITION' });
    expect(sequelize._handles.rollback).toHaveBeenCalled();
  });
});

describe('validaciones', () => {
  test('createPeriod rechaza rango invertido → 400', async () => {
    await expect(payroll.createPeriod({ code: 'P', label: 'x', period_start: '2026-02-01', period_end: '2026-01-01' }, 1))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_RANGE' });
  });
  test('createConcept rechaza vigencia invertida → 400', async () => {
    await expect(payroll.createConcept({ code: 'C', name: 'x', kind: 'earning', valid_from: '2026-05-01', valid_to: '2026-01-01' }, 1))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_VALIDITY' });
  });

  test('★ createPeriod rechaza fecha civil imposible (2025-02-29 / 2026-13-01) → 400 sin tocar BD', async () => {
    await expect(payroll.createPeriod({ code: 'P', label: 'x', period_start: '2025-02-29', period_end: '2026-01-31' }, 1))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
    await expect(payroll.createPeriod({ code: 'P', label: 'x', period_start: '2026-01-01', period_end: '2026-13-01' }, 1))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('★ createConcept rechaza fecha civil imposible (2026-02-30) → 400 sin tocar BD', async () => {
    await expect(payroll.createConcept({ code: 'C', name: 'x', kind: 'earning', valid_from: '2026-02-30' }, 1))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
    expect(sequelize.query).not.toHaveBeenCalled();
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
  test('SIEMPRE apagadas: un flag no habilita una integración inexistente', () => {
    process.env.IPS_INTEGRATION_ENABLED = 'true'; // aunque alguien lo prenda…
    const st = payroll.integrationsStatus();
    expect(st.every((a) => a.enabled === false)).toBe(true); // …sigue apagada
    expect(st.map((a) => a.key)).toEqual(expect.arrayContaining(['ips', 'mtess_reop', 'firma', 'bancos', 'notificaciones', 'pagos']));
  });
});
