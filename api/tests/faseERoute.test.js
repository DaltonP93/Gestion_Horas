/**
 * faseERoute.test.js — DOBLE COMPUERTA de la consola de FASE E.
 *
 *   (a) RBAC: sólo super_admin. Un no-superadmin → 403 en TODO (lectura incluida).
 *   (b) master-flag OFF (default) → TODA acción mutante → 503; la solo-lectura
 *       sigue funcionando.
 *   (c) master-flag ON pero sin confirmación tipeada / sin backup → 400.
 *
 * No usa supertest (no está instalado): corre la cadena real de middleware del
 * router con un req/res simulados, igual que el orden que ejecuta Express.
 */

jest.mock('../src/middleware/auth', () => {
  const actual = jest.requireActual('../src/middleware/auth');
  // authenticate real hace jwt.verify; acá se inyecta el usuario directamente
  // para poder ejercitar requireSuperAdmin (RBAC) sin firmar tokens.
  return { ...actual, authenticate: (req, _res, next) => { req.user = req.__user; next(); } };
});

const mockSvc = {
  isActivationEnabled: jest.fn(),
  getStatus: jest.fn(async () => ({ read_only: true, migrations: [] })),
  getImpact: jest.fn(async () => ({ read_only: true, rows_differ: 0 })),
  listBatches: jest.fn(async () => []),
  applyMigrations: jest.fn(() => ({ ok: true, upto: '075', exit_code: 0 })),
  setForwardEnabled: jest.fn(async (v) => ({ forward_db_setting: v })),
  recalcApply: jest.fn(async () => ({ batch_id: 'B1', period: {}, scope: {}, employees: 1, rows_backed_up: 1, rows_written: 1 })),
  restoreBatch: jest.fn(async () => ({ batch_id: 'B1', rows_restored: 1, rows_deleted: 0 })),
};
jest.mock('../src/services/faseEConsoleService', () => mockSvc);
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

const router = require('../src/routes/faseE');

/** Corre la cadena de middleware del router para method+path con req/res simulados. */
function runRoute(method, path, { user, body = {}, query = {} } = {}) {
  const handlers = [];
  const errHandlers = [];
  for (const layer of router.stack) {
    if (!layer.route) {
      if (layer.handle.length >= 4) errHandlers.push(layer.handle);
      else handlers.push(layer.handle); // router.use(...) global
    } else if (layer.route.path === path && layer.route.methods[method]) {
      for (const s of layer.route.stack) handlers.push(s.handle);
      break;
    }
  }
  const req = { method, url: path, headers: {}, __user: user, body, query };
  const res = {
    statusCode: 200, body: null, finished: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.finished = true; if (this._done) this._done(); return this; },
  };
  return new Promise((resolve) => {
    res._done = () => resolve(res);
    let i = 0;
    const next = (err) => {
      if (res.finished) return;
      if (err) {
        const h = errHandlers[0];
        if (h) return h(err, req, res, () => resolve(res));
        res.statusCode = err.status || 500; res.json({ error: err.message });
        return;
      }
      const fn = handlers[i++];
      if (!fn) return resolve(res);
      try {
        const r = fn(req, res, next);
        if (r && typeof r.then === 'function') r.catch(next);
      } catch (e) { next(e); }
    };
    next();
  });
}

const SUPER = { id: 1, role: 'super_admin', username: 'root' };
const ADMIN = { id: 2, role: 'admin', username: 'adm' };

const MUTATING = [
  ['post', '/migrations/apply', { confirm: 'APLICAR MIGRACIONES', backup_confirmed: true }],
  ['post', '/forward/enable', { confirm: 'ACTIVAR MOTOR', backup_confirmed: true }],
  ['post', '/forward/disable', {}],
  ['post', '/recalc/apply', { confirm: 'RECALCULAR', backup_confirmed: true, from: '2025-01-01', to: '2025-01-31' }],
  ['post', '/recalc/restore', { confirm: 'RESTAURAR', batch_id: 'B1' }],
];

beforeEach(() => { Object.values(mockSvc).forEach((f) => f.mockClear && f.mockClear()); });

describe('(a) RBAC — sólo super_admin', () => {
  test('un admin (no superadmin) recibe 403 incluso en solo lectura', async () => {
    mockSvc.isActivationEnabled.mockReturnValue(true);
    const res = await runRoute('get', '/status', { user: ADMIN });
    expect(res.statusCode).toBe(403);
  });
  test('sin usuario → 401/403', async () => {
    const res = await runRoute('get', '/status', { user: undefined });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('(b) master-flag OFF → toda acción mutante es 503', () => {
  beforeEach(() => mockSvc.isActivationEnabled.mockReturnValue(false));

  test.each(MUTATING)('%s %s → 503', async (method, path, body) => {
    const res = await runRoute(method, path, { user: SUPER, body });
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('FASE_E_ACTIVATION_DISABLED');
  });

  test('la solo-lectura /status SÍ funciona con master-flag OFF', async () => {
    const res = await runRoute('get', '/status', { user: SUPER });
    expect(res.statusCode).toBe(200);
    expect(mockSvc.getStatus).toHaveBeenCalled();
  });
  test('la solo-lectura /impact SÍ funciona con master-flag OFF', async () => {
    const res = await runRoute('post', '/impact', { user: SUPER, body: { from: '2025-01-01', to: '2025-01-31' } });
    expect(res.statusCode).toBe(200);
    expect(mockSvc.getImpact).toHaveBeenCalled();
    // Ninguna acción mutante del servicio fue invocada.
    expect(mockSvc.recalcApply).not.toHaveBeenCalled();
    expect(mockSvc.setForwardEnabled).not.toHaveBeenCalled();
  });
});

describe('(c) master-flag ON — confirmación tipeada y backup obligatorios', () => {
  beforeEach(() => mockSvc.isActivationEnabled.mockReturnValue(true));

  test('recalc sin confirm tipeado → 400, no ejecuta', async () => {
    const res = await runRoute('post', '/recalc/apply', {
      user: SUPER, body: { backup_confirmed: true, from: '2025-01-01', to: '2025-01-31' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('TYPED_CONFIRM_REQUIRED');
    expect(mockSvc.recalcApply).not.toHaveBeenCalled();
  });

  test('recalc sin backup_confirmed → 400, no ejecuta', async () => {
    const res = await runRoute('post', '/recalc/apply', {
      user: SUPER, body: { confirm: 'RECALCULAR', from: '2025-01-01', to: '2025-01-31' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('BACKUP_CONFIRMATION_REQUIRED');
    expect(mockSvc.recalcApply).not.toHaveBeenCalled();
  });

  test('forward/enable sin frase exacta → 400', async () => {
    const res = await runRoute('post', '/forward/enable', {
      user: SUPER, body: { confirm: 'activar', backup_confirmed: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSvc.setForwardEnabled).not.toHaveBeenCalled();
  });

  test('con todo correcto, recalc SÍ ejecuta y devuelve batch_id', async () => {
    const res = await runRoute('post', '/recalc/apply', {
      user: SUPER, body: { confirm: 'RECALCULAR', backup_confirmed: true, from: '2025-01-01', to: '2025-01-31' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSvc.recalcApply).toHaveBeenCalledTimes(1);
    expect(res.body.batch_id).toBe('B1');
  });

  test('forward/disable es reversa segura: sólo master-flag (sin typed-confirm)', async () => {
    const res = await runRoute('post', '/forward/disable', { user: SUPER, body: {} });
    expect(res.statusCode).toBe(200);
    expect(mockSvc.setForwardEnabled).toHaveBeenCalledWith(false);
  });
});
