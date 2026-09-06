/**
 * securityPreflight.test.js — H1: preflight de credencial demo por defecto.
 *
 * No toca ninguna BD real: se mockea `sequelize.query`. Usa bcrypt real para
 * generar/comparar hashes (mismo mecanismo que la app).
 */

const bcrypt = require('bcrypt');

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../src/config/logger');
const { assertNoDefaultAdminCredential, DEFAULT_DEMO_PASSWORD } = require('../src/config/securityPreflight');

// Hashes bcrypt reales (mismo mecanismo que authController).
const demoHash = bcrypt.hashSync(DEFAULT_DEMO_PASSWORD, 10); // credencial SIN rotar
const rotatedHash = bcrypt.hashSync('OtraClaveMuchoMasFuerte#2026', 10); // rotada

function fakeSequelize(rowsOrError) {
  return {
    query: jest.fn().mockImplementation(async () => {
      if (rowsOrError instanceof Error) throw rowsOrError;
      return [rowsOrError, {}];
    }),
  };
}

const OLD_ENV = process.env;
beforeEach(() => { jest.clearAllMocks(); process.env = { ...OLD_ENV }; });
afterAll(() => { process.env = OLD_ENV; });

test('fuera de producción: no verifica ni consulta la BD', async () => {
  process.env.NODE_ENV = 'test';
  const seq = fakeSequelize([{ username: 'admin', password_hash: demoHash }]);
  const r = await assertNoDefaultAdminCredential({ sequelize: seq });
  expect(r).toEqual({ checked: false, reason: 'non_production' });
  expect(seq.query).not.toHaveBeenCalled();
});

test('producción + credencial demo sin rotar → BLOQUEA el arranque', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'admin', password_hash: demoHash }]);
  await expect(assertNoDefaultAdminCredential({ sequelize: seq }))
    .rejects.toMatchObject({ code: 'DEFAULT_ADMIN_CREDENTIAL' });
});

test('producción + credencial rotada → OK, no bloquea', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'admin', password_hash: rotatedHash }]);
  const r = await assertNoDefaultAdminCredential({ sequelize: seq });
  expect(r).toEqual({ checked: true, ok: true });
});

test('producción + sin admins activos → OK', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([]);
  const r = await assertNoDefaultAdminCredential({ sequelize: seq });
  expect(r).toEqual({ checked: true, ok: true });
});

test('producción + error de consulta → NO bloquea (fail-open a nivel disponibilidad)', async () => {
  process.env.NODE_ENV = 'production';
  const err = Object.assign(new Error('ER_NO_SUCH_TABLE'), { code: 'ER_NO_SUCH_TABLE' });
  const seq = fakeSequelize(err);
  const r = await assertNoDefaultAdminCredential({ sequelize: seq });
  expect(r).toEqual({ checked: false, reason: 'query_error' });
  expect(logger.warn).toHaveBeenCalled();
});

test('el error de bloqueo NO expone la contraseña ni el hash', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'admin', password_hash: demoHash }]);
  let thrown;
  try { await assertNoDefaultAdminCredential({ sequelize: seq }); } catch (e) { thrown = e; }
  expect(thrown).toBeDefined();
  expect(thrown.message).not.toContain(DEFAULT_DEMO_PASSWORD);
  expect(thrown.message).not.toContain(demoHash);
  // El logger no recibió la contraseña ni el hash en ninguna llamada.
  const allLogArgs = JSON.stringify([
    ...logger.info.mock.calls, ...logger.warn.mock.calls,
    ...logger.error.mock.calls, ...logger.debug.mock.calls,
  ]);
  expect(allLogArgs).not.toContain(DEFAULT_DEMO_PASSWORD);
  expect(allLogArgs).not.toContain(demoHash);
});
