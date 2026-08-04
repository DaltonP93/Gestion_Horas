/**
 * Runner de jobs programados: aislamiento, observabilidad y exclusión mutua.
 */
const logs = { info: [], warn: [], error: [] };
jest.mock('../src/config/logger', () => ({
  info: (msg, meta) => logs.info.push({ msg, meta }),
  warn: (msg, meta) => logs.warn.push({ msg, meta }),
  error: (msg, meta) => logs.error.push({ msg, meta }),
}));

const { runJob, cronCallback, isRunning, runningJobs } = require('../src/utils/cronRunner');

beforeEach(() => { logs.info = []; logs.warn = []; logs.error = []; });

const delay = (ms) => new Promise(r => setTimeout(r, ms));

describe('ejecución exitosa', () => {
  test('registra job, horarios, duración, resultado y cantidad procesada', async () => {
    const r = await runJob('cron_demo', async () => ({ sent: 7 }));

    expect(r.ok).toBe(true);
    expect(r.processed).toBe(7);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);

    const fin = logs.info.find(l => l.meta && l.meta.result === 'ok');
    expect(fin.meta.job).toBe('cron_demo');
    expect(fin.meta.scheduled_at).toBeTruthy();
    expect(fin.meta.started_at).toBeTruthy();
    expect(fin.meta.finished_at).toBeTruthy();
    expect(typeof fin.meta.duration_ms).toBe('number');
    expect(fin.meta.processed).toBe(7);
  });

  test('deduce la cantidad de varias formas de resultado', async () => {
    expect((await runJob('a', () => 5)).processed).toBe(5);
    expect((await runJob('b', () => ({ processed: 3 }))).processed).toBe(3);
    expect((await runJob('c', () => ({ imported: 9 }))).processed).toBe(9);
    expect((await runJob('d', () => ({ nada: true }))).processed).toBeNull();
    expect((await runJob('e', () => undefined)).processed).toBeNull();
  });
});

describe('ejecución fallida', () => {
  test('no propaga la excepción y devuelve error_code', async () => {
    const err = Object.assign(new Error('MySQL caído'), { code: 'ECONNREFUSED' });
    const r = await runJob('cron_roto', async () => { throw err; });

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe('ECONNREFUSED');
  });

  test('el log del fallo trae message, code y stack (no un objeto vacío)', async () => {
    await runJob('cron_roto', async () => {
      throw Object.assign(new Error('no se pudo leer la fuente'), { code: 'ENOTFOUND', errno: -3008 });
    });

    const l = logs.error[0];
    expect(l.meta.job).toBe('cron_roto');
    expect(l.meta.result).toBe('error');
    expect(l.meta.error_code).toBe('ENOTFOUND');
    expect(l.meta.error.message).toBe('no se pudo leer la fuente');
    expect(l.meta.error.errno).toBe(-3008);
    expect(l.meta.error.stack).toBeTruthy();
    expect(JSON.stringify(l.meta)).not.toBe('{}');
  });

  test('un throw de algo que no es Error también queda registrado', async () => {
    const r = await runJob('cron_raro', async () => { throw 'string suelto'; });

    expect(r.ok).toBe(false);
    expect(logs.error[0].meta.error.message).toBe('string suelto');
  });

  test('no filtra secretos del mensaje al log', async () => {
    await runJob('cron_secreto', async () => {
      throw new Error('falló auth con password=Secreta123 y token=eyJa.eyJb.ccc');
    });

    const json = JSON.stringify(logs.error[0].meta);
    expect(json).not.toContain('Secreta123');
    expect(json).not.toContain('eyJa.eyJb.ccc');
  });

  test('un job caído no impide que corran los demás', async () => {
    const r1 = await runJob('job_a', async () => { throw new Error('boom'); });
    const r2 = await runJob('job_b', async () => ({ processed: 1 }));

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
  });
});

describe('exclusión mutua', () => {
  test('no corre el mismo job dos veces en paralelo', async () => {
    let corridas = 0;
    const lento = async () => { corridas++; await delay(60); return corridas; };

    const p1 = runJob('job_lento', lento);
    await delay(10);
    const r2 = await runJob('job_lento', lento);   // llega mientras el primero corre
    const r1 = await p1;

    expect(r1.ok).toBe(true);
    expect(r2.skipped).toBe(true);
    expect(r2.error_code).toBe('JOB_ALREADY_RUNNING');
    expect(corridas).toBe(1);
    expect(logs.warn.some(l => l.meta && l.meta.reason === 'already_running')).toBe(true);
  });

  test('jobs distintos sí corren en paralelo', async () => {
    const [a, b] = await Promise.all([
      runJob('x', async () => { await delay(20); return 1; }),
      runJob('y', async () => { await delay(20); return 2; }),
    ]);
    expect(a.ok && b.ok).toBe(true);
  });

  test('el lock se libera aunque el job falle', async () => {
    await runJob('job_z', async () => { throw new Error('boom'); });
    expect(isRunning('job_z')).toBe(false);

    const r = await runJob('job_z', async () => 1);
    expect(r.ok).toBe(true);
  });

  test('isRunning y runningJobs reflejan el estado', async () => {
    const p = runJob('visible', async () => { await delay(40); });
    await delay(10);

    expect(isRunning('visible')).toBe(true);
    expect(runningJobs()).toContain('visible');
    await p;
    expect(isRunning('visible')).toBe(false);
  });
});

describe('cronCallback', () => {
  test('devuelve una función sincrónica: node-cron no espera promesas', () => {
    const cb = cronCallback('demo', async () => 1);
    expect(cb()).toBeUndefined();
  });

  test('un job que revienta no genera unhandledRejection', async () => {
    const capturado = [];
    const onUnhandled = (e) => capturado.push(e);
    process.on('unhandledRejection', onUnhandled);

    try {
      cronCallback('explota', async () => { throw new Error('boom'); })();
      await delay(60);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(capturado).toEqual([]);
    expect(logs.error.some(l => l.meta && l.meta.job === 'explota')).toBe(true);
  });

  test('el scheduler sigue operativo tras un fallo', async () => {
    const cb = cronCallback('reintenta', async () => { throw new Error('boom'); });
    cb();
    await delay(30);
    const ok = cronCallback('reintenta', async () => ({ processed: 2 }));
    ok();
    await delay(30);

    expect(logs.info.some(l => l.meta && l.meta.result === 'ok' && l.meta.processed === 2)).toBe(true);
  });
});

// ── Hallazgo de Codex: fallos reportados como valor de retorno ───
describe('jobs que no lanzan y devuelven el error', () => {
  test('{ date, error } de runReconciliation cuenta como fallo, no como OK', async () => {
    const r = await runJob('reconciliacion', async () => ({ date: '2026-08-04', error: 'att2000 inaccesible' }));

    expect(r.ok).toBe(false);
    expect(logs.error).toHaveLength(1);
    expect(logs.info.some(l => l.meta && l.meta.result === 'ok')).toBe(false);
    expect(logs.error[0].meta.reported_by).toBe('valor de retorno');
  });

  test('{ sent: 0, error } de las alertas diarias también', async () => {
    const r = await runJob('alertas_atrasos', async () => ({ sent: 0, error: 'SMTP caído' }));

    expect(r.ok).toBe(false);
    expect(logs.error[0].meta.error.message).toBe('SMTP caído');
  });

  test('un error embebido como Error conserva su código', async () => {
    const err = Object.assign(new Error('sin conexión'), { code: 'ETIMEDOUT' });
    const r = await runJob('x', async () => ({ error: err }));

    expect(r.error_code).toBe('ETIMEDOUT');
  });

  test('sin error embebido sigue siendo éxito', async () => {
    expect((await runJob('a', async () => ({ sent: 3 }))).ok).toBe(true);
    expect((await runJob('b', async () => ({ sent: 3, error: null }))).ok).toBe(true);
    expect((await runJob('c', async () => ({ sent: 0, error: '' }))).ok).toBe(true);
    expect((await runJob('d', async () => ({ errors: [] }))).ok).toBe(true);   // plural: no es el campo
  });

  test('se conserva la cantidad procesada aunque la corrida sea fallida', async () => {
    const r = await runJob('parcial', async () => ({ sent: 4, error: 'falló al final' }));

    expect(r.ok).toBe(false);
    expect(r.processed).toBe(4);
  });
});

describe('cantidad procesada del sync HR', () => {
  test('una importación que sólo crea no queda en processed: 0', async () => {
    // runSync() devuelve { created, updated, skipped, errors, total }.
    const r = await runJob('hr_sync_1', async () => ({
      created: 10, updated: 0, skipped: 2, errors: [], total: 12,
    }));

    expect(r.processed).toBe(12);
  });

  test('processed: 0 legítimo se conserva', async () => {
    const r = await runJob('hr_sync_2', async () => ({ created: 0, updated: 0, total: 0 }));
    expect(r.processed).toBe(0);
    expect(r.ok).toBe(true);
  });

  test('sin total, cae a los parciales', async () => {
    expect((await runJob('a2', async () => ({ sent: 5 }))).processed).toBe(5);
    expect((await runJob('b2', async () => ({ created: 7 }))).processed).toBe(7);
  });
});
