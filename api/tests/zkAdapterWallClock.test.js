const mockQueryAtt2000 = jest.fn();
const mockGetTableColumns = jest.fn(async () => []);
const mockPickCol = jest.fn((_cols, name, opts = {}) => {
  const expr = `${opts.prefix || ''}${name}`;
  return opts.alias ? `${expr} AS ${opts.alias}` : expr;
});
const mockDbQuery = jest.fn();

jest.mock('../src/config/att2000', () => ({
  queryAtt2000: (...args) => mockQueryAtt2000(...args),
  getTableColumns: (...args) => mockGetTableColumns(...args),
  pickCol: (...args) => mockPickCol(...args),
}));
jest.mock('../src/config/database', () => ({
  sequelize: { query: (...args) => mockDbQuery(...args) },
}));
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const adapter = require('../src/config/zkAdapter');

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryAtt2000.mockResolvedValue([]);
});
test('fecha civil usa rango semiabierto y conserva CHECKTIME como wall-clock', async () => {
  mockQueryAtt2000.mockResolvedValue([
    { USERID: 7, CHECKTIME: '2026-09-19 23:59:59', CHECKTYPE: 'I' },
  ]);

  const rows = await adapter.fetchCheckInOut({
    dateFrom: '2026-09-19',
    dateTo: '2026-09-19',
  });

  const [sql, params] = mockQueryAtt2000.mock.calls[0];
  expect(params.dateFrom).toBe('2026-09-19 00:00:00');
  expect(params.dateToExclusive).toBe('2026-09-20 00:00:00');
  expect(params.dateTo).toBeUndefined();
  expect(sql).toMatch(/CHECKTIME >= CONVERT\(datetime, @dateFrom, 120\)/);
  expect(sql).toMatch(/CHECKTIME < CONVERT\(datetime, @dateToExclusive, 120\)/);
  expect(sql).toMatch(/CONVERT\(varchar\(19\), c\.CHECKTIME, 120\) AS CHECKTIME/);
  expect(rows[0].CHECKTIME).toBe('2026-09-19 23:59:59');
});

test('datetime civil conserva los límites exactos sin reinterpretar zona', async () => {
  await adapter.fetchCheckInOut({
    dateFrom: '2026-09-19 05:06:07',
    dateTo: '2026-09-20T08:09:10',
  });
  const [sql, params] = mockQueryAtt2000.mock.calls[0];
  expect(params.dateFrom).toBe('2026-09-19 05:06:07');
  expect(params.dateTo).toBe('2026-09-20 08:09:10');
  expect(params.dateToExclusive).toBeUndefined();
  expect(sql).toMatch(/CHECKTIME <= CONVERT\(datetime, @dateTo, 120\)/);
});

test.each([
  ['2026-02-30', '2026-03-01'],
  ['2026-09-19T05:00:00Z', '2026-09-20'],
  ['2026-09-19T05:00:00-03:00', '2026-09-20'],
])('rechaza límites que no son wall-clock civil: %s', async (dateFrom, dateTo) => {
  await expect(adapter.fetchCheckInOut({ dateFrom, dateTo })).rejects.toThrow();
  expect(mockQueryAtt2000).not.toHaveBeenCalled();
});

test('syncAttendance persiste CHECKTIME como string wall-clock', async () => {
  mockQueryAtt2000.mockResolvedValue([{
    USERID: 123,
    CHECKTIME: '2026-09-19 23:59:59',
    CHECKTYPE: 'O',
    VERIFYCODE: 1,
    SENSORID: 101,
  }]);

  mockDbQuery
    .mockResolvedValueOnce([[{ id: 55, code: '123' }]])
    .mockResolvedValueOnce([[{ id: 9, sensor_id: 101 }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  const result = await adapter.syncAttendance({
    dateFrom: '2026-09-19',
    dateTo: '2026-09-19',
    source: 'att2000',
  });

  const insertCall = mockDbQuery.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT IGNORE INTO attendance_logs')
  );
  expect(insertCall).toBeTruthy();

  const replacements = insertCall[1].replacements;
  expect(replacements[2]).toBe('2026-09-19 23:59:59');
  expect(replacements[3]).toBe('out');
  expect(replacements[4]).toBe('att2000');
  expect(result).toEqual({ imported: 1, skipped: 0, notFound: 0, total: 1 });
});
