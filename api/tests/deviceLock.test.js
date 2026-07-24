// Fuerza el camino de fallback MySQL: Redis no disponible en el entorno de tests.
jest.mock('redis', () => ({
  createClient: () => ({ on() {}, connect: async () => { throw new Error('no redis'); } }),
}));

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));
jest.mock('../src/config/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const deviceLock = require('../src/services/deviceLock');

beforeEach(() => { mockQuery.mockReset(); });

describe('deviceLock (fallback MySQL)', () => {
  test('acquire inserta el lock y devuelve un handle mysql', async () => {
    mockQuery.mockResolvedValue([[]]); // CREATE TABLE, DELETE, INSERT
    const h = await deviceLock.acquire(7, { origin: 'manual', jobId: '42' });
    expect(h).toBeTruthy();
    expect(h.backend).toBe('mysql');
    expect(h.deviceId).toBe(7);
    expect(h.token).toMatch(/^[0-9a-f]{32}$/);
    // Última query es el INSERT en device_locks.
    const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO device_locks/i.test(c[0]));
    expect(insertCall).toBeTruthy();
  });

  test('acquire devuelve null si el reloj ya está ocupado (ER_DUP_ENTRY)', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/INSERT INTO device_locks/i.test(sql)) {
        const e = new Error('Duplicate entry'); e.original = { code: 'ER_DUP_ENTRY' }; throw e;
      }
      return [[]];
    });
    const h = await deviceLock.acquire(7, {});
    expect(h).toBeNull();
  });

  test('renew sólo renueva si el token coincide (affectedRows)', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const ok = await deviceLock.renew({ deviceId: 7, token: 'abc', ttlMs: 1000, backend: 'mysql' });
    expect(ok).toBe(true);
    const [sql, opts] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE device_locks/i);
    expect(opts.replacements).toContain('abc');
  });

  test('renew devuelve false si no afectó filas (otro dueño)', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const ok = await deviceLock.renew({ deviceId: 7, token: 'x', ttlMs: 1000, backend: 'mysql' });
    expect(ok).toBe(false);
  });

  test('release borra sólo por token propietario', async () => {
    mockQuery.mockResolvedValue([{}]);
    await deviceLock.release({ deviceId: 7, token: 'tok', backend: 'mysql' });
    const [sql, opts] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM device_locks/i);
    expect(opts.replacements).toEqual([7, 'tok']);
  });
});
