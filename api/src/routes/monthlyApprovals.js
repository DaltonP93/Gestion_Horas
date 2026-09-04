/**
 * monthlyApprovals.js
 *
 * FASE 2 — Rutas del circuito de aprobación multinivel + firma electrónica
 * interna del REPORTE MENSUAL DE MARCADAS. Montado en:
 *     /api/reports/monthly/approvals
 *
 * Endpoints:
 *   POST   /                 submit  (year, month, department_id?)
 *   GET    /inbox            pendientes que le tocan al usuario
 *   GET    /status           estado actual de un período
 *   POST   /:id/approve      avanza un nivel (coord → gerente → RR.HH.)
 *   POST   /:id/reject       rechaza (corta el circuito)
 *   GET    /:id/signed-pdf   PDF firmado, SÓLO si el período está approved
 *
 * Reutiliza `canUserActOn` del workflow de permisos (vía el servicio) para la
 * validación de rol + coordinator_id/manager_id del departamento. La
 * transición es atómica (transacción + SELECT ... FOR UPDATE + chequeo de
 * estado) para que dos aprobaciones concurrentes no avancen dos veces: la
 * segunda encuentra el estado ya cambiado y responde 409.
 *
 * NO modifica reports.js (evita el solapamiento con el PR #196): arma su
 * propio documento con pdfkit.
 */

const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { sequelize } = require('../config/database');
const { minsToHM } = require('../services/scheduler');
const svc = require('../services/monthlyReportApproval');
const pades = require('../services/signing/padesSigner');
const logger = require('../config/logger');

router.use(authenticate);

// Roles que pueden operar el circuito (writers → RBAC estricto).
const ACTOR_ROLES = ['coordinator', 'manager', 'gth', 'admin', 'super_admin'];

function parsePeriod(v) {
  const year = Number(v.year);
  const month = Number(v.month);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  let department_id = null;
  if (v.department_id !== undefined && v.department_id !== null && v.department_id !== '') {
    department_id = Number(v.department_id);
    if (!Number.isInteger(department_id) || department_id <= 0) return null;
  }
  return { year, month, department_id };
}

// ─── POST / ── submit: crea el pedido de aprobación de un período ───────
router.post('/', authorize(...ACTOR_ROLES), asyncHandler(async (req, res) => {
  const period = parsePeriod(req.body || {});
  if (!period) return res.status(400).json({ error: 'Período inválido (year, month, department_id)' });

  // Departamento debe existir si se especifica.
  const dept = await svc.resolveDepartment(period.department_id);
  if (period.department_id != null && !dept) {
    return res.status(404).json({ error: 'Departamento inexistente' });
  }

  const needs = svc.computeNeeds(dept);
  const status = svc.initialStatus(needs);

  const t = await sequelize.transaction();
  try {
    const [result] = await sequelize.query(
      `INSERT INTO monthly_report_approvals
         (year, month, department_id, status, submitted_by, submitted_at)
       VALUES (?,?,?,?,?,NOW())`,
      { replacements: [period.year, period.month, period.department_id, status, req.user.id], transaction: t }
    );
    const insertId = result?.insertId ?? result;
    await svc.logEvent({
      approval_id: insertId,
      actor_user_id: req.user.id,
      actor_role: req.user.role,
      action: 'submit',
      to_state: status,
    }, t);
    await t.commit();
    return res.status(201).json({
      id: insertId,
      year: period.year,
      month: period.month,
      department_id: period.department_id,
      status,
    });
  } catch (err) {
    await t.rollback();
    if (err?.original?.code === 'ER_DUP_ENTRY' || err?.parent?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe un pedido para ese período' });
    }
    throw err;
  }
}));

// ─── GET /inbox ── pendientes por rol/depto del usuario ─────────────────
router.get('/inbox', asyncHandler(async (req, res) => {
  const rows = await svc.getInboxFor(req.user);
  res.json({ data: rows });
}));

// ─── GET /status ── estado actual de un período ─────────────────────────
router.get('/status', asyncHandler(async (req, res) => {
  const period = parsePeriod(req.query || {});
  if (!period) return res.status(400).json({ error: 'Período inválido (year, month, department_id)' });

  const [[row]] = await sequelize.query(
    `SELECT id, year, month, department_id, status, submitted_by, submitted_at,
            signed_by, signed_at, integrity_hash
       FROM monthly_report_approvals
      WHERE year = ? AND month = ? AND COALESCE(department_id,0) = COALESCE(?,0)
      LIMIT 1`,
    { replacements: [period.year, period.month, period.department_id] }
  );
  if (!row) return res.json({ data: null });
  res.json({ data: row });
}));

// Helper: transición de aprobación/rechazo, atómica.
async function transition(req, res, kind) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

  const t = await sequelize.transaction();
  try {
    const [[row]] = await sequelize.query(
      `SELECT id, year, month, department_id, status, submitted_by
         FROM monthly_report_approvals WHERE id = ? FOR UPDATE`,
      { replacements: [id], transaction: t }
    );
    if (!row) { await t.rollback(); return res.status(404).json({ error: 'Pedido inexistente' }); }

    // Sólo estados abiertos son accionables. Si otro aprobador ya avanzó o
    // cerró el pedido, este llega tarde → 409 (evita doble aprobación).
    if (!svc.OPEN_STATES.includes(row.status)) {
      await t.rollback();
      return res.status(409).json({ error: 'El pedido ya no está en un estado accionable', status: row.status });
    }

    // Autorización REUSADA del workflow de permisos: rol + coordinator_id /
    // manager_id del departamento.
    const allowed = await svc.canUserActOn(req.user, row);
    if (!allowed) { await t.rollback(); return res.status(403).json({ error: 'Sin permisos para actuar en este nivel' }); }

    if (kind === 'reject') {
      await sequelize.query(
        `UPDATE monthly_report_approvals SET status = 'rejected' WHERE id = ?`,
        { replacements: [id], transaction: t }
      );
      await svc.logEvent({
        approval_id: id, actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'reject', to_state: 'rejected',
      }, t);
      await t.commit();
      return res.json({ id, status: 'rejected' });
    }

    // approve: calcular el próximo estado salteando niveles sin actor.
    const dept = await svc.resolveDepartment(row.department_id);
    const needs = svc.computeNeeds(dept);
    const next = svc.nextApprovedState(row.status, needs);
    if (!next) { await t.rollback(); return res.status(409).json({ error: 'No hay transición válida desde el estado actual' }); }

    if (next === 'approved') {
      // Firma final de RR.HH.: identidad + timestamp + hash de integridad.
      const { hash } = await svc.computeReportIntegrity({
        year: row.year, month: row.month, department_id: row.department_id,
      });
      await sequelize.query(
        `UPDATE monthly_report_approvals
            SET status = 'approved', signed_by = ?, signed_at = NOW(), integrity_hash = ?
          WHERE id = ?`,
        { replacements: [req.user.id, hash, id], transaction: t }
      );
      await svc.logEvent({
        approval_id: id, actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'approve', to_state: 'approved',
      }, t);
      await svc.logEvent({
        approval_id: id, actor_user_id: req.user.id, actor_role: req.user.role,
        action: 'sign', to_state: 'approved',
      }, t);
      await t.commit();
      return res.json({ id, status: 'approved', signed_by: req.user.id, integrity_hash: hash });
    }

    await sequelize.query(
      `UPDATE monthly_report_approvals SET status = ? WHERE id = ?`,
      { replacements: [next, id], transaction: t }
    );
    await svc.logEvent({
      approval_id: id, actor_user_id: req.user.id, actor_role: req.user.role,
      action: 'approve', to_state: next,
    }, t);
    await t.commit();
    return res.json({ id, status: next });
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// ─── POST /:id/approve ──────────────────────────────────────────────────
router.post('/:id/approve', authorize(...ACTOR_ROLES), asyncHandler((req, res) => transition(req, res, 'approve')));

// ─── POST /:id/reject ───────────────────────────────────────────────────
router.post('/:id/reject', authorize(...ACTOR_ROLES), asyncHandler((req, res) => transition(req, res, 'reject')));

// Etiquetas de rol para el bloque de firma (compartidas pdfkit/HTML).
const ROL = { coordinator: 'Coordinador', manager: 'Gerente de área', gth: 'RR.HH.', admin: 'RR.HH. (admin)', super_admin: 'RR.HH. (super_admin)' };
const fmtTs = (d) => (d == null ? '—' : (d instanceof Date ? d.toISOString().replace('T', ' ').slice(0, 19) : String(d)));

// Escape mínimo para inyectar texto en el HTML del reporte (html2pdf).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Corre un builder pdfkit y devuelve el PDF como Buffer (no pipea a res).
// Permite reusar EXACTAMENTE el mismo generador para el modo simple y como
// fallback fail-closed del modo pades_local.
function pdfkitToBuffer(build) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      build(doc);
      doc.end();
    } catch (err) { reject(err); }
  });
}

// Dibuja el reporte firmado (firma simple interna + hash) con pdfkit.
// Es el generador EXISTENTE, extraído para poder devolver un Buffer.
function drawSimpleReport(doc, { row, events, summary, verified }) {
  const MARGIN = doc.page.margins.left;
  const CONTENT_W = doc.page.width - MARGIN * 2;

  doc.fontSize(16).fillColor('#1e40af').font('Helvetica-Bold')
    .text('Reporte Mensual de Asistencia — Documento Firmado', MARGIN, MARGIN, { width: CONTENT_W, align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor('#475569').font('Helvetica')
    .text(`Período ${String(row.month).padStart(2, '0')}/${row.year}   ·   Alcance: ${row.department_id ? 'Departamento #' + row.department_id : 'Organización'}`,
      { width: CONTENT_W, align: 'center' });
  doc.moveDown(1);

  const cols = [
    { label: 'Código', w: 70, align: 'left' },
    { label: 'Pres.', w: 55, align: 'right' },
    { label: 'Tarde', w: 55, align: 'right' },
    { label: 'Aus.', w: 55, align: 'right' },
    { label: 'Trab.', w: 75, align: 'right' },
    { label: 'Atraso', w: 70, align: 'right' },
    { label: 'Extra', w: 75, align: 'right' },
  ];
  const tableW = cols.reduce((a, c) => a + c.w, 0);
  const tx = MARGIN;
  let y = doc.y;
  doc.rect(tx, y, tableW, 16).fill('#1e40af');
  doc.fontSize(8).fillColor('#fff').font('Helvetica-Bold');
  let cx = tx;
  for (const c of cols) { doc.text(c.label, cx + 3, y + 4.5, { width: c.w - 6, align: c.align }); cx += c.w; }
  y += 16;
  doc.font('Helvetica').fontSize(8).fillColor('#0f172a');
  for (let i = 0; i < summary.length; i++) {
    const r = summary[i];
    if (y > doc.page.height - 220) { doc.addPage(); y = MARGIN; }
    if (i % 2 === 0) doc.rect(tx, y, tableW, 14).fill('#f8fafc');
    const vals = [
      String(r.code ?? ''),
      String(r.days_present ?? 0),
      String(r.days_late ?? 0),
      String(r.days_absent ?? 0),
      minsToHM(r.total_worked_minutes || 0),
      String(r.total_late_minutes || 0),
      minsToHM(r.total_overtime_minutes || 0),
    ];
    cx = tx;
    doc.fillColor('#0f172a');
    vals.forEach((v, ci) => { doc.text(v, cx + 3, y + 3.5, { width: cols[ci].w - 6, align: cols[ci].align, lineBreak: false }); cx += cols[ci].w; });
    y += 14;
  }

  let sy = Math.min(y + 24, doc.page.height - 200);
  if (sy < y + 10) { doc.addPage(); sy = MARGIN; }
  doc.rect(MARGIN, sy, CONTENT_W, 2).fill('#1e40af');
  sy += 12;
  doc.fontSize(12).fillColor('#1e40af').font('Helvetica-Bold')
    .text('Firma electrónica interna', MARGIN, sy, { width: CONTENT_W });
  sy += 20;

  doc.fontSize(9).font('Helvetica').fillColor('#334155');
  for (const ev of events) {
    const etiqueta = ev.action === 'sign' ? 'Firmado por' : 'Aprobado por';
    doc.text(`${etiqueta}: usuario #${ev.actor_user_id}  ·  ${ROL[ev.actor_role] || ev.actor_role}  ·  ${fmtTs(ev.at)}`, MARGIN, sy, { width: CONTENT_W });
    sy += 15;
  }
  sy += 6;
  doc.font('Helvetica-Bold').text('Firmante final (RR.HH.):', MARGIN, sy, { continued: true })
    .font('Helvetica').text(`  usuario #${row.signed_by ?? '—'}   ·   ${fmtTs(row.signed_at)}`);
  sy += 18;

  doc.font('Helvetica-Bold').fillColor('#334155').text('Hash de integridad (SHA-256):', MARGIN, sy);
  sy += 13;
  doc.font('Courier').fontSize(8).fillColor('#0f172a').text(row.integrity_hash || '—', MARGIN, sy, { width: CONTENT_W });
  sy += 18;

  doc.font('Helvetica').fontSize(9).fillColor(verified ? '#15803d' : '#b91c1c')
    .text(verified
      ? 'Verificación: los datos del período coinciden con el hash firmado.'
      : 'ADVERTENCIA: los datos del período NO coinciden con el hash firmado (posible modificación posterior a la firma).',
      MARGIN, sy, { width: CONTENT_W });
  sy += 20;
  doc.fontSize(7.5).fillColor('#94a3b8').font('Helvetica')
    .text('Firma electrónica simple interna, no certificada. Documento generado automáticamente por SisHoras.', MARGIN, sy, { width: CONTENT_W });
}

// HTML del reporte para html2pdf (modo pades_local). Mismo contenido NO-PII
// que el pdfkit: totales por código de empleado + bloque de aprobación/firma
// + hash. El certificado/firma PAdES lo aplica el servicio pades-signer.
function buildReportHtml({ row, events, summary, verified }) {
  const scope = row.department_id ? `Departamento #${row.department_id}` : 'Organización';
  const filas = summary.map((r) => `
      <tr>
        <td>${escapeHtml(r.code ?? '')}</td>
        <td class="n">${escapeHtml(r.days_present ?? 0)}</td>
        <td class="n">${escapeHtml(r.days_late ?? 0)}</td>
        <td class="n">${escapeHtml(r.days_absent ?? 0)}</td>
        <td class="n">${escapeHtml(minsToHM(r.total_worked_minutes || 0))}</td>
        <td class="n">${escapeHtml(r.total_late_minutes || 0)}</td>
        <td class="n">${escapeHtml(minsToHM(r.total_overtime_minutes || 0))}</td>
      </tr>`).join('');
  const firmantes = events.map((ev) => {
    const etiqueta = ev.action === 'sign' ? 'Firmado por' : 'Aprobado por';
    return `<p class="firm">${escapeHtml(etiqueta)}: usuario #${escapeHtml(ev.actor_user_id)} · ${escapeHtml(ROL[ev.actor_role] || ev.actor_role)} · ${escapeHtml(fmtTs(ev.at))}</p>`;
  }).join('');
  const verifTxt = verified
    ? 'Verificación: los datos del período coinciden con el hash firmado.'
    : 'ADVERTENCIA: los datos del período NO coinciden con el hash firmado (posible modificación posterior a la firma).';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>
  body{font-family:Helvetica,Arial,sans-serif;color:#0f172a;margin:32px;font-size:11px;}
  h1{color:#1e40af;font-size:17px;text-align:center;margin:0 0 4px;}
  .sub{color:#475569;text-align:center;margin:0 0 18px;font-size:11px;}
  table{border-collapse:collapse;width:100%;margin-bottom:18px;}
  th{background:#1e40af;color:#fff;font-size:9px;padding:4px 6px;text-align:left;}
  td{font-size:9px;padding:3px 6px;border-bottom:1px solid #eef2f7;}
  td.n,th.n{text-align:right;}
  tr:nth-child(even) td{background:#f8fafc;}
  .sig{border-top:2px solid #1e40af;padding-top:10px;}
  .sig h2{color:#1e40af;font-size:13px;margin:0 0 8px;}
  .firm{margin:2px 0;color:#334155;font-size:10px;}
  .hash{font-family:'Courier New',monospace;font-size:8px;word-break:break-all;color:#0f172a;}
  .verif{color:${verified ? '#15803d' : '#b91c1c'};font-size:10px;margin-top:8px;}
  .foot{color:#94a3b8;font-size:8px;margin-top:10px;}
</style></head><body>
  <h1>Reporte Mensual de Asistencia — Documento Firmado</h1>
  <p class="sub">Período ${escapeHtml(String(row.month).padStart(2, '0'))}/${escapeHtml(row.year)} · Alcance: ${escapeHtml(scope)}</p>
  <table>
    <thead><tr>
      <th>Código</th><th class="n">Pres.</th><th class="n">Tarde</th><th class="n">Aus.</th>
      <th class="n">Trab.</th><th class="n">Atraso</th><th class="n">Extra</th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table>
  <div class="sig">
    <h2>Firma electrónica interna</h2>
    ${firmantes}
    <p class="firm"><strong>Firmante final (RR.HH.):</strong> usuario #${escapeHtml(row.signed_by ?? '—')} · ${escapeHtml(fmtTs(row.signed_at))}</p>
    <p class="firm"><strong>Hash de integridad (SHA-256):</strong></p>
    <p class="hash">${escapeHtml(row.integrity_hash || '—')}</p>
    <p class="verif">${escapeHtml(verifTxt)}</p>
    <p class="foot">Documento generado automáticamente por SisHoras. La firma PAdES la aplica el servicio de firma configurado.</p>
  </div>
</body></html>`;
}

// Persistencia best-effort de metadatos de la firma PAdES. NO bloquea ni
// rompe la descarga: si la migración 082 no está aplicada (columnas
// inexistentes) o el UPDATE falla, se ignora en silencio. Sin PII: sólo una
// etiqueta de proveedor y un timestamp.
async function persistPadesMeta(id, provider) {
  try {
    await sequelize.query(
      `UPDATE monthly_report_approvals
          SET signature_provider = ?, signed_pades_at = NOW()
        WHERE id = ?`,
      { replacements: [String(provider || 'pades-local').slice(0, 64), id] }
    );
  } catch (err) {
    logger.warn('No se pudieron persistir metadatos PAdES (best-effort)', {
      error_code: err?.original?.code || err?.parent?.code || 'UNKNOWN',
    });
  }
}

// ─── GET /:id/signed-pdf ── documento firmado, SÓLO si approved ─────────
router.get('/:id/signed-pdf', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

  const [[row]] = await sequelize.query(
    `SELECT id, year, month, department_id, status, signed_by, signed_at, integrity_hash
       FROM monthly_report_approvals WHERE id = ? LIMIT 1`,
    { replacements: [id] }
  );
  if (!row) return res.status(404).json({ error: 'Pedido inexistente' });
  if (row.status !== 'approved') {
    return res.status(409).json({ error: 'El documento firmado sólo está disponible cuando el período está aprobado', status: row.status });
  }

  // Recalcular el hash actual y compararlo con el firmado: si los datos
  // subyacentes cambiaron desde la firma, el documento lo advierte.
  const { hash: currentHash } = await svc.computeReportIntegrity({
    year: row.year, month: row.month, department_id: row.department_id,
  });
  const verified = currentHash === row.integrity_hash;

  // Aprobadores/firmantes: ids + roles + timestamps (sin PII).
  const [events] = await sequelize.query(
    `SELECT actor_user_id, actor_role, action, to_state, at
       FROM monthly_report_approval_events
      WHERE approval_id = ? AND action IN ('approve','sign')
      ORDER BY at ASC, id ASC`,
    { replacements: [id] }
  );

  // Totales por empleado para la tabla resumen del documento.
  const dateFrom = `${row.year}-${String(row.month).padStart(2, '0')}-01`;
  const dateTo = new Date(row.year, row.month, 0).toISOString().split('T')[0];
  const params = [dateFrom, dateTo];
  let deptFilter = '';
  if (row.department_id != null) { deptFilter = 'AND e.department_id = ?'; params.push(row.department_id); }
  const [summary] = await sequelize.query(`
    SELECT
      e.code,
      COUNT(CASE WHEN ds.status IN ('present','late') THEN 1 END) AS days_present,
      COUNT(CASE WHEN ds.status = 'late'   THEN 1 END)            AS days_late,
      COUNT(CASE WHEN ds.status = 'absent' THEN 1 END)            AS days_absent,
      SUM(ds.worked_minutes)   AS total_worked_minutes,
      SUM(ds.late_minutes)     AS total_late_minutes,
      SUM(ds.overtime_minutes) AS total_overtime_minutes
    FROM employees e
    LEFT JOIN daily_summary ds ON e.id = ds.employee_id AND ds.date BETWEEN ? AND ?
    WHERE e.status = 'active' ${deptFilter}
    GROUP BY e.id
    ORDER BY e.code
  `, { replacements: params });

  const ctx = { row, events, summary, verified };

  // El generador pdfkit EXISTENTE, ahora reutilizable como Buffer. Es el
  // documento del modo 'simple' y el fallback fail-closed de 'pades_local'.
  const fallbackPdf = () => pdfkitToBuffer((doc) => drawSimpleReport(doc, ctx));

  // Metadatos NO-PII para el servicio de firma.
  const meta = {
    reason: `Reporte mensual de asistencia ${String(row.month).padStart(2, '0')}/${row.year} aprobado`,
    period: `${row.year}-${String(row.month).padStart(2, '0')}`,
    scope: row.department_id ? `DEPT:${row.department_id}` : 'ORG',
  };

  // El adaptador decide el modo efectivo (fail-closed). En pades_local:
  // html2pdf(html) → pades-signer. Ante cualquier fallo, cae al fallback.
  const result = await pades.signReportDocument({
    html: buildReportHtml(ctx),
    fallbackPdf,
    meta,
  });

  const suffix = row.department_id ? `_dept${row.department_id}` : '_org';
  const tag = result.mode === pades.SIGNING_MODES.PADES_LOCAL ? 'pades' : 'firmado';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="reporte_mensual_${tag}_${row.year}_${String(row.month).padStart(2, '0')}${suffix}.pdf"`);
  // Traza NO-PII del modo de firma efectivamente usado.
  res.setHeader('X-Signature-Mode', result.mode);
  if (result.note) res.setHeader('X-Signature-Note', result.note);

  // Guardar metadatos SÓLO si de verdad se firmó PAdES (fail-closed: nunca
  // afirmar "firmado PAdES" si no se pudo).
  if (result.mode === pades.SIGNING_MODES.PADES_LOCAL) {
    await persistPadesMeta(id, result.provider);
  }

  return res.send(result.pdf);
}));

module.exports = router;
