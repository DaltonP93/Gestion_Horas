/**
 * securityPreflight.test.js — H1: preflight FAIL-CLOSED de credencial demo.
 *
 * No toca ninguna BD real: se mockea `sequelize.query`. Usa bcrypt real (mismo
 * mecanismo que la app). La prueba contra un MySQL 8 descartable real está en
 * `scripts/preflight-mysql-check.js` (evidencia fuera de la suite unitaria).
 */

const bcrypt = require('bcrypt');

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../src/config/logger');
const { assertNoDefaultAdminCredential } = require('../src/config/securityPreflight');

// La contraseña demo es pública en init.sql; acá se usa sólo para construir el hash.
const DEMO = 'Admin1234!';
const demoHash = bcrypt.hashSync(DEMO, 10);        // credencial SIN rotar
const rotatedHash = bcrypt.hashSync('Un4-Cl4v3-Fuerte-2026#', 10);

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
  const seq = fakeSequelize([{ username: 'admin', password_hash: demoHash, active: 1 }]);
  const r = await assertNoDefaultAdminCredential({ sequelize: seq });
  expect(r).toEqual({ checked: false, reason: 'non_production' });
  expect(seq.query).not.toHaveBeenCalled();
});

test('producción + credencial demo (activa) → BLOQUEA (DEFAULT_ADMIN_CREDENTIAL)', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'admin', password_hash: demoHash, active: 1 }]);
  await expect(assertNoDefaultAdminCredential({ sequelize: seq }))
    .rejects.toMatchObject({ code: 'DEFAULT_ADMIN_CREDENTIAL' });
});

test('producción + credencial demo en usuario INACTIVO → igual BLOQUEA', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'ex-admin', password_hash: demoHash, active: 0 }]);
  await expect(assertNoDefaultAdminCredential({ sequelize: seq }))
    .rejects.toMatchObject({ code: 'DEFAULT_ADMIN_CREDENTIAL' });
});

test('producción + credencial rotada → OK', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'admin', password_hash: rotatedHash, active: 1 }]);
  expect(await assertNoDefaultAdminCredential({ sequelize: seq })).toEqual({ checked: true, ok: true });
});

test('producción + sin admins → OK', async () => {
  process.env.NODE_ENV = 'production';
  expect(await assertNoDefaultAdminCredential({ sequelize: fakeSequelize([]) })).toEqual({ checked: true, ok: true });
});

test('producción + ERROR de consulta → BLOQUEA (DEFAULT_ADMIN_CHECK_UNAVAILABLE, fail-closed)', async () => {
  process.env.NODE_ENV = 'production';
  const err = Object.assign(new Error('ER_NO_SUCH_TABLE'), { code: 'ER_NO_SUCH_TABLE' });
  await expect(assertNoDefaultAdminCredential({ sequelize: fakeSequelize(err) }))
    .rejects.toMatchObject({ code: 'DEFAULT_ADMIN_CHECK_UNAVAILABLE' });
});

test('ADMIN_WEAK_PASSWORDS es ADITIVO: detecta una extra sin desactivar la incorporada', async () => {
  process.env.NODE_ENV = 'production';
  // Añade una plantilla extra; la incorporada (DEMO) sigue detectándose.
  process.env.ADMIN_WEAK_PASSWORDS = 'otra-clave-debil';
  const extraHash = bcrypt.hashSync('otra-clave-debil', 10);
  await expect(assertNoDefaultAdminCredential({ sequelize: fakeSequelize([{ username: 'a', password_hash: extraHash, active: 1 }]) }))
    .rejects.toMatchObject({ code: 'DEFAULT_ADMIN_CREDENTIAL' });
  // Y la incorporada NO se puede desactivar vía el override.
  await expect(assertNoDefaultAdminCredential({ sequelize: fakeSequelize([{ username: 'admin', password_hash: demoHash, active: 1 }]) }))
    .rejects.toMatchObject({ code: 'DEFAULT_ADMIN_CREDENTIAL' });
});

test('ni el error ni los logs exponen contraseña, hash ni username', async () => {
  process.env.NODE_ENV = 'production';
  const seq = fakeSequelize([{ username: 'admin', password_hash: demoHash, active: 1 }]);
  let thrown;
  try { await assertNoDefaultAdminCredential({ sequelize: seq }); } catch (e) { thrown = e; }
  expect(thrown.code).toBe('DEFAULT_ADMIN_CREDENTIAL');
  expect(thrown.message).not.toContain(DEMO);
  expect(thrown.message).not.toContain(demoHash);
  expect(thrown.message).not.toContain('admin@');
  const logged = JSON.stringify([...logger.error.mock.calls, ...logger.warn.mock.calls]);
  expect(logged).not.toContain(DEMO);
  expect(logged).not.toContain(demoHash);
});

test('el error de check-unavailable no incluye el detalle del error de BD', async () => {
  process.env.NODE_ENV = 'production';
  const err = Object.assign(new Error("Table 'x.users' — password=hunter2"), { code: 'ER_NO_SUCH_TABLE', sql: 'SELECT ...' });
  let thrown;
  try { await assertNoDefaultAdminCredential({ sequelize: fakeSequelize(err) }); } catch (e) { thrown = e; }
  expect(thrown.code).toBe('DEFAULT_ADMIN_CHECK_UNAVAILABLE');
  expect(thrown.message).not.toContain('hunter2');
  const logged = JSON.stringify(logger.error.mock.calls);
  expect(logged).not.toContain('hunter2');   // sólo se loguea el error_code
});
