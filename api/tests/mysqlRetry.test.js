// Tests del reintento acotado ante deadlocks / lock-wait de MySQL.
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));

const { withDeadlockRetry, isDeadlock, isLockWaitTimeout, isRetryable, mysqlErrno } =
  require('../src/utils/mysqlRetry');

// Fábricas de errores MySQL tal como los expone mysql2/sequelize.
const deadlockErr = () => Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
const lockWaitErr = () => Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' });
const otherErr    = () => Object.assign(new Error('Unknown column'), { errno: 1054, code: 'ER_BAD_FIELD_ERROR' });
// Sequelize suele envolver el error real en `.original`.
const wrapped     = (inner) => Object.assign(new Error('SequelizeDatabaseError'), { original: inner });

describe('mysqlErrno / clasificación', () => {
  test('detecta 1213 y 1205 por errno directo', () => {
    expect(mysqlErrno(deadlockErr())).toBe(1213);
    expect(mysqlErrno(lockWaitErr())).toBe(1205);
  });
  test('detecta a través de error envuelto por Sequelize (.original)', () => {
    expect(mysqlErrno(wrapped(deadlockErr()))).toBe(1213);
    expect(isDeadlock(wrapped(deadlockErr()))).toBe(true);
  });
  test('detecta por code cuando no hay errno', () => {
    expect(mysqlErrno({ code: 'ER_LOCK_DEADLOCK' })).toBe(1213);
    expect(mysqlErrno({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(1205);
  });
  test('isRetryable sólo para 1213/1205', () => {
    expect(isRetryable(deadlockErr())).toBe(true);
    expect(isRetryable(lockWaitErr())).toBe(true);
    expect(isRetryable(otherErr())).toBe(false);
    expect(isLockWaitTimeout(lockWaitErr())).toBe(true);
  });
});

describe('withDeadlockRetry', () => {
  test('reintenta ante deadlock y termina OK tras un fallo transitorio', async () => {
    let calls = 0;
    const { result, attempts, retries } = await withDeadlockRetry(async () => {
      calls++;
      if (calls < 2) throw deadlockErr();
      return 'ok';
    }, { baseMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(attempts).toBe(2);
    expect(retries).toBe(1);
  });

  test('cada intento vuelve a invocar fn (transacción nueva por intento)', async () => {
    const fn = jest.fn(async () => { throw deadlockErr(); });
    await expect(withDeadlockRetry(fn, { retries: 3, baseMs: 1 })).rejects.toThrow(/Deadlock/);
    expect(fn).toHaveBeenCalledTimes(3); // 3 intentos = 3 invocaciones
  });

  test('reintenta también ante lock-wait timeout (1205)', async () => {
    let calls = 0;
    const { result } = await withDeadlockRetry(async () => {
      calls++;
      if (calls < 3) throw lockWaitErr();
      return 42;
    }, { retries: 3, baseMs: 1 });
    expect(result).toBe(42);
    expect(calls).toBe(3);
  });

  test('NO reintenta un error no-deadlock: se propaga en el primer intento', async () => {
    const fn = jest.fn(async () => { throw otherErr(); });
    await expect(withDeadlockRetry(fn, { retries: 3, baseMs: 1 })).rejects.toThrow(/Unknown column/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('respeta el máximo de intentos y lanza el último error', async () => {
    const fn = jest.fn(async () => { throw deadlockErr(); });
    await expect(withDeadlockRetry(fn, { retries: 2, baseMs: 1 })).rejects.toThrow(/Deadlock/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('éxito al primer intento no reintenta ni espera', async () => {
    const { result, attempts, retries } = await withDeadlockRetry(async () => 'listo', { baseMs: 1 });
    expect(result).toBe('listo');
    expect(attempts).toBe(1);
    expect(retries).toBe(0);
  });

  test('invoca onRetry en cada reintento con el nº de intento', async () => {
    const onRetry = jest.fn();
    let calls = 0;
    await withDeadlockRetry(async () => { calls++; if (calls < 2) throw deadlockErr(); return 1; },
      { baseMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe(1); // attempt
  });
});
