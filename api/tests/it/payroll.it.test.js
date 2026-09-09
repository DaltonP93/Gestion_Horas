'use strict';

/**
 * payroll.it.test.js — INTEGRACIÓN (MySQL real): máquina de estados atómica,
 * cierre concurrente y unicidad de snapshot.
 */
const { describeIT, makeConn, closeAppDb } = require('./helper');

describeIT('nómina base (integración) — cierre atómico', () => {
  let conn;
  let payroll;
  const ids = {};

  beforeAll(async () => {
    conn = await makeConn();
    payroll = require('../../src/services/payrollBase');
    ids.uniq = `ITPB${Date.now() % 100000}`;
  });

  afterAll(async () => {
    if (conn) {
      await conn.query('DELETE FROM payroll_period_snapshots WHERE period_id IN (SELECT id FROM payroll_periods WHERE code LIKE ?)', [`${ids.uniq}%`]);
      await conn.query('DELETE FROM payroll_periods WHERE code LIKE ?', [`${ids.uniq}%`]);
      await conn.query('DELETE FROM payroll_concepts WHERE code LIKE ?', [`${ids.uniq}%`]);
      await conn.end();
    }
    await closeAppDb();
  });

  async function seedPeriod(suffix, status) {
    const [r] = await conn.query(
      "INSERT INTO payroll_periods (code, label, period_start, period_end, status, is_official) VALUES (?, ?, '2026-01-01', '2026-01-31', ?, 0)",
      [`${ids.uniq}${suffix}`, `P ${suffix}`, status],
    );
    return r.insertId;
  }

  test('máquina de estados: draft→preview→locked→closed', async () => {
    const id = await seedPeriod('SM', 'draft');
    expect((await payroll.transition(id, 'preview', 1)).status).toBe('preview');
    expect((await payroll.transition(id, 'locked', 1)).status).toBe('locked');
    const closed = await payroll.transition(id, 'closed', 1);
    expect(closed).toMatchObject({ status: 'closed', snapshot_created: true });
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM payroll_period_snapshots WHERE period_id = ?', [id]);
    expect(Number(n)).toBe(1);
  });

  test('cierre concurrente → exactamente uno cierra, un snapshot, el otro 409', async () => {
    const id = await seedPeriod('CC', 'locked');
    const results = await Promise.allSettled([
      payroll.transition(id, 'closed', 1),
      payroll.transition(id, 'closed', 2),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rej = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rej).toHaveLength(1);
    expect(rej[0].reason.status).toBe(409);
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM payroll_period_snapshots WHERE period_id = ?', [id]);
    expect(Number(n)).toBe(1); // UNIQUE(period_id) garantiza un único snapshot
  });

  test('transición sobre período cerrado → 409 PERIOD_CLOSED', async () => {
    const id = await seedPeriod('CL', 'locked');
    await payroll.transition(id, 'closed', 1);
    await expect(payroll.transition(id, 'preview', 1)).rejects.toMatchObject({ status: 409, code: 'PERIOD_CLOSED' });
  });

  // ── P2: createPeriod / createConcept devuelven ID numérico real ──────────────
  test('createPeriod devuelve insertId numérico real (no undefined)', async () => {
    const id = await payroll.createPeriod(
      { code: `${ids.uniq}NUM`, label: 'num', period_start: '2026-01-01', period_end: '2026-01-31' }, 1,
    );
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('createConcept devuelve insertId numérico real (no undefined)', async () => {
    const id = await payroll.createConcept(
      { code: `${ids.uniq}C`, name: 'c', kind: 'earning', version: 1, valid_from: '2026-01-01' }, 1,
    );
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });
});
