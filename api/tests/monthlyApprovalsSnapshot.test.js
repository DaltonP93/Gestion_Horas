/**
 * monthlyApprovalsSnapshot.test.js — [P1-A] Snapshot firmado + anti-TOCTOU.
 *
 * Prueba, con una BARRERA determinista, que el contenido renderizado y firmado
 * proviene EXACTAMENTE del mismo snapshot que produjo el hash validado:
 *
 *   1) Se muta `daily_summary` DESPUÉS del cálculo del hash y ANTES del render
 *      (se arma una respuesta distinta para cualquier segunda lectura). Como el
 *      resumen del PDF se DERIVA de las filas canónicas de computeReportIntegrity
 *      (sin una segunda lectura independiente), el documento firmado sigue siendo
 *      el snapshot aprobado: nunca se firma contenido diferente.
 *      → se verifica además que `daily_summary` se leyó EXACTAMENTE una vez.
 *
 *   2) Si el cambio ocurre ANTES de la descarga (el hash actual ya no coincide
 *      con el firmado), se corta fail-closed con 409 REPORT_INTEGRITY_MISMATCH y
 *      NO se llama a html2pdf/pades-signer.
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

// Adaptador mockeado: captura el html/fallback y controla el modo devuelto.
jest.mock('../src/services/signing/padesSigner', () => ({
  SIGNING_MODES: { SIMPLE: 'simple', PADES_LOCAL: 'pades_local' },
  DEGRADE_REASONS: { SIGN_FAILED: 'PADES_SIGN_FAILED' },
  signReportDocument: jest.fn(),
}));

const { sequelize } = require('../src/config/database');
const pades = require('../src/services/signing/padesSigner');
const svc = require('../src/services/monthlyReportApproval');
const router = require('../src/routes/monthlyApprovals');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mkRes() {
  const res = { statusCode: 200 };
  res.status = jest.fn(function (c) { this.statusCode = c; return this; });
  res.json = jest.fn(function () { return this; });
  res.setHeader = jest.fn();
  res.send = jest.fn(function (b) { this.sent = b; return this; });
  return res;
}

// SNAPSHOT aprobado: empleado E001. MUTACIÓN posterior: empleado E999 (marcador
// que SÓLO aparecería si hubiera una segunda lectura independiente de daily_summary).
const SNAPSHOT = [
  { employee_code: 'E001', date: '2026-08-01', status: 'present', first_in: '08:00:00', last_out: '17:00:00', worked_minutes: 480, late_minutes: 0, overtime_minutes: 0 },
];
const MUTATED = [
  { employee_code: 'E999', date: '2026-08-02', status: 'absent', first_in: null, last_out: null, worked_minutes: null, late_minutes: null, overtime_minutes: null },
];

beforeEach(() => { jest.clearAllMocks(); sequelize.query.mockReset(); });

async function hashOf(rows) {
  sequelize.query.mockResolvedValueOnce([rows]);
  const { hash } = await svc.computeReportIntegrity({ year: 2026, month: 8, department_id: 7 });
  sequelize.query.mockReset();
  return hash;
}

test('[P1-A] mutación de daily_summary tras el hash y antes del render → se firma el SNAPSHOT, no lo mutado', async () => {
  const hash = await hashOf(SNAPSHOT);

  // Barrera: 1) approval(hash) 2) computeReportIntegrity→SNAPSHOT 3) events []
  // 4) CUALQUIER segunda lectura de daily_summary devolvería lo MUTADO. Con el
  // diseño de snapshot único, esa 4ª lectura NO ocurre.
  sequelize.query
    .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'approved', signed_by: 9, signed_at: '2026-09-01 10:00:00', integrity_hash: hash }]])
    .mockResolvedValueOnce([SNAPSHOT])
    .mockResolvedValueOnce([[]])
    .mockResolvedValue([MUTATED]); // red de seguridad: si hubiera otra lectura, sería lo mutado

  pades.signReportDocument.mockResolvedValueOnce({
    pdf: Buffer.from('%PDF-1.4 signed'), mode: 'pades_local', provider: 'pades-local', signatureInfo: { verified: true, pinned: true }, note: null,
  });

  const res = mkRes();
  await handlerFor('get', '/:id/signed-pdf')({ params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn());

  // El html firmado refleja el SNAPSHOT (E001) y NUNCA el dato mutado (E999).
  const arg = pades.signReportDocument.mock.calls[0][0];
  expect(arg.html).toContain('E001');
  expect(arg.html).not.toContain('E999');

  // Snapshot único: daily_summary se leyó EXACTAMENTE una vez (no hubo re-lectura).
  const dsReads = sequelize.query.mock.calls.filter(([s]) => /daily_summary/i.test(s));
  expect(dsReads).toHaveLength(1);
});

test('[P1-A] cambio ANTES de la descarga (hash ya no coincide) → 409 sin firmar', async () => {
  // approval trae un hash "viejo"; computeReportIntegrity ve datos ya cambiados
  // (produce OTRO hash) → mismatch → 409 y NO se llama al firmador.
  sequelize.query
    .mockResolvedValueOnce([[{ id: 1, year: 2026, month: 8, department_id: 7, status: 'approved', signed_by: 9, signed_at: null, integrity_hash: 'HASH_VIEJO_QUE_YA_NO_COINCIDE' }]])
    .mockResolvedValueOnce([MUTATED]); // computeReportIntegrity ve datos distintos

  const res = mkRes();
  await handlerFor('get', '/:id/signed-pdf')({ params: { id: '1' }, user: { id: 9, role: 'gth' } }, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REPORT_INTEGRITY_MISMATCH' }));
  expect(pades.signReportDocument).not.toHaveBeenCalled(); // html2pdf/pades-signer NO corren
  expect(res.send).not.toHaveBeenCalled();
});
