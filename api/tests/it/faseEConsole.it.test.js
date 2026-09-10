'use strict';

/**
 * faseEConsole.it.test.js — pruebas de INTEGRACIÓN de la consola FASE E contra
 * un MySQL efímero (IT_DB=1). Ejercen lo que un mock NO puede probar de verdad,
 * corriendo recalcApply/restoreBatch COMPLETOS contra la base:
 *
 *   · [P1-C] lease SUPERVISADO: concurrencia real, expiración por lease, heartbeat
 *     INMEDIATO en el mismo segundo (no falso LOCK_LOST), robo tras vencer, y una
 *     operación recalcApply MÁS LARGA que el TTL sostenida por el supervisor;
 *   · [P1-D] backup ATÓMICO REAL: un fallo inyectado en el 2º chunk REAL del backup
 *     dentro de recalcApply → ROLLBACK; sin header ni backups huérfanos y CERO
 *     escrituras en daily_summary;
 *   · [P1-F] paridad exacta: (a) apply escribe el plan validado SIN un segundo
 *     recálculo (motor nunca apply:true); (b) TOCTOU — cambiar asistencia tras el
 *     preview → PLAN_CHANGED sin escribir; (c) drift del estado previo de
 *     daily_summary → PLAN_CHANGED sin escribir;
 *   · [P1-E] restore TRANSACCIONAL y REINTENTABLE.
 *
 * Sin IT_DB=1 se saltan. Lease corto (3s) y BACKUP_CHUNK chico (2) fijados ANTES
 * de requerir el servicio, para ejercer el supervisor y múltiples chunks con poco.
 */

process.env.FASE_E_LOCK_LEASE_SEC = process.env.FASE_E_LOCK_LEASE_SEC || '3';
process.env.FASE_E_BACKUP_CHUNK = process.env.FASE_E_BACKUP_CHUNK || '2';

const IT_ENABLED = process.env.IT_DB === '1';
const describeIT = IT_ENABLED ? describe : describe.skip;

const { sequelize } = require('../../src/config/database');
const svc = require('../../src/services/faseEConsoleService');
const workday = require('../../src/services/workdaySummaryService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, replacements) => sequelize.query(sql, { replacements });
jest.setTimeout(60000);

// Empleados de prueba con ids altos, improbables en datos reales.
const EMP_A = 990201;
const EMP_B = 990202;
const D0 = '2025-03-10';   // rango de recálculo [D0, D1]
const D1 = '2025-03-11';

async function resetLock() {
  await q('UPDATE fase_e_console_lock SET lock_token=NULL, operation=NULL, held_by=NULL, lease_expires_at=NULL WHERE id=1');
  const [rows] = await q('SELECT COUNT(*) AS n FROM fase_e_console_lock WHERE id=1');
  if (!Number(rows[0].n)) await q('INSERT INTO fase_e_console_lock (id, lock_token) VALUES (1, NULL)');
}

async function cleanupData() {
  // Borrar lotes/backups de nuestros empleados (batch_id es aleatorio; se filtra
  // por scope o por employee_id del backup).
  const [batches] = await q(
    "SELECT batch_id FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id IN (?, ?)",
    [EMP_A, EMP_B],
  );
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
  await q(
    "INSERT INTO employees (id, code, first_name, last_name, status) VALUES (?, ?, 'IT', 'FaseE', 'active')",
    [id, `ITE${id}`],
  );
}
/** Una jornada de marcas IN/OUT para forzar que el motor materialice celdas. */
async function seedPunches(id, date, inH = '08:00:00', outH = '17:00:00') {
  await q(
    "INSERT INTO attendance_logs (employee_id, timestamp, type, source) VALUES (?, ?, 'in', 'manual'), (?, ?, 'out', 'manual')",
    [id, `${date} ${inH}`, id, `${date} ${outH}`],
  );
}

// La conexión de sequelize es compartida; se cierra UNA vez al final del archivo.
if (IT_ENABLED) afterAll(async () => { await sequelize.close().catch(() => {}); });

// ───────────────────────────────────────────────────────────────────────────
describeIT('FASE E consola — IT lease supervisado con propiedad', () => {
  beforeEach(resetLock);
  afterAll(resetLock);

  test('concurrencia real: 2º acquire → CONSOLE_BUSY; release ajeno NO libera; release propio sí', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    await svc.releaseConsoleLock('token-ajeno-inexistente'); // no libera el de t1
    await expect(svc.acquireConsoleLock('recalc', 3)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    await svc.releaseConsoleLock(t1);
    const t2 = await svc.acquireConsoleLock('restore', 4);
    expect(t2).toBeTruthy();
    await svc.releaseConsoleLock(t2);
  });

  test('[P1-C] heartbeat INMEDIATO en el mismo segundo NO da falso LOCK_LOST', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    // Dos heartbeats consecutivos dentro del mismo segundo: con sólo tocar
    // lease_expires_at (idéntico) el UPDATE cambiaría 0 filas → falso LOCK_LOST.
    // Con heartbeat_seq++ la fila SIEMPRE cambia → ambos renuevan sin lanzar.
    await expect(svc.heartbeatConsoleLock(t1)).resolves.toBeUndefined();
    await expect(svc.heartbeatConsoleLock(t1)).resolves.toBeUndefined();
    await svc.releaseConsoleLock(t1);
  });

  test('expiración por lease: sin heartbeat, el lock se re-toma tras vencer; el viejo pierde', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    await sleep(4500); // > lease (3s) sin heartbeat
    const t2 = await svc.acquireConsoleLock('recalc', 2);
    expect(t2).toBeTruthy();
    expect(t2).not.toBe(t1);
    // el dueño viejo ya no renueva (robo del lease) y su release NO toca el nuevo.
    await expect(svc.heartbeatConsoleLock(t1)).rejects.toMatchObject({ code: 'LOCK_LOST' });
    await svc.releaseConsoleLock(t1);
    const [[row]] = await q('SELECT lock_token FROM fase_e_console_lock WHERE id=1');
    expect(row.lock_token).toBe(t2); // el release del viejo NO borró el del nuevo dueño
    await svc.releaseConsoleLock(t2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describeIT('FASE E consola — IT recalcApply real (backup atómico, paridad, lease)', () => {
  beforeEach(async () => { await resetLock(); await cleanupData(); });
  afterAll(async () => { await resetLock(); await cleanupData(); });
  afterEach(() => { if (sequelize.query.mockRestore) sequelize.query.mockRestore(); });

  async function dryRunDigest() {
    const imp = await svc.getImpact({ from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A });
    expect(imp.cells_evaluated).toBeGreaterThan(0); // el motor materializó celdas
    return imp;
  }

  test('[P1-D] fallo inyectado en el 2º CHUNK REAL del backup → ROLLBACK; sin huérfanos ni escrituras', async () => {
    await seedEmployee(EMP_A);
    await seedPunches(EMP_A, D0);
    await seedPunches(EMP_A, D1);
    const imp = await dryRunDigest();

    // Inyección quirúrgica: falla SÓLO el 2º INSERT de backup; todo lo demás real.
    const orig = sequelize.query.bind(sequelize);
    let backupInserts = 0;
    jest.spyOn(sequelize, 'query').mockImplementation(async (sql, opt) => {
      if (typeof sql === 'string' && /INSERT INTO daily_summary_backup/i.test(sql)) {
        backupInserts += 1;
        if (backupInserts === 2) throw new Error('FALLO_INYECTADO_2DO_CHUNK');
      }
      return orig(sql, opt);
    });

    await expect(svc.recalcApply({
      from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest,
    })).rejects.toThrow(/FALLO_INYECTADO_2DO_CHUNK/);
    expect(backupInserts).toBe(2); // hubo un 2º chunk REAL (BACKUP_CHUNK=2)
    sequelize.query.mockRestore();

    // Rollback total: sin header, sin backups huérfanos, y CERO escrituras en daily_summary.
    const [[h]] = await q("SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id=?", [EMP_A]);
    const [[k]] = await q('SELECT COUNT(*) AS n FROM daily_summary_backup WHERE employee_id=?', [EMP_A]);
    const [[d]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    expect(Number(h.n)).toBe(0);
    expect(Number(k.n)).toBe(0);
    expect(Number(d.n)).toBe(0);
    // el lock quedó liberado (el finally corrió pese al error).
    const [[lk]] = await q('SELECT lock_token FROM fase_e_console_lock WHERE id=1');
    expect(lk.lock_token).toBeNull();
  });

  test('[P1-F] apply escribe el plan validado SIN un segundo recálculo (motor nunca apply:true)', async () => {
    await seedEmployee(EMP_A);
    await seedPunches(EMP_A, D0);
    await seedPunches(EMP_A, D1);
    // Fila previa con un valor centinela para probar que el plan REALMENTE se aplica.
    await q(
      "INSERT INTO daily_summary (employee_id, date, worked_minutes, status) VALUES (?, ?, 12345, 'present')",
      [EMP_A, D0],
    );
    const imp = await dryRunDigest();

    const applySpy = jest.spyOn(workday, 'applyResolvedRows');
    const resolveSpy = jest.spyOn(workday, 'resolveSummaryBatchForDate');

    const out = await svc.recalcApply({
      from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest,
    });
    expect(out.status).toBe('applied');
    expect(out.rows_written).toBeGreaterThan(0);
    // El motor SÓLO se invocó en modo lectura (apply:false) durante buildPlan.
    expect(resolveSpy).toHaveBeenCalled();
    expect(resolveSpy.mock.calls.every((c) => !(c[2] && c[2].apply === true))).toBe(true);
    // La escritura fue con la primitiva del plan validado.
    expect(applySpy).toHaveBeenCalled();
    // El plan REALMENTE se aplicó: el centinela 12345 ya no está (fila pisada o borrada).
    const [[c]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=? AND date=? AND worked_minutes=12345', [EMP_A, D0]);
    expect(Number(c.n)).toBe(0);
    applySpy.mockRestore(); resolveSpy.mockRestore();
  });

  test('[P1-F] TOCTOU: cambiar ASISTENCIA tras el preview → PLAN_CHANGED, sin escribir', async () => {
    await seedEmployee(EMP_A);
    await seedPunches(EMP_A, D0);
    await seedPunches(EMP_A, D1);
    const imp = await dryRunDigest();

    // Alguien carga una marca nueva DESPUÉS del preview: el target del motor cambia.
    await seedPunches(EMP_A, D0, '06:00:00', '06:30:00'); // marca temprana extra
    const imp2 = await svc.getImpact({ from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A });
    expect(imp2.plan_digest).not.toBe(imp.plan_digest); // el digest es sensible a la asistencia

    await expect(svc.recalcApply({
      from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest,
    })).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    // No se escribió nada ni quedó lote: se abortó antes de aplicar.
    const [[d]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id=?', [EMP_A]);
    const [[h]] = await q("SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id=?", [EMP_A]);
    expect(Number(d.n)).toBe(0);
    expect(Number(h.n)).toBe(0);
  });

  test('[P1-F] drift del ESTADO PREVIO de daily_summary tras el preview → PLAN_CHANGED, sin escribir', async () => {
    await seedEmployee(EMP_A);
    await seedPunches(EMP_A, D0);
    await seedPunches(EMP_A, D1);
    const imp = await dryRunDigest();

    // Alguien edita daily_summary (estado previo) DESPUÉS del preview.
    await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, status) VALUES (?, ?, 777, 'present')", [EMP_A, D0]);

    await expect(svc.recalcApply({
      from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest,
    })).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    // La fila editada sigue intacta (no se escribió): el drift se detectó antes.
    const [[r]] = await q('SELECT worked_minutes FROM daily_summary WHERE employee_id=? AND date=?', [EMP_A, D0]);
    expect(Number(r.worked_minutes)).toBe(777);
    const [[h]] = await q("SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE scope_kind='employee' AND scope_id=?", [EMP_A]);
    expect(Number(h.n)).toBe(0);
  });

  test('[P1-C] recalcApply MÁS LARGO que el TTL: el supervisor sostiene el lease; otro no entra', async () => {
    await seedEmployee(EMP_A);
    await seedPunches(EMP_A, D0);
    await seedPunches(EMP_A, D1);
    const imp = await dryRunDigest();

    // Inyecta latencia (> TTL=3s) en la escritura del plan; el supervisor debe
    // renovar el lease en 2º plano para que la operación termine igual.
    const realApply = workday.applyResolvedRows;
    const applySpy = jest.spyOn(workday, 'applyResolvedRows').mockImplementation(async (emp, rows) => {
      await sleep(4500); // 1.5x el lease
      return realApply(emp, rows);
    });

    const p = svc.recalcApply({
      from: D0, to: D1, scopeKind: 'employee', scopeId: EMP_A, userId: 1, planDigestExpected: imp.plan_digest,
    });
    // Mientras corre (> TTL), otro NO puede tomar el lock: el lease sigue vivo.
    await sleep(3800); // pasó más de un TTL desde el acquire
    await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });

    const out = await p;
    expect(out.status).toBe('applied'); // el supervisor mantuvo el lease toda la operación
    applySpy.mockRestore();
    // liberado al final.
    const [[lk]] = await q('SELECT lock_token FROM fase_e_console_lock WHERE id=1');
    expect(lk.lock_token).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describeIT('FASE E consola — IT restore transaccional y reintentable', () => {
  const BID = 'it-restore-tx';
  const EMP_C = 990301;
  const EMP_D = 990302;
  const D = '2025-01-10';

  async function cleanup() {
    await q('DELETE FROM daily_summary_backup WHERE batch_id = ?', [BID]);
    await q('DELETE FROM daily_summary_recalc_batch WHERE batch_id = ?', [BID]);
    await q('DELETE FROM daily_summary WHERE employee_id IN (?, ?)', [EMP_C, EMP_D]);
    await q('DELETE FROM employees WHERE id IN (?, ?)', [EMP_C, EMP_D]);
  }
  beforeEach(async () => { await resetLock(); await cleanup(); });
  afterAll(async () => { await resetLock(); await cleanup(); });

  async function seed({ badRowStatus }) {
    await q("INSERT INTO employees (id, code, first_name, last_name, status) VALUES (?, ?, 'IT', 'C', 'active'), (?, ?, 'IT', 'D', 'active')", [EMP_C, `ITC${EMP_C}`, EMP_D, `ITD${EMP_D}`]);
    await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, break_minutes, late_minutes, overtime_minutes, status) VALUES (?, ?, 480, 0, 0, 0, 'present')", [EMP_C, D]);
    await q("INSERT INTO daily_summary_recalc_batch (batch_id, from_date, to_date, scope_kind, status, employees, rows_backed_up) VALUES (?, ?, ?, 'all', 'applied', 2, 2)", [BID, D, D]);
    await q("INSERT INTO daily_summary_backup (batch_id, employee_id, date, existed, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes) VALUES (?, ?, ?, 1, 480, 0, 0, 0, ?, NULL)", [BID, EMP_C, D, badRowStatus || 'present']);
    await q("INSERT INTO daily_summary_backup (batch_id, employee_id, date, existed, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes) VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL)", [BID, EMP_D, D]);
    await q('UPDATE daily_summary SET worked_minutes = 999, status = "late" WHERE employee_id = ? AND date = ?', [EMP_C, D]);
    await q("INSERT INTO daily_summary (employee_id, date, worked_minutes, break_minutes, late_minutes, overtime_minutes, status) VALUES (?, ?, 300, 0, 0, 0, 'present')", [EMP_D, D]);
  }

  test('fallo a mitad → rollback (daily_summary intacto, lote sigue applied); reintento → restored', async () => {
    await seed({ badRowStatus: 'ZZZ_ESTADO_INVALIDO' }); // ENUM inválido → falla el upsert → ROLLBACK
    await expect(svc.restoreBatch({ batchId: BID, userId: 7 })).rejects.toBeTruthy();
    const [[a1]] = await q('SELECT worked_minutes FROM daily_summary WHERE employee_id = ? AND date = ?', [EMP_C, D]);
    expect(Number(a1.worked_minutes)).toBe(999);
    const [[st1]] = await q('SELECT status FROM daily_summary_recalc_batch WHERE batch_id = ?', [BID]);
    expect(st1.status).toBe('applied');

    await q('UPDATE daily_summary_backup SET status = "present" WHERE batch_id = ? AND employee_id = ?', [BID, EMP_C]);
    const out = await svc.restoreBatch({ batchId: BID, userId: 7 });
    expect(out.status).toBe('restored');
    expect(out.rows_restored).toBe(1);
    expect(out.rows_deleted).toBe(1);
    const [[a2]] = await q('SELECT worked_minutes, status FROM daily_summary WHERE employee_id = ? AND date = ?', [EMP_C, D]);
    expect(Number(a2.worked_minutes)).toBe(480);
    expect(a2.status).toBe('present');
    const [[bn]] = await q('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id = ? AND date = ?', [EMP_D, D]);
    expect(Number(bn.n)).toBe(0);
    const [[st2]] = await q('SELECT status, restored_at FROM daily_summary_recalc_batch WHERE batch_id = ?', [BID]);
    expect(st2.status).toBe('restored');
    expect(st2.restored_at).toBeTruthy();
  });
});
