/**
 * laborCalendarsRoute.test.js — writer fail-closed, resolutor read-only y
 * lectura de jornada read-only.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/services/workdayConfig', () => ({ loadWorkdayConfig: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_r, _s, n) => n(),
  requirePermission: () => (_r, _s, n) => n(),
}));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_r, _s, n) => n() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const workdayConfig = require('../src/services/workdayConfig');
const audit = require('../src/services/audit');
const router = require('../src/routes/laborCalendars');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No se encontró ${method} ${path}`);
  const s = layer.route.stack;
  return s[s.length - 1].handle;
}
function mkRes() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}
const USER = { id: 7, username: 'admin', role: 'admin' };
const ORIG = process.env.CALENDAR_WRITE_ENABLED;
beforeEach(() => jest.clearAllMocks());
afterEach(() => { if (ORIG === undefined) delete process.env.CALENDAR_WRITE_ENABLED; else process.env.CALENDAR_WRITE_ENABLED = ORIG; });

test('POST fail-closed → 503, sin DB ni auditoría', async () => {
  delete process.env.CALENDAR_WRITE_ENABLED;
  const res = mkRes(); const next = jest.fn();
  await handlerFor('post', '/')(
    { user: USER, body: { code: 'CAL', name: 'Base', valid_from: '2026-01-01' }, correlationId: 'c1', headers: {} },
    res, next,
  );
  expect(next.mock.calls[0][0].status).toBe(503);
  expect(sequelize.query).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});

test('GET /:id/effective resuelve el calendario efectivo (read-only)', async () => {
  sequelize.query
    .mockResolvedValueOnce([[{ id: 1, code: 'CAL', work_days: null, timezone: 'America/Asuncion' }]]) // getCalendar
    .mockResolvedValueOnce([[]])                        // holidaysInRange
    .mockResolvedValueOnce([[{ d: '2026-01-05', kind: 'nonworking' }]]); // exceptionsInRange
  const res = mkRes();
  await handlerFor('get', '/:id/effective')(
    { user: USER, params: { id: '1' }, query: { from: '2026-01-05', to: '2026-01-05' } },
    res, jest.fn(),
  );
  const payload = res.json.mock.calls[0][0];
  expect(payload.calendar_id).toBe(1);
  expect(payload.days[0]).toMatchObject({ date: '2026-01-05', working: false, reason: 'exception_nonworking' });
});

test('GET /:id/effective 404 si el calendario no existe', async () => {
  sequelize.query.mockResolvedValueOnce([[]]); // getCalendar → null
  const res = mkRes();
  await handlerFor('get', '/:id/effective')(
    { user: USER, params: { id: '99' }, query: { from: '2026-01-05', to: '2026-01-05' } }, res, jest.fn(),
  );
  expect(res.status).toHaveBeenCalledWith(404);
});

test('GET /effective por alcance elige la versión por fecha', async () => {
  sequelize.query
    .mockResolvedValueOnce([[]])                                  // holidaysInRange
    .mockResolvedValueOnce([[{ id: 7, work_days: '2,3,4,5,6' }]]) // pickCalendarForDate
    .mockResolvedValueOnce([[]]);                                 // exceptionsInRange
  const res = mkRes();
  await handlerFor('get', '/effective')(
    { user: USER, query: { company_id: '9', from: '2026-01-05', to: '2026-01-05' } }, res, jest.fn(),
  );
  const payload = res.json.mock.calls[0][0];
  expect(payload.days[0]).toMatchObject({ calendar_id: 7, working: true });
});

test('GET /workday/:empId distingue esquema faltante (read-only)', async () => {
  sequelize.query.mockResolvedValueOnce([[]]); // information_schema.TABLES → no existe
  const res = mkRes();
  await handlerFor('get', '/workday/:empId')(
    { user: USER, params: { empId: '50' }, query: { date: '2026-01-05' } },
    res, jest.fn(),
  );
  const payload = res.json.mock.calls[0][0];
  expect(payload).toMatchObject({ employee_id: 50, date: '2026-01-05', schema_state: 'missing' });
  expect(payload.workday).toEqual({ source: 'historical_fallback', config: null });
  expect(workdayConfig.loadWorkdayConfig).not.toHaveBeenCalled();
});
