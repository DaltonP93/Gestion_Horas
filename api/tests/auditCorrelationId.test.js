/**
 * auditCorrelationId.test.js — auditoría con correlation id y degradación
 * ante columna ausente (migración 077 pendiente).
 */
jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');

beforeEach(() => {
  jest.clearAllMocks();
  audit._resetCapability();
});

test('persiste correlation_id cuando la columna existe', async () => {
  sequelize.query.mockResolvedValueOnce([{}]);
  await audit.log({
    req: { correlationId: 'corr-123', headers: {} },
    user: { id: 1, username: 'admin' },
    action: 'company.create', entity: 'company', entity_id: 10,
  });
  expect(sequelize.query).toHaveBeenCalledTimes(1);
  const [sql, opts] = sequelize.query.mock.calls[0];
  expect(sql).toMatch(/correlation_id/);
  expect(opts.replacements).toContain('corr-123');
});

test('degrada al INSERT legacy si falta la columna (ER_BAD_FIELD_ERROR)', async () => {
  const badField = Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' });
  sequelize.query
    .mockRejectedValueOnce(badField) // intento con correlation_id
    .mockResolvedValueOnce([{}]);    // reintento legacy
  await audit.log({
    req: { correlationId: 'corr-x', headers: {} },
    user: { id: 1, username: 'admin' },
    action: 'company.update', entity: 'company', entity_id: 11,
  });
  expect(sequelize.query).toHaveBeenCalledTimes(2);
  const secondSql = sequelize.query.mock.calls[1][0];
  expect(secondSql).not.toMatch(/correlation_id/);

  // Una vez detectada la ausencia, va directo al legacy sin reintentar.
  sequelize.query.mockResolvedValueOnce([{}]);
  await audit.log({ req: { headers: {} }, user: { id: 1, username: 'admin' }, action: 'x' });
  expect(sequelize.query).toHaveBeenCalledTimes(3);
  expect(sequelize.query.mock.calls[2][0]).not.toMatch(/correlation_id/);
});

test('nunca lanza aunque el INSERT falle por otra razón', async () => {
  sequelize.query.mockRejectedValueOnce(new Error('db down'));
  await expect(
    audit.log({ req: { headers: {} }, user: { id: 1 }, action: 'x' }),
  ).resolves.toBeUndefined();
});
