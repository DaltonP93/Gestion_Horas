'use strict';

/**
 * faseEConsole.it.test.js — pruebas de INTEGRACIÓN de la consola FASE E contra
 * un MySQL efímero (IT_DB=1). Ejercen lo que un mock NO puede probar de verdad:
 *   · [P1-C] lock con PROPIEDAD: concurrencia real, expiración por lease,
 *     heartbeat que sostiene una operación MÁS LARGA que el TTL, y que una
 *     operación vieja NO libera el lock de otra;
 *   · [P1-D] backup ATÓMICO: un fallo en el 2º chunk (UNIQUE) hace ROLLBACK y no
 *     deja header ni backups huérfanos que bloqueen el rango;
 *   · [P1-E] restore TRANSACCIONAL y REINTENTABLE: un fallo a mitad hace rollback
 *     (daily_summary intacto, lote sigue restaurable), y el reintento completa.
 *
 * Sin IT_DB=1 se saltan. Usan un lease corto (FASE_E_LOCK_LEASE_SEC) fijado ANTES
 * de requerir el servicio.
 */

process.env.FASE_E_LOCK_LEASE_SEC = process.env.FASE_E_LOCK_LEASE_SEC || '3';

const IT_ENABLED = process.env.IT_DB === '1';
const describeIT = IT_ENABLED ? describe : describe.skip;

const { sequelize } = require('../../src/config/database');
const svc = require('../../src/services/faseEConsoleService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
jest.setTimeout(40000);

async function resetLock() {
  await sequelize.query('UPDATE fase_e_console_lock SET lock_token=NULL, operation=NULL, held_by=NULL, lease_expires_at=NULL WHERE id=1');
  const [rows] = await sequelize.query('SELECT COUNT(*) AS n FROM fase_e_console_lock WHERE id=1');
  if (!Number(rows[0].n)) await sequelize.query('INSERT INTO fase_e_console_lock (id, lock_token) VALUES (1, NULL)');
}

// La conexión de sequelize es compartida por los 3 describes; se cierra UNA vez
// al final del archivo (no en cada afterAll, o rompería los describes siguientes).
if (IT_ENABLED) afterAll(async () => { await sequelize.close().catch(() => {}); });

describeIT('FASE E consola — IT lock con propiedad', () => {
  beforeEach(resetLock);
  afterAll(resetLock);

  test('concurrencia real: 2º acquire → CONSOLE_BUSY; release ajeno NO libera; release propio sí', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    // una operación vieja/ajena con token equivocado NO libera el lock de t1.
    await svc.releaseConsoleLock('token-ajeno-inexistente');
    await expect(svc.acquireConsoleLock('recalc', 3)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    // sólo el dueño libera.
    await svc.releaseConsoleLock(t1);
    const t2 = await svc.acquireConsoleLock('restore', 4);
    expect(t2).toBeTruthy();
    await svc.releaseConsoleLock(t2);
  });

  test('expiración por lease: sin heartbeat, el lock se re-toma tras vencer', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    await sleep(4500); // > lease (3s) sin heartbeat
    const t2 = await svc.acquireConsoleLock('recalc', 2); // ahora sí, el lease venció
    expect(t2).toBeTruthy();
    expect(t2).not.toBe(t1);
    // el dueño viejo (t1) ya no puede renovar: perdió la propiedad.
    await expect(svc.heartbeatConsoleLock(t1)).rejects.toMatchObject({ code: 'LOCK_LOST' });
    await svc.releaseConsoleLock(t2);
  });

  test('heartbeat sostiene una operación MÁS LARGA que el TTL', async () => {
    const t1 = await svc.acquireConsoleLock('recalc', 1);
    // "operación" de ~4s (2x el lease) con heartbeat cada 1s: el lock nunca se libera.
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      await svc.heartbeatConsoleLock(t1); // no debe lanzar
      // durante toda la operación, otro no puede tomarlo.
      await expect(svc.acquireConsoleLock('recalc', 2)).rejects.toMatchObject({ code: 'CONSOLE_BUSY' });
    }
    await svc.releaseConsoleLock(t1);
    const t2 = await svc.acquireConsoleLock('recalc', 2); // liberado al final
    expect(t2).toBeTruthy();
    await svc.releaseConsoleLock(t2);
  });
});

describeIT('FASE E consola — IT backup atómico', () => {
  const BID = 'it-backup-atomic';
  beforeEach(async () => {
    await sequelize.query('DELETE FROM daily_summary_backup WHERE batch_id = ?', { replacements: [BID] });
    await sequelize.query('DELETE FROM daily_summary_recalc_batch WHERE batch_id = ?', { replacements: [BID] });
  });
  afterAll(async () => {
    await sequelize.query('DELETE FROM daily_summary_backup WHERE batch_id = ?', { replacements: [BID] });
    await sequelize.query('DELETE FROM daily_summary_recalc_batch WHERE batch_id = ?', { replacements: [BID] });
  });

  test('fallo en el 2º chunk (UNIQUE) → ROLLBACK; sin header ni backups huérfanos', async () => {
    const t = await sequelize.transaction();
    let failed = false;
    try {
      await sequelize.query(
        `INSERT INTO daily_summary_recalc_batch (batch_id, from_date, to_date, scope_kind, status, employees, rows_backed_up)
         VALUES (?, '2025-01-10', '2025-01-10', 'all', 'prepared', 1, 2)`,
        { replacements: [BID], transaction: t },
      );
      await sequelize.query(
        `INSERT INTO daily_summary_backup (batch_id, employee_id, date, existed) VALUES (?, 1, '2025-01-10', 1)`,
        { replacements: [BID], transaction: t },
      );
      // 2º "chunk": la MISMA celda → viola UNIQUE(batch_id,employee_id,date).
      await sequelize.query(
        `INSERT INTO daily_summary_backup (batch_id, employee_id, date, existed) VALUES (?, 1, '2025-01-10', 0)`,
        { replacements: [BID], transaction: t },
      );
      await t.commit();
    } catch (e) {
      failed = true;
      await t.rollback();
    }
    expect(failed).toBe(true);
    const [[b]] = await sequelize.query('SELECT COUNT(*) AS n FROM daily_summary_recalc_batch WHERE batch_id = ?', { replacements: [BID] });
    const [[k]] = await sequelize.query('SELECT COUNT(*) AS n FROM daily_summary_backup WHERE batch_id = ?', { replacements: [BID] });
    expect(Number(b.n)).toBe(0); // sin header huérfano → NO bloquea el rango
    expect(Number(k.n)).toBe(0); // sin backups huérfanos
  });
});

describeIT('FASE E consola — IT restore transaccional y reintentable', () => {
  const BID = 'it-restore-tx';
  const EMP_A = 990001; // ids altos improbables en datos reales
  const EMP_B = 990002;
  const D = '2025-01-10';

  async function cleanup() {
    await sequelize.query('DELETE FROM daily_summary_backup WHERE batch_id = ?', { replacements: [BID] });
    await sequelize.query('DELETE FROM daily_summary_recalc_batch WHERE batch_id = ?', { replacements: [BID] });
    await sequelize.query('DELETE FROM daily_summary WHERE employee_id IN (?, ?)', { replacements: [EMP_A, EMP_B] });
    await sequelize.query('DELETE FROM employees WHERE id IN (?, ?)', { replacements: [EMP_A, EMP_B] });
  }
  beforeEach(cleanup);
  afterAll(cleanup);

  async function seed({ badRowStatus }) {
    // Empleados de prueba (FK de daily_summary → employees).
    await sequelize.query(
      `INSERT INTO employees (id, code, first_name, last_name) VALUES (?, ?, 'IT', 'A'), (?, ?, 'IT', 'B')`,
      { replacements: [EMP_A, `ITA${EMP_A}`, EMP_B, `ITB${EMP_B}`] },
    );
    // Estado ORIGINAL: EMP_A tenía una fila (present/480); EMP_B no tenía fila.
    await sequelize.query(
      `INSERT INTO daily_summary (employee_id, date, worked_minutes, break_minutes, late_minutes, overtime_minutes, status)
       VALUES (?, ?, 480, 0, 0, 0, 'present')`,
      { replacements: [EMP_A, D] },
    );
    // Lote 'applied' + respaldo del estado previo (existed=1 para A, existed=0 para B).
    await sequelize.query(
      `INSERT INTO daily_summary_recalc_batch (batch_id, from_date, to_date, scope_kind, status, employees, rows_backed_up)
       VALUES (?, ?, ?, 'all', 'applied', 2, 2)`,
      { replacements: [BID, D, D] },
    );
    await sequelize.query(
      `INSERT INTO daily_summary_backup (batch_id, employee_id, date, existed, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes)
       VALUES (?, ?, ?, 1, 480, 0, 0, 0, ?, NULL)`,
      { replacements: [BID, EMP_A, D, badRowStatus || 'present'] },
    );
    await sequelize.query(
      `INSERT INTO daily_summary_backup (batch_id, employee_id, date, existed, worked_minutes, break_minutes, late_minutes, overtime_minutes, status, notes)
       VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL)`,
      { replacements: [BID, EMP_B, D] },
    );
    // Simular lo que hizo el motor: A cambió a 999; B se creó.
    await sequelize.query('UPDATE daily_summary SET worked_minutes = 999, status = "late" WHERE employee_id = ? AND date = ?', { replacements: [EMP_A, D] });
    await sequelize.query(
      `INSERT INTO daily_summary (employee_id, date, worked_minutes, break_minutes, late_minutes, overtime_minutes, status)
       VALUES (?, ?, 300, 0, 0, 0, 'present')`,
      { replacements: [EMP_B, D] },
    );
  }

  test('fallo a mitad → rollback (daily_summary intacto, lote sigue applied); reintento completa → restored', async () => {
    // 1ª pasada: el respaldo de A trae un status INVÁLIDO para el ENUM → el 2º/1er
    // upsert falla dentro de la transacción → ROLLBACK.
    await seed({ badRowStatus: 'ZZZ_ESTADO_INVALIDO' });
    await expect(svc.restoreBatch({ batchId: BID, userId: 7 })).rejects.toBeTruthy();

    // Tras el rollback: daily_summary NO se revirtió (A sigue en 999, B sigue existiendo),
    // y el lote sigue 'applied' (restaurable), NUNCA 'restoring'/'restored'.
    const [[a1]] = await sequelize.query('SELECT worked_minutes FROM daily_summary WHERE employee_id = ? AND date = ?', { replacements: [EMP_A, D] });
    expect(Number(a1.worked_minutes)).toBe(999);
    const [[st1]] = await sequelize.query('SELECT status FROM daily_summary_recalc_batch WHERE batch_id = ?', { replacements: [BID] });
    expect(st1.status).toBe('applied');

    // Corregir la fila de respaldo dañada (como haría una recuperación) y REINTENTAR.
    await sequelize.query('UPDATE daily_summary_backup SET status = "present" WHERE batch_id = ? AND employee_id = ?', { replacements: [BID, EMP_A] });
    const out = await svc.restoreBatch({ batchId: BID, userId: 7 });
    expect(out.status).toBe('restored');
    expect(out.rows_restored).toBe(1); // A repuesta
    expect(out.rows_deleted).toBe(1);  // B borrada (existed=0)

    // Estado ORIGINAL restaurado: A vuelve a 480; B ya no existe.
    const [[a2]] = await sequelize.query('SELECT worked_minutes, status FROM daily_summary WHERE employee_id = ? AND date = ?', { replacements: [EMP_A, D] });
    expect(Number(a2.worked_minutes)).toBe(480);
    expect(a2.status).toBe('present');
    const [[bn]] = await sequelize.query('SELECT COUNT(*) AS n FROM daily_summary WHERE employee_id = ? AND date = ?', { replacements: [EMP_B, D] });
    expect(Number(bn.n)).toBe(0);
    const [[st2]] = await sequelize.query('SELECT status, restored_at FROM daily_summary_recalc_batch WHERE batch_id = ?', { replacements: [BID] });
    expect(st2.status).toBe('restored');
    expect(st2.restored_at).toBeTruthy(); // restored_at sólo al finalizar
  });
});
