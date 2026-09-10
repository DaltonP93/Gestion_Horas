/**
 * payrollGlobalHr.test.js — P1-C (F4): la base de nómina SANDBOX es sólo para
 * roles GLOBALES de RR.HH. La guarda requireGlobalHR decide por ROL (no por
 * user_permissions), así un override no habilita nómina global a un manager, y
 * está cableada a nivel de router en /api/payroll-base.
 */
jest.mock('../src/config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../src/middleware/validate', () => ({ validate: () => (_r, _s, n) => n() }));
jest.mock('../src/services/audit', () => ({ log: jest.fn() }));

// NO se mockea ../middleware/auth: usamos la guarda REAL.
const auth = require('../src/middleware/auth');
const router = require('../src/routes/payrollBase');

function mkRes() {
  const res = {};
  res.status = jest.fn(function () { return this; });
  res.json = jest.fn(function () { return this; });
  return res;
}

describe('requireGlobalHR — decide por rol', () => {
  test.each(['manager', 'coordinator', 'supervisor', 'gestor', 'employee'])(
    'rol con alcance %s → 403 GLOBAL_HR_ONLY (sin next)',
    (role) => {
      const res = mkRes(); const next = jest.fn();
      auth.requireGlobalHR({ user: { id: 1, role } }, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0].code).toBe('GLOBAL_HR_ONLY');
      expect(next).not.toHaveBeenCalled();
    },
  );

  test.each(['super_admin', 'admin', 'gth', 'hr'])(
    'rol global %s → next() (acceso permitido)',
    (role) => {
      const res = mkRes(); const next = jest.fn();
      auth.requireGlobalHR({ user: { id: 1, role } }, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    },
  );

  test('sin usuario → 401', () => {
    const res = mkRes(); const next = jest.fn();
    auth.requireGlobalHR({}, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('cableado del router de nómina', () => {
  test('el router de payroll-base aplica requireGlobalHR a nivel router', () => {
    // router.use(authenticate); router.use(requireGlobalHR) → capas sin .route.
    const applied = router.stack.some((l) => !l.route && l.handle === auth.requireGlobalHR);
    expect(applied).toBe(true);
  });
});
