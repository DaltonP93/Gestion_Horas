const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));

const syncJobs = require('../src/services/syncJobs');

beforeEach(() => { mockQuery.mockReset(); });

describe('syncJobs.enqueue', () => {
  test('crea un trabajo por reloj y devuelve batch_id', async () => {
    mockQuery.mockResolvedValue([{ insertId: 101 }]);
    const out = await syncJobs.enqueue({ deviceIds: [3, 5], from: '2026-07-01', to: '2026-07-02', origin: 'manual', userId: 9 });
    expect(out.batch_id).toMatch(/^[0-9a-f]{16}$/);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]).toEqual({ id: 101, device_id: 3 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO sync_jobs/i);
  });

  test('rechaza sin deviceIds', async () => {
    await expect(syncJobs.enqueue({ deviceIds: [] })).rejects.toThrow(/deviceIds/);
  });
});

describe('syncJobs.claimNext', () => {
  test('sin candidatos devuelve null', async () => {
    mockQuery.mockResolvedValueOnce([[undefined]]); // SELECT candidato vacío
    const job = await syncJobs.claimNext();
    expect(job).toBeNull();
  });

  test('candidato con cancel_requested se marca cancelled', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 7, device_id: 2, cancel_requested: 1 }]]) // SELECT
      .mockResolvedValueOnce([{ affectedRows: 1 }]);                            // UPDATE cancelled
    const res = await syncJobs.claimNext();
    expect(res).toEqual({ cancelled: 7 });
    expect(mockQuery.mock.calls[1][0]).toMatch(/status = 'cancelled'/i);
  });

  test('candidato normal se marca running y se devuelve el job', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 8, device_id: 2, cancel_requested: 0 }]]) // SELECT candidato
      .mockResolvedValueOnce([{ affectedRows: 1 }])                            // UPDATE running
      .mockResolvedValueOnce([[{ id: 8, device_id: 2, status: 'running', result: null }]]); // get()
    const job = await syncJobs.claimNext();
    expect(job).toMatchObject({ id: 8, status: 'running' });
    expect(mockQuery.mock.calls[1][0]).toMatch(/status = 'running'/i);
  });
});

describe('syncJobs.requestCancel / finish', () => {
  test('requestCancel true si afectó filas', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
    expect(await syncJobs.requestCancel(4)).toBe(true);
  });
  test('requestCancel false si no afectó', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);
    expect(await syncJobs.requestCancel(4)).toBe(false);
  });
  test('finish serializa result a JSON', async () => {
    mockQuery.mockResolvedValueOnce([{}]);
    await syncJobs.finish(5, { status: 'success', result: { imported: 3 }, attemptsExecuted: 2 });
    const [sql, opts] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE sync_jobs/i);
    expect(opts.replacements[0]).toBe('success');
    expect(opts.replacements[1]).toBe(JSON.stringify({ imported: 3 }));
  });
});
