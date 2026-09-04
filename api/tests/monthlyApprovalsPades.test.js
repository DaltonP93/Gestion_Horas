/**
 * monthlyApprovalsPades.test.js — FASE 2, integración del modo pades_local en
 * el endpoint GET /:id/signed-pdf.
 *
 * El adaptador padesSigner se MOCKEA (los servicios html2pdf/pades-signer no
 * existen en CI). Verifica que la ruta:
 *   - pasa un HTML y un fallback al adaptador;
 *   - cuando el adaptador devuelve mode='pades_local', envía el PDF firmado,
 *     marca X-Signature-Mode: pades_local y PERSISTE los metadatos NO-PII
 *     (signature_provider) con un UPDATE;
 *   - cuando el adaptador cae a 'simple' con nota (servicio caído), la ruta
 *     igual responde el PDF de fallback, marca X-Signature-Mode: simple + nota
 *     y NO persiste metadatos PAdES (fail-closed).
 */

jest.mock('../src/config/database', () => {
  const query = jest.fn();
  const transaction = jest.fn().mockResolvedValue({ commit: jest.fn(), rollback: jest.fn() });
  return { sequelize: { query, transaction } };
});

jest.mock('../src/middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next(),
}));

jest.mock('../src/services/scheduler', () => ({ minsToHM: (m) => String(m || 0) }));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Adaptador mockeado: control total sobre el modo devuelto.
jest.mock('../src/services/signing/padesSigner', () => ({
  SIGNING_MODES: { SIMPLE: 'simple', PADES_LOCAL: 'pades_local' },
  DEGRADE_REASONS: { SIGN_FAILED: 'PADES_SIGN_FAILED' },
  signReportDocument: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const pades = require('../src/services/signing/padesSigner');
const router = require('../src/routes/monthlyApprovals');

function handlerFor(method, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mkRes() {
  const res = { statusCode: 200 };
  res.status = jest.fn(function (c) { this.statusCode = c; return this; });
  res.json = jest.fn(function () { return this; });
  res.setHeader = jest.fn();
  res.send = jest.fn(function (b) { this.sent = b; return this; });
  return res;
}

const dailyRows = [
  { employee_code: 'E001', date: '2026-08-01', status: 'present', first_in: '08:00:00', last_out: '17:00:00', worked_minutes: 480, late_minutes: 0, overtime_minutes: 0 },
];
const summaryRows = [
  { code: 'E001', days_present: 20, days_late: 1, days_absent: 0, total_worked_minutes: 9600, total_late_minutes: 15, total_overtime_minutes: 120 },
];

function primeReadQueries(hash) {
  sequelize.query
    .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'approved', signed_by: 9, signed_at: '2026-09-01 10:00:00', integrity_hash: hash }]]) // SELECT approval
    .mockResolvedValueOnce([dailyRows]) // computeReportIntegrity
    .mockResolvedValueOnce([[          // events
      { actor_user_id: 9, actor_role: 'gth', action: 'sign', to_state: 'approved', at: '2026-09-01 10:00:00' },
    ]])
    .mockResolvedValueOnce([summaryRows]); // summary
}

beforeEach(() => { jest.clearAllMocks(); sequelize.query.mockReset(); });

test('pades_local: envía el PDF firmado, marca el modo y persiste metadatos', async () => {
  const svc = require('../src/services/monthlyReportApproval');
  sequelize.query.mockResolvedValueOnce([dailyRows]);
  const { hash } = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
  sequelize.query.mockReset();

  primeReadQueries(hash);
  sequelize.query.mockResolvedValueOnce([{}]); // persistPadesMeta UPDATE

  const signedBuf = Buffer.from('%PDF-1.4 signed');
  pades.signReportDocument.mockResolvedValueOnce({
    pdf: signedBuf, mode: 'pades_local', provider: 'pades-local', signatureInfo: { serial: 'z' }, note: null,
  });

  const res = mkRes();
  await handlerFor('get', '/:id/signed-pdf')({ params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn());

  // pasó html + fallback al adaptador
  const arg = pades.signReportDocument.mock.calls[0][0];
  expect(typeof arg.html).toBe('string');
  expect(arg.html).toContain('Reporte Mensual');
  expect(typeof arg.fallbackPdf).toBe('function');

  const modeHdr = res.setHeader.mock.calls.find(([k]) => k === 'X-Signature-Mode');
  expect(modeHdr[1]).toBe('pades_local');
  expect(res.sent).toBe(signedBuf);

  // persistió signature_provider (sin PII), best-effort UPDATE
  const upd = sequelize.query.mock.calls.find(([s]) => /UPDATE monthly_report_approvals[\s\S]*signature_provider/.test(s));
  expect(upd).toBeTruthy();
  expect(upd[1].replacements[0]).toBe('pades-local');
  expect(upd[1].replacements[1]).toBe(1);
});

test('servicio caído: adaptador devuelve simple+nota → responde fallback y NO persiste PAdES', async () => {
  const svc = require('../src/services/monthlyReportApproval');
  sequelize.query.mockResolvedValueOnce([dailyRows]);
  const { hash } = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
  sequelize.query.mockReset();

  primeReadQueries(hash);

  const fallbackBuf = Buffer.from('%PDF-1.4 fallback');
  pades.signReportDocument.mockResolvedValueOnce({
    pdf: fallbackBuf, mode: 'simple', provider: null, signatureInfo: null, note: 'PADES_SIGN_FAILED',
  });

  const res = mkRes();
  await handlerFor('get', '/:id/signed-pdf')({ params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn());

  const modeHdr = res.setHeader.mock.calls.find(([k]) => k === 'X-Signature-Mode');
  expect(modeHdr[1]).toBe('simple');
  const noteHdr = res.setHeader.mock.calls.find(([k]) => k === 'X-Signature-Note');
  expect(noteHdr[1]).toBe('PADES_SIGN_FAILED');
  expect(res.sent).toBe(fallbackBuf);

  // fail-closed: no se marcó "firmado PAdES" → sin UPDATE de metadatos.
  const upd = sequelize.query.mock.calls.find(([s]) => /UPDATE monthly_report_approvals[\s\S]*signature_provider/.test(s));
  expect(upd).toBeFalsy();
});
