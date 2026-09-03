/**
 * monthlyApprovalsRoute.test.js — FASE 2, rutas del circuito de aprobación
 * mensual + firma electrónica interna.
 *
 * Sigue el patrón de la casa: se mockea `config/database` (query + transaction)
 * y `middleware/auth`, y se invocan los handlers finales sacados del router.
 *
 * Cubre:
 *   - submit crea un pendiente (estado según reglas del depto).
 *   - un coordinador de OTRO depto no puede aprobar (403).
 *   - la secuencia coordinador → gerente → RR.HH. lleva a approved.
 *   - al aprobar (final) se setea signed_by/signed_at/integrity_hash + evento sign.
 *   - aprobación concurrente: la segunda llega tarde y recibe 409.
 *   - rechazo corta el circuito.
 *   - signed-pdf sólo se genera si approved (si no, 409).
 *   - la traza NO recibe texto libre (sólo ids/rol/acción/estado).
 */

const { PassThrough } = require('stream');

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const commit = jest.fn().mockResolvedValue();
  const rollback = jest.fn().mockResolvedValue();
  const transaction = jest.fn().mockResolvedValue({ commit, rollback });
  return { sequelize: { query, transaction, _handles: { commit, rollback } } };
});

jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
}));

jest.mock('../src/services/scheduler', () => ({
  minsToHM: (m) => {
    const n = Math.max(0, Math.round(m || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  },
}));

const { sequelize } = require('../src/config/database');
const router = require('../src/routes/monthlyApprovals');

function handlerFor(method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle; // el asyncHandler final
}

function mkRes() {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn().mockImplementation(function (c) { this.statusCode = c; return this; });
  res.json = jest.fn().mockImplementation(function () { return this; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.query.mockReset();
});

// ─── submit ─────────────────────────────────────────────────────────────
describe('POST / (submit)', () => {
  test('depto con coordinador+gerente crea un pendiente', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 7, coordinator_id: 3, manager_id: 4 }]]) // resolveDepartment
      .mockResolvedValueOnce([{ insertId: 55 }])                              // INSERT
      .mockResolvedValueOnce([{}]);                                           // logEvent

    const res = mkRes();
    await handlerFor('post', '/')(
      { body: { year: 2026, month: 8, department_id: 7 }, user: { id: 10, role: 'coordinator' } },
      res, jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 55, status: 'pending', department_id: 7 }));
    // logEvent de submit, sin texto libre (5 params: approval, actor, role, action, to_state)
    const ev = sequelize.query.mock.calls.find(([s]) => /INSERT INTO monthly_report_approval_events/.test(s));
    expect(ev).toBeTruthy();
    expect(ev[1].replacements).toEqual([55, 10, 'coordinator', 'submit', 'pending']);
    expect(sequelize._handles.commit).toHaveBeenCalled();
  });

  test('período org-wide arranca en level2_ok (sólo RR.HH.)', async () => {
    sequelize.query
      .mockResolvedValueOnce([{ insertId: 60 }]) // INSERT (no hay resolveDepartment porque department_id es null)
      .mockResolvedValueOnce([{}]);              // logEvent

    const res = mkRes();
    await handlerFor('post', '/')(
      { body: { year: 2026, month: 8 }, user: { id: 10, role: 'gth' } },
      res, jest.fn()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 60, status: 'level2_ok', department_id: null }));
  });

  test('período inválido → 400 sin tocar la BD', async () => {
    const res = mkRes();
    await handlerFor('post', '/')(
      { body: { year: 2026, month: 13 }, user: { id: 10, role: 'gth' } }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('período duplicado → 409 y rollback', async () => {
    const dup = new Error('dup'); dup.original = { code: 'ER_DUP_ENTRY' };
    sequelize.query
      .mockResolvedValueOnce([[{ id: 7, coordinator_id: 3, manager_id: 4 }]])
      .mockRejectedValueOnce(dup);
    const res = mkRes();
    await handlerFor('post', '/')(
      { body: { year: 2026, month: 8, department_id: 7 }, user: { id: 10, role: 'coordinator' } }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sequelize._handles.rollback).toHaveBeenCalled();
  });
});

// ─── approve: secuencia completa ─────────────────────────────────────────
describe('POST /:id/approve (secuencia coordinador → gerente → RR.HH.)', () => {
  const DEPT = { id: 7, coordinator_id: 5, manager_id: 6 };

  test('coordinador del depto avanza pending → level1_ok', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'pending', submitted_by: 2 }]]) // FOR UPDATE
      .mockResolvedValueOnce([[{ coordinator_id: 5, manager_id: 6 }]]) // canUserActOn → departments
      .mockResolvedValueOnce([[DEPT]])                                  // resolveDepartment
      .mockResolvedValueOnce([{}])                                      // UPDATE
      .mockResolvedValueOnce([{}]);                                     // logEvent
    const res = mkRes();
    await handlerFor('post', '/:id/approve')(
      { params: { id: '1' }, user: { id: 5, role: 'coordinator' } }, res, jest.fn()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'level1_ok' }));
  });

  test('coordinador de OTRO depto → 403 y rollback', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'pending', submitted_by: 2 }]])
      .mockResolvedValueOnce([[{ coordinator_id: 999, manager_id: 6 }]]); // no es el coordinador
    const res = mkRes();
    await handlerFor('post', '/:id/approve')(
      { params: { id: '1' }, user: { id: 5, role: 'coordinator' } }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(sequelize._handles.rollback).toHaveBeenCalled();
    expect(sequelize.query.mock.calls.some(([s]) => /UPDATE monthly_report_approvals/.test(s))).toBe(false);
  });

  test('gerente del depto avanza level1_ok → level2_ok', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'level1_ok', submitted_by: 2 }]])
      .mockResolvedValueOnce([[{ coordinator_id: 5, manager_id: 6 }]]) // canUserActOn
      .mockResolvedValueOnce([[DEPT]])                                  // resolveDepartment
      .mockResolvedValueOnce([{}])                                      // UPDATE
      .mockResolvedValueOnce([{}]);                                     // logEvent
    const res = mkRes();
    await handlerFor('post', '/:id/approve')(
      { params: { id: '1' }, user: { id: 6, role: 'manager' } }, res, jest.fn()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'level2_ok' }));
  });

  test('RR.HH. (gth) firma: level2_ok → approved con signed_by/hash y evento sign', async () => {
    const dailyRows = [
      { employee_code: 'E001', date: '2026-08-01', status: 'present', first_in: '08:00:00', last_out: '17:00:00', worked_minutes: 480, late_minutes: 0, overtime_minutes: 0 },
    ];
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'level2_ok', submitted_by: 2 }]]) // FOR UPDATE
      // gth NO consulta departments en canUserActOn (bypass)
      .mockResolvedValueOnce([[DEPT]])        // resolveDepartment
      .mockResolvedValueOnce([dailyRows])     // computeReportIntegrity → daily_summary
      .mockResolvedValueOnce([{}])            // UPDATE (status+signed+hash)
      .mockResolvedValueOnce([{}])            // logEvent approve
      .mockResolvedValueOnce([{}]);           // logEvent sign
    const res = mkRes();
    await handlerFor('post', '/:id/approve')(
      { params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn()
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.status).toBe('approved');
    expect(payload.signed_by).toBe(9);
    expect(payload.integrity_hash).toMatch(/^[0-9a-f]{64}$/);

    // El UPDATE setea signed_by + integrity_hash.
    const upd = sequelize.query.mock.calls.find(([s]) => /UPDATE monthly_report_approvals[\s\S]*integrity_hash/.test(s));
    expect(upd).toBeTruthy();
    expect(upd[1].replacements[0]).toBe(9); // signed_by

    // Dos eventos: approve y sign, ambos sin texto libre.
    const evs = sequelize.query.mock.calls.filter(([s]) => /INSERT INTO monthly_report_approval_events/.test(s));
    expect(evs).toHaveLength(2);
    expect(evs[0][1].replacements).toEqual([1, 9, 'gth', 'approve', 'approved']);
    expect(evs[1][1].replacements).toEqual([1, 9, 'gth', 'sign', 'approved']);
    expect(sequelize._handles.commit).toHaveBeenCalled();
  });

  test('aprobación concurrente: la segunda encuentra el estado ya avanzado → 409', async () => {
    // El primer aprobador ya llevó el pedido a approved y comiteó; el segundo
    // toma el lock (FOR UPDATE) y lee el estado ya cerrado → 409, sin UPDATE.
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'approved', submitted_by: 2 }]]);
    const res = mkRes();
    await handlerFor('post', '/:id/approve')(
      { params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sequelize._handles.rollback).toHaveBeenCalled();
    expect(sequelize.query.mock.calls.some(([s]) => /UPDATE monthly_report_approvals/.test(s))).toBe(false);
  });

  test('id inexistente → 404', async () => {
    sequelize.query.mockResolvedValueOnce([[]]);
    const res = mkRes();
    await handlerFor('post', '/:id/approve')(
      { params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ─── reject ──────────────────────────────────────────────────────────────
describe('POST /:id/reject', () => {
  test('rechazo corta el circuito y deja evento reject sin texto libre', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'level1_ok', submitted_by: 2 }]])
      .mockResolvedValueOnce([[{ coordinator_id: 5, manager_id: 6 }]]) // canUserActOn (manager)
      .mockResolvedValueOnce([{}])                                      // UPDATE rejected
      .mockResolvedValueOnce([{}]);                                     // logEvent
    const res = mkRes();
    await handlerFor('post', '/:id/reject')(
      { params: { id: '1' }, user: { id: 6, role: 'manager' } }, res, jest.fn()
    );
    expect(res.json).toHaveBeenCalledWith({ id: 1, status: 'rejected' });
    const ev = sequelize.query.mock.calls.find(([s]) => /INSERT INTO monthly_report_approval_events/.test(s));
    expect(ev[1].replacements).toEqual([1, 6, 'manager', 'reject', 'rejected']);
  });
});

// ─── signed-pdf ──────────────────────────────────────────────────────────
describe('GET /:id/signed-pdf', () => {
  test('no disponible si el período no está aprobado → 409', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'pending', signed_by: null, signed_at: null, integrity_hash: null }]]);
    const res = mkRes();
    await handlerFor('get', '/:id/signed-pdf')(
      { params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('approved → genera un PDF con content-type application/pdf', async () => {
    const dailyRows = [
      { employee_code: 'E001', date: '2026-08-01', status: 'present', first_in: '08:00:00', last_out: '17:00:00', worked_minutes: 480, late_minutes: 0, overtime_minutes: 0 },
    ];
    // El integrity_hash guardado debe coincidir con el recalculado para
    // marcar "verificado": lo obtenemos del servicio con los mismos rows.
    const svc = require('../src/services/monthlyReportApproval');
    sequelize.query.mockResolvedValueOnce([dailyRows]);
    const { hash } = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
    sequelize.query.mockReset();

    sequelize.query
      .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'approved', signed_by: 9, signed_at: '2026-09-01 10:00:00', integrity_hash: hash }]]) // SELECT approval
      .mockResolvedValueOnce([dailyRows])                                  // computeReportIntegrity
      .mockResolvedValueOnce([[                                            // events
        { actor_user_id: 5, actor_role: 'coordinator', action: 'approve', to_state: 'level1_ok', at: '2026-08-31 09:00:00' },
        { actor_user_id: 9, actor_role: 'gth', action: 'sign', to_state: 'approved', at: '2026-09-01 10:00:00' },
      ]])
      .mockResolvedValueOnce([[                                            // summary
        { code: 'E001', days_present: 20, days_late: 1, days_absent: 0, total_worked_minutes: 9600, total_late_minutes: 15, total_overtime_minutes: 120 },
      ]]);

    const res = new PassThrough();
    res.setHeader = jest.fn();
    res.status = jest.fn().mockReturnThis();
    res.json = jest.fn().mockReturnThis();

    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => res.on('end', resolve));

    await handlerFor('get', '/:id/signed-pdf')(
      { params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn()
    );
    await done;

    const ctype = res.setHeader.mock.calls.find(([k]) => k === 'Content-Type');
    expect(ctype[1]).toBe('application/pdf');
    const buf = Buffer.concat(chunks);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(res.status).not.toHaveBeenCalledWith(409);
  });
});
