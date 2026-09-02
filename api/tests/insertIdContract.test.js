'use strict';

/**
 * insertIdContract.test.js — el id de un INSERT crudo se lee bien.
 *
 * `sequelize.query('INSERT ...')` SIN `type` corre como RAW y, en Sequelize 6
 * con mysql, resuelve a `[insertId, affectedRows]` donde `insertId` es un
 * NÚMERO. El patrón viejo `const [r] = ...; r.insertId` leía `.insertId` de un
 * número → `undefined`: los endpoints de alta respondían `{ id: undefined }` y
 * la auditoría guardaba `entity_id: undefined`.
 *
 * Estas pruebas fijan el contrato: se mockea `sequelize.query` con la forma
 * REAL `[<insertId>, <affectedRows>]` y se verifica que el handler responde con
 * el id verdadero. Con el código viejo, estas aserciones darían `undefined`.
 */

const { insertId } = require('../src/utils/insertId');

describe('insertId — normaliza el contrato del INSERT crudo', () => {
  test('un número (forma real de Sequelize 6 raw) se devuelve tal cual', () => {
    expect(insertId(555)).toBe(555);
    expect(insertId(0)).toBe(0);
  });
  test('un objeto tipo OkPacket con .insertId también se resuelve', () => {
    expect(insertId({ insertId: 42, affectedRows: 1 })).toBe(42);
  });
  test('nulos y objetos sin insertId dan null en vez de undefined', () => {
    expect(insertId(null)).toBeNull();
    expect(insertId(undefined)).toBeNull();
    expect(insertId({})).toBeNull();
  });
});

// ---- Regresión a nivel handler, sin base ni red ---------------------------

jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const { sequelize } = require('../src/config/database');
const audit = require('../src/services/audit');

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mkRes() {
  const res = {};
  res.status = jest.fn().mockImplementation(function () { return this; });
  res.json = jest.fn().mockImplementation(function () { return this; });
  return res;
}

const USER = { id: 7, role: 'admin' };

beforeEach(() => jest.clearAllMocks());

describe('POST /api/branches — responde con el id real, no undefined', () => {
  test('el INSERT crudo devuelve [insertId, affectedRows] y el body lleva ese id', async () => {
    const branches = require('../src/routes/branches');
    // Forma REAL de un INSERT crudo en Sequelize 6 + mysql.
    sequelize.query.mockResolvedValueOnce([555, 1]);

    const res = mkRes();
    await handlerFor(branches, 'post', '/')(
      { body: { code: 'S1', name: 'Central' }, user: USER },
      res, jest.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: 555, message: 'Sede creada' });
    // Blindaje explícito contra la regresión: nunca undefined.
    expect(res.json.mock.calls[0][0].id).toBe(555);
  });
});

describe('POST /api/departments — id real en respuesta', () => {
  test('el body responde con el insertId numérico', async () => {
    const departments = require('../src/routes/departments');
    sequelize.query.mockResolvedValueOnce([777, 1]);

    const res = mkRes();
    await handlerFor(departments, 'post', '/')(
      { body: { name: 'Sistemas' }, user: USER },
      res, jest.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].id).toBe(777);
  });
});

describe('audit — entity_id recibe el id real', () => {
  test('POST /api/contracts audita con entity_id numérico, no undefined', async () => {
    const contracts = require('../src/routes/contracts');
    // Handler de alta de contrato: primer query es el INSERT.
    sequelize.query.mockResolvedValue([321, 1]);

    const res = mkRes();
    await handlerFor(contracts, 'post', '/')(
      { body: { employee_id: 1, type: 'Indefinido', start_date: '2025-01-01' }, user: USER },
      res, jest.fn(),
    );

    const call = audit.log.mock.calls.find(([a]) => a && a.action === 'contract_create');
    expect(call).toBeTruthy();
    expect(call[0].entity_id).toBe(321);
    expect(res.json.mock.calls[0][0].id).toBe(321);
  });
});
