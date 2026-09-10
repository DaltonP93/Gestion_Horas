'use strict';

/**
 * faseEConsole.it.test.js — INTEGRACIÓN de la consola FASE E contra MySQL 8
 * efímero (IT_DB=1). Ejercen los servicios COMPLETOS con BARRERAS DETERMINISTAS
 * (hooks `_setTestHook`, no sleeps ni mocks de affectedRows) para reproducir:
 *
 *   · [B1] mutación de daily_summary EXACTAMENTE tras validar el digest y antes del
 *     backup → PLAN_CHANGED (la re-lectura FOR UPDATE bajo el lock lo detecta);
 *   · [B1] concurrencia entre backup y write: la fila está FOR-UPDATE-lockeada, así
 *     que un writer concurrente NO se cuela (queda serializado, sin pisar en silencio);
 *   · [B2] robo del lease durante applyResolvedRows: el fence DB-side aborta antes de
 *     escribir; ROLLBACK TOTAL; no libera el token del nuevo dueño;
 *   · [B2] robo del lease a mitad de restoreBatch → ROLLBACK TOTAL (lote sigue applied);
 *   · [B1] backup atómico: un fallo inyectado en un INSERT de backup → ROLLBACK total;
 *   · [B3] justificación manual donde el target EFECTIVO != crudo del motor (preview
 *     y escritura coinciden);
 *   · [B4] conteos reales insert/update/delete/unchanged;
 *   · lease supervisado > TTL, concurrencia del lock, heartbeat mismo segundo.
 *
 * Sin IT_DB=1 se saltan.
 */

process.env.FASE_E_LOCK_LEASE_SEC = process.env.FASE_E_LOCK_LEASE_SEC || '3';

const IT_ENABLED = process.env.IT_DB === '1';
const describeIT = IT_ENABLED ? describe : describe.skip;

const { sequelize } = require('../../src/config/database');
const svc = require('../../src/services/faseEConsoleService');
const workday = require('../../src/services/workdaySummaryService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, replacements) => sequelize.query(sql, { replacements });
jest.setTimeout(60000);

const EMP_A = 990401;
const EMP_B = 990402;
const D0 = '2025-04-10';
const D1 = '2025-04-11';

async function resetLock() {
  await q('UPDATE fase_e_console_lock SET lock_token=NULL, operation=NULL, held_by=NULL, lease_expires_at=NULL WHERE id=1');
  const [[c]] = await q('SELECT COUNT(*) AS n FROM fase_e_console_lock WHERE id=1');
  if (!Number(c.n)) await q('INSERT INTO fase_e_console_lock (id, lock_token) VALUES (1, NULL)');
}
async function cleanupData() {
  const [batches] = await q("SELECT batch_id FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id IN (?, ?)", [EMP_A, EMP_B]);
  for (const b of batches) {
    await q('DELETE FROM daily_summary_backup WHERE batch_id = ?', [b.batch_id]);
    await q('DELETE FROM daily_summary_recalc_batch WHERE batch_id = ?', [b.batch_id]);
  }
  await q('DELETE FROM daily_summary_backup WHERE employee_id IN (?, ?)', [EMP_A, EMP_B]);
  await q('DELETE FROM daily_summary WHERE employee_id IN (?, ?)', [EMP_A, EMP_B]);
  await q('DELETE FROM attendance_logs WHERE employee_id IN (?, ?)', [EMP_A, EMP_B]);
  await q('DELETE FROM employees WHERE id IN (?, ?)', [EMP_A, EMP_B]);
}
async function seedEmployee(id) {
  await q("INSERT INTO employees (id, code, first_name, last_name, status) VALUES (?, ?, 'IT', 'FaseE', 'active')", [id, `ITE${id}`]);
}
async function seedPunches(id, date, inH = '08:00:00', outH = '17:00:00') {
  await q("INSERT INTO attendance_logs (employee_id, timestamp, type, source) VALUES (?, ?, 'in', 'manual'), (?, ?, 'out', 'manual')", [id, `${date} ${inH}`, id, `${date} ${outH}`]);
}
async function dryRun(scopeId, from = D0, to = D0) {
  const imp = await svc.getImpact({ from, to, scopeKind: 'employee', scopeId });
  expect(imp.cells_evaluated).toBeGreaterThan(0);
  return imp;
}

if (IT_ENABLED) afterAll(async () => { await sequelize.close().catch(() => {}); });
afterEach(() => svc._clearTestHooks());

// ───────────────────────────────────────────────────────────────────────────
describeIT('FASE E — IT lock/lease', () => {
  beforeEach(resetLock);
  afterAll(resetLock);

  test('concurrencia: 2º acquire → CONSOLE_BUSY; release ajeno no libera; heartbeat mismo segundo OK', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    await svc.releaseConsoleLock('ajeno');
    await expect(svc.acquireConsoleLock('recalc', 3)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    await expect(svc.heartbeatConsoleLock(t1)).resolves.toBeUndefined();
    await expect(svc.heartbeatConsoleLock(t1)).resolves.toBeUndefined(); // mismo segundo, sin falso LOCK_LOST
    await svc.releaseConsoleLock(t1);
  });

  test('expiración por lease: se re-toma tras vencer; el viejo pierde y no toca al nuevo', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    await sleep(4500);
    const t2 = await svc.acquireConsoleLock('recalc', 2);
    expect(t2).not.toBe(t1);
    await expect(svc.heartbeatConsoleLock(t1)).rejects.toMatchObject({ code: 'LOCK_LOST' });
    await svc.releaseConsoleLock(t1);
    const [[row]] = await q('SELECT lock_token FROM fase_e_console_lock WHERE id=1');
    expect(row.lock_token).toBe(t2);
    await svc.releaseConsoleLock(t2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describeIT('FASE E — IT recalcApply (co-lock, fence, barreras)', () => {
  beforeEach(async () => { await resetLock(); await cleanupData(); });
  afterAll(async () => { await resetLock(); await cleanupData(); });
  afterEach(() => { if (sequelize.query.mockRestore) sequelize.query.mockRestore(); svc._clearTestHooks(); });

  test('[B1] mutación de daily_summary tras validar el digest (afterDigest) → PLAN_CHANGED, sin escribir', async () => {
    await seedEmployee(EMP_A); await seedPunches(EMP_A, D0);
    const imp = await dryRun(EMP_A);
    // barrera: justo tras validar el digest, otro escribe daily_summary del D0.
    svc._setTestHook('afterDigest', async () => {
      svc._clearTestHooks();
      await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, status) VALUES (?, ?, 4242, 'present')", [EMP_A, D0]);
    });
    await expect(svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest }))
      .rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    // no quedó lote; la fila intrusa sigue intacta (no la pisó); nada más se escribió.
    const [[h]] = await q("SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id=?", [EMP_A]);
    expect(Number(h.n)).toBe(0);
    const [[r]] = await q('SELECT worked_minutes FROM daily_summary WHERE employee_id=? AND date=?', [EMP_A, D0]);
    expect(Number(r.worked_minutes)).toBe(4242);
  });

  test('[B1] entre backup y write la fila (existente) está lockeada: un writer concurrente NO se cuela (serializado)', async () => {
    await seedEmployee(EMP_A); await seedPunches(EMP_A, D0);
    // fila previa en D0: así el FOR UPDATE del apply la BLOQUEA (una fila inexistente
    // no se puede lockear). El motor la actualizará; el digest la incluye.
    await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, status) VALUES (?, ?, 480, 'present')", [EMP_A, D0]);
    const imp = await dryRun(EMP_A);
    let concurrent = null;
    svc._setTestHook('beforeCellWrite', async (ctx) => {
      if (ctx.date !== D0) return; // sólo en la celda D0 (la que tiene fila lockeada)
      svc._clearTestHooks();
      concurrent = q('UPDATE daily_summary SET worked_minutes = 111 WHERE employee_id=? AND date=?', [EMP_A, D0]);
      await sleep(700);
      const done = await Promise.race([concurrent.then(() => true, () => true), sleep(60).then(() => false)]);
      expect(done).toBe(false); // seguía BLOQUEADO durante el apply (fila lockeada)
    });
    const out = await svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest });
    expect(out.status).toBe('applied');
    await concurrent; // se libera tras el commit del apply
    const [[r]] = await q('SELECT worked_minutes FROM daily_summary WHERE employee_id=? AND date=?', [EMP_A, D0]);
    expect(Number(r.worked_minutes)).toBe(111); // aplicado DESPUÉS, no perdido en silencio
  });

  test('[B2] robo del lease durante applyResolvedRows (beforeCellWrite) → LOCK_LOST, ROLLBACK total, no libera al nuevo dueño', async () => {
    await seedEmployee(EMP_A); await seedPunches(EMP_A, D0);
    const imp = await dryRun(EMP_A);
    svc._setTestHook('beforeCellWrite', async () => {
      svc._clearTestHooks();
      await q("UPDATE fase_e_console_lock SET lock_token='THIEF' WHERE id=1"); // otro dueño roba el lease
    });
    await expect(svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest }))
      .rejects.toMatchObject({ code: 'LOCK_LOST' });
    // ROLLBACK total: sin lote, sin escrituras.
    const [[h]] = await q("SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id=?", [EMP_A]);
    const [[d]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    const [[k]] = await q('SELECT COUNT(*) AS n FROM daily_summary_backup WHERE employee_id=?', [EMP_A]);
    expect(Number(h.n)).toBe(0); expect(Number(d.n)).toBe(0); expect(Number(k.n)).toBe(0);
    // NO liberó el token del nuevo dueño.
    const [[lk]] = await q('SELECT lock_token FROM fase_e_console_lock WHERE id=1');
    expect(lk.lock_token).toBe('THIEF');
  });

  test('[B1] fallo inyectado en un INSERT de backup → ROLLBACK total (sin lote ni escrituras)', async () => {
    await seedEmployee(EMP_A); await seedPunches(EMP_A, D0);
    const imp = await dryRun(EMP_A);
    const orig = sequelize.query.bind(sequelize);
    let n = 0;
    jest.spyOn(sequelize, 'query').mockImplementation(async (sql, opt) => {
      if (typeof sql === 'string' && /INSERT INTO daily_summary_backup/i.test(sql)) { n += 1; if (n === 1) throw new Error('FALLO_BACKUP_INYECTADO'); }
      return orig(sql, opt);
    });
    await expect(svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest }))
      .rejects.toThrow(/FALLO_BACKUP_INYECTADO/);
    sequelize.query.mockRestore();
    const [[h]] = await q("SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id=?", [EMP_A]);
    const [[d]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    expect(Number(h.n)).toBe(0); expect(Number(d.n)).toBe(0);
    const [[lk]] = await q('SELECT lock_token FROM fase_e_console_lock WHERE id=1');
    expect(lk.lock_token).toBeNull(); // el finally liberó NUESTRO token
  });

  test('[B3] justificación manual: el target EFECTIVO (permission) != crudo del motor; preview y escritura coinciden', async () => {
    await seedEmployee(EMP_A); // SIN marcas → el motor ve el día como unconfigured
    // fila previa con jornada 'present'/480 y una JUSTIFICACIÓN manual 'permiso'.
    await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, status, justification, justification_type) VALUES (?, ?, 480, 'present', 'manual', 'permiso')", [EMP_A, D0]);
    const imp = await dryRun(EMP_A);
    // el preview anuncia un cambio (present/480 → permission/0), NO 'absent' crudo.
    const ex = imp.examples.find((e) => e.date === D0);
    expect(ex).toBeDefined();
    expect(ex.changed_fields).toEqual(expect.arrayContaining(['status', 'worked_minutes']));
    const out = await svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest });
    expect(out.status).toBe('applied');
    expect(out.rows_updated).toBeGreaterThanOrEqual(1); // [B4] la celda con fila previa → updated
    // la escritura persistió el EFECTIVO: permission con minutos en cero (justificación preservada).
    const [[r]] = await q('SELECT status, worked_minutes FROM daily_summary WHERE employee_id=? AND date=?', [EMP_A, D0]);
    expect(r.status).toBe('permission');
    expect(Number(r.worked_minutes)).toBe(0);
  });

  test('[B4] conteos reales — inserted (día trabajado) + unchanged (spillover vacío)', async () => {
    await seedEmployee(EMP_A); await seedPunches(EMP_A, D0);
    const impA = await dryRun(EMP_A);
    const outA = await svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: impA.plan_digest });
    // el día D0 (con jornada, sin fila previa) → inserted; el spillover D0-1 vacío
    // sin fila previa → noop → unchanged. Sin updates ni deletes.
    expect(outA.rows_inserted).toBeGreaterThanOrEqual(1);
    expect(outA.rows_unchanged).toBeGreaterThanOrEqual(1);
    expect(outA.rows_updated).toBe(0);
    expect(outA.rows_deleted).toBe(0);
    expect(outA.rows_written).toBe(outA.rows_inserted);
    expect(outA.cells_processed).toBe(outA.rows_inserted + outA.rows_updated + outA.rows_deleted + outA.rows_unchanged);
  });

  test('[B4] conteos reales — deleted (reconcile de fila sin justificación) + unchanged', async () => {
    // EMP_B SIN marcas → el motor ve días unconfigured. Una fila previa SIN
    // justificación en D0 → se borra (deleted). El spillover sin fila → unchanged.
    await seedEmployee(EMP_B);
    await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, status) VALUES (?, ?, 300, 'present')", [EMP_B, D0]);
    const impB = await dryRun(EMP_B);
    const outB = await svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_B, userId: 1, planDigestExpected: impB.plan_digest });
    expect(outB.rows_deleted).toBeGreaterThanOrEqual(1);
    expect(outB.rows_unchanged).toBeGreaterThanOrEqual(1);
    expect(outB.rows_updated).toBe(0);
    const [[bn]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=? AND date=?', [EMP_B, D0]);
    expect(Number(bn.n)).toBe(0); // la fila sin justificación se borró
  });
});

// ───────────────────────────────────────────────────────────────────────────
describeIT('FASE E — IT restoreBatch (seguro, fence)', () => {
  beforeEach(async () => { await resetLock(); await cleanupData(); });
  afterAll(async () => { await resetLock(); await cleanupData(); });
  afterEach(() => svc._clearTestHooks());

  async function applyBatch() {
    await seedEmployee(EMP_A); await seedPunches(EMP_A, D0);
    const imp = await dryRun(EMP_A);
    return svc.recalcApply({ from: D0, to: D0, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest });
  }

  test('[B2] robo del lease a mitad del restore → LOCK_LOST, ROLLBACK total (lote sigue applied)', async () => {
    const out = await applyBatch();
    const [[before]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    svc._setTestHook('restoreBeforeCellWrite', async () => {
      svc._clearTestHooks();
      await q("UPDATE fase_e_console_lock SET lock_token='THIEF' WHERE id=1");
    });
    await expect(svc.restoreBatch({ batchId: out.batch_id })).rejects.toMatchObject({ code: 'LOCK_LOST' });
    // el lote sigue 'applied' (restaurable), daily_summary intacto (rollback total).
    const [[st]] = await q('SELECT status FROM daily_summary_recalc_batch WHERE batch_id=?', [out.batch_id]);
    expect(st.status).toBe('applied');
    const [[after]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    expect(Number(after.n)).toBe(Number(before.n));
    await q("UPDATE fase_e_console_lock SET lock_token=NULL WHERE id=1");
  });

  test('restore normal repone y marca restored; conteos', async () => {
    const out = await applyBatch();
    const r = await svc.restoreBatch({ batchId: out.batch_id });
    expect(r.status).toBe('restored');
    expect(r.rows_deleted).toBeGreaterThanOrEqual(1); // las filas nuevas se borran
    expect(r.rows_skipped).toBe(0);
    const [[d]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    expect(Number(d.n)).toBe(0); // volvió al estado previo (sin filas)
  });

  test('cambio legítimo concurrente tras el apply → el restore lo SALTA (no lo pisa)', async () => {
    const out = await applyBatch();
    // alguien edita una celda aplicada DESPUÉS del apply.
    await q('UPDATE daily_summary SET worked_minutes = 555 WHERE employee_id=? AND date=?', [EMP_A, D0]);
    const r = await svc.restoreBatch({ batchId: out.batch_id });
    expect(r.rows_skipped).toBeGreaterThanOrEqual(1);
    // la celda cambiada sigue con el valor concurrente (no se pisó).
    const [[row]] = await q('SELECT worked_minutes FROM daily_summary WHERE employee_id=? AND date=?', [EMP_A, D0]);
    expect(Number(row.worked_minutes)).toBe(555);
  });
});
