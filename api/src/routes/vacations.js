/**
 * vacations.js — Plan visual de vacaciones y permisos.
 *
 * GET /api/vacations/plan?year=&month=&deptId=
 *   Devuelve para un mes (o un año entero si month=0):
 *     - days[] con feriados
 *     - employees[] con franjas { date_from, date_to, type, status, days } por empleado
 *
 * GET /api/vacations/conflicts?date_from=&date_to=&deptId=
 *   Detecta empleados solapados en un rango (útil al planificar).
 */
const router = require('express').Router();
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);
router.use(authorize('admin', 'gth', 'hr', 'manager', 'coordinator', 'gestor', 'supervisor'));

function monthBounds(year, month) {
  if (month === 0) {
    return {
      from: `${year}-01-01`,
      to:   `${year}-12-31`,
    };
  }
  const m = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${m}-01`,
    to:   `${year}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

router.get('/plan', requirePermission('reportes', 'view'), async (req, res) => {
  try {
    const year   = parseInt(req.query.year  || new Date().getFullYear(), 10);
    const month  = parseInt(req.query.month || (new Date().getMonth() + 1), 10);
    const deptId = req.query.deptId ? parseInt(req.query.deptId, 10) : null;
    const { from, to } = monthBounds(year, month);

    const empParams = [from, to];
    let deptFilter = '';
    if (deptId) { deptFilter = ' AND e.department_id = ?'; empParams.push(deptId); }

    // Permisos que tocan el período (incluye solapamiento)
    const [rows] = await sequelize.query(`
      SELECT
        p.id, p.type, p.date_from, p.date_to, p.status, p.reason,
        p.employee_id,
        CONCAT(e.first_name,' ',e.last_name) AS employee_name,
        e.code, e.position,
        d.name AS department, d.id AS department_id,
        DATEDIFF(p.date_to, p.date_from) + 1 AS days
      FROM permissions p
      JOIN employees e ON e.id = p.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE p.status IN ('pending','approved')
        AND p.date_from <= ? AND p.date_to >= ?
        ${deptFilter}
      ORDER BY e.last_name, p.date_from
    `, { replacements: [to, from, ...(deptId ? [deptId] : [])] });

    // Feriados del período
    const [holidays] = await sequelize.query(
      'SELECT date, name FROM holidays WHERE date BETWEEN ? AND ? ORDER BY date',
      { replacements: [from, to] }
    );

    // Agrupar por empleado para vista
    const byEmp = {};
    for (const r of rows) {
      if (!byEmp[r.employee_id]) {
        byEmp[r.employee_id] = {
          id: r.employee_id, employee_name: r.employee_name, code: r.code,
          position: r.position, department: r.department,
          ranges: [],
        };
      }
      byEmp[r.employee_id].ranges.push({
        id: r.id, type: r.type, status: r.status, reason: r.reason,
        date_from: r.date_from, date_to: r.date_to, days: r.days,
      });
    }

    res.json({
      ok: true,
      period: { year, month, from, to },
      employees: Object.values(byEmp),
      holidays,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detecta conflictos: empleados con vacaciones solapadas en un rango específico
router.get('/conflicts', async (req, res) => {
  try {
    const { date_from, date_to, deptId } = req.query;
    if (!date_from || !date_to) {
      return res.status(400).json({ error: 'date_from y date_to son requeridos' });
    }
    const params = [date_to, date_from];
    let deptFilter = '';
    if (deptId) { deptFilter = ' AND e.department_id = ?'; params.push(parseInt(deptId, 10)); }

    const [rows] = await sequelize.query(`
      SELECT
        p.id, p.type, p.date_from, p.date_to, p.status,
        CONCAT(e.first_name,' ',e.last_name) AS employee_name,
        e.code, d.name AS department,
        d.id AS department_id
      FROM permissions p
      JOIN employees e ON e.id = p.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE p.status IN ('pending','approved')
        AND p.date_from <= ? AND p.date_to >= ?
        ${deptFilter}
      ORDER BY d.name, p.date_from
    `, { replacements: params });

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  VACACIONES PARAMETRIZABLES (política, saldos, rechazo alternativo)
// ═══════════════════════════════════════════════════════════════

const canManage = authorize('admin', 'gth', 'hr');

// Tipo de conteo de días de vacaciones (setting parametrizable).
async function getDayType() {
  const [rows] = await sequelize.query(
    "SELECT setting_value FROM notification_settings WHERE setting_key = 'vacation_day_type' LIMIT 1"
  );
  return String(rows[0]?.setting_value || 'habiles') === 'corridos' ? 'corridos' : 'habiles';
}

// Derecho a días según antigüedad y los tramos configurados.
function entitlementFor(brackets, years) {
  for (const b of brackets) {
    const okMin = years >= b.min_years;
    const okMax = b.max_years == null || years < b.max_years;
    if (okMin && okMax) return b.days;
  }
  return 0;
}

// Años completos de antigüedad a una fecha de corte.
function yearsBetween(hireDate, cutoff) {
  if (!hireDate) return 0;
  const h = new Date(hireDate), c = new Date(cutoff);
  let y = c.getFullYear() - h.getFullYear();
  const anniv = new Date(c.getFullYear(), h.getMonth(), h.getDate());
  if (c < anniv) y -= 1;
  return Math.max(0, y);
}

// ── Política: tramos de antigüedad → días ──────────────────────
router.get('/policy', async (req, res) => {
  try {
    const [brackets] = await sequelize.query(
      'SELECT id, min_years, max_years, days, active FROM vacation_brackets ORDER BY min_years'
    );
    res.json({ ok: true, day_type: await getDayType(), brackets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reemplaza el set completo de tramos + el tipo de día. Sólo RRHH/admin.
router.put('/policy', canManage, requirePermission('configuracion', 'update'), async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { brackets, day_type } = req.body || {};
    if (!Array.isArray(brackets)) { await t.rollback(); return res.status(400).json({ error: 'brackets[] requerido' }); }
    // Validar tramos
    for (const b of brackets) {
      const min = parseInt(b.min_years, 10), days = parseInt(b.days, 10);
      if (!Number.isFinite(min) || min < 0 || !Number.isFinite(days) || days < 0) {
        await t.rollback(); return res.status(400).json({ error: 'Tramo inválido (min_years/days)' });
      }
      if (b.max_years != null && b.max_years !== '' && parseInt(b.max_years, 10) <= min) {
        await t.rollback(); return res.status(400).json({ error: 'max_years debe ser mayor que min_years' });
      }
    }
    await sequelize.query('DELETE FROM vacation_brackets', { transaction: t });
    for (const b of brackets) {
      await sequelize.query(
        'INSERT INTO vacation_brackets (min_years, max_years, days, active) VALUES (?,?,?,?)',
        { replacements: [
          parseInt(b.min_years, 10),
          b.max_years == null || b.max_years === '' ? null : parseInt(b.max_years, 10),
          parseInt(b.days, 10),
          b.active === false ? 0 : 1,
        ], transaction: t }
      );
    }
    if (day_type === 'habiles' || day_type === 'corridos') {
      await sequelize.query(
        `INSERT INTO notification_settings (setting_key, setting_value) VALUES ('vacation_day_type', ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        { replacements: [day_type], transaction: t }
      );
    }
    await t.commit();
    res.json({ ok: true });
  } catch (err) { await t.rollback(); res.status(500).json({ error: err.message }); }
});

// ── Saldos por empleado y año ──────────────────────────────────
router.get('/balances', async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    const deptId = req.query.deptId ? parseInt(req.query.deptId, 10) : null;
    const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`;
    const cutoff = year >= new Date().getFullYear() ? new Date() : new Date(year, 11, 31);
    const dayType = await getDayType();

    const [brackets] = await sequelize.query(
      'SELECT min_years, max_years, days FROM vacation_brackets WHERE active = 1 ORDER BY min_years'
    );

    const empParams = [];
    let deptFilter = '';
    if (deptId) { deptFilter = 'AND e.department_id = ?'; empParams.push(deptId); }
    const [emps] = await sequelize.query(`
      SELECT e.id, e.code, CONCAT(e.first_name,' ',e.last_name) AS name,
             e.hire_date, d.name AS department
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.status = 'active' ${deptFilter}
      ORDER BY e.last_name, e.first_name
    `, { replacements: empParams });

    const [balRows] = await sequelize.query(
      'SELECT employee_id, assigned, adjustment, note FROM vacation_balances WHERE year = ?',
      { replacements: [year] }
    );
    const balByEmp = Object.fromEntries(balRows.map(b => [b.employee_id, b]));

    // Permisos de vacaciones aprobados que tocan el año.
    const [vacs] = await sequelize.query(`
      SELECT employee_id, date_from, date_to
      FROM permissions
      WHERE type = 'vacation' AND status = 'approved'
        AND date_from <= ? AND date_to >= ?
    `, { replacements: [yearEnd, yearStart] });

    // Feriados del año (para contar días hábiles).
    const [hol] = await sequelize.query(
      'SELECT DATE_FORMAT(date, "%Y-%m-%d") AS d FROM holidays WHERE active = 1 AND date BETWEEN ? AND ?',
      { replacements: [yearStart, yearEnd] }
    );
    const holidays = new Set(hol.map(h => h.d));

    // Contar días tomados por empleado dentro del año.
    const takenByEmp = {};
    const ys = new Date(yearStart), ye = new Date(yearEnd);
    for (const v of vacs) {
      let from = new Date(v.date_from), to = new Date(v.date_to);
      if (from < ys) from = new Date(ys);
      if (to > ye) to = new Date(ye);
      let count = 0;
      for (let dt = new Date(from); dt <= to; dt.setDate(dt.getDate() + 1)) {
        if (dayType === 'corridos') { count++; continue; }
        const dow = dt.getDay(); // 0=Dom … 6=Sáb
        const ds = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        if (dow !== 0 && dow !== 6 && !holidays.has(ds)) count++;
      }
      takenByEmp[v.employee_id] = (takenByEmp[v.employee_id] || 0) + count;
    }

    const data = emps.map(e => {
      const years = yearsBetween(e.hire_date, cutoff);
      const entitlement = entitlementFor(brackets, years);
      const bal = balByEmp[e.id] || {};
      const assigned = bal.assigned != null ? bal.assigned : entitlement;
      const adjustment = bal.adjustment || 0;
      const taken = takenByEmp[e.id] || 0;
      return {
        employee_id: e.id, code: e.code, name: e.name, department: e.department,
        hire_date: e.hire_date, antiguedad_years: years,
        entitlement, assigned, adjustment, taken,
        available: assigned + adjustment - taken,
        note: bal.note || null, overridden: bal.assigned != null,
      };
    });

    res.json({ ok: true, year, day_type: dayType, total: data.length, data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Asignación/ajuste de saldo por RRHH. assigned=null → volver al derecho.
router.put('/balances', canManage, requirePermission('configuracion', 'update'), async (req, res) => {
  try {
    const { employee_id, year, assigned, adjustment, note } = req.body || {};
    if (!employee_id || !year) return res.status(400).json({ error: 'employee_id y year requeridos' });
    const asg = assigned === null || assigned === '' || assigned === undefined ? null : parseInt(assigned, 10);
    const adj = Number.isFinite(parseInt(adjustment, 10)) ? parseInt(adjustment, 10) : 0;
    await sequelize.query(
      `INSERT INTO vacation_balances (employee_id, year, assigned, adjustment, note, updated_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE assigned=VALUES(assigned), adjustment=VALUES(adjustment),
         note=VALUES(note), updated_by=VALUES(updated_by)`,
      { replacements: [employee_id, parseInt(year, 10), asg, adj, note || null, req.user?.id || null] }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rechazo con fecha alternativa: rechaza el permiso y propone otro rango.
router.post('/reject-alternative', authorize('admin', 'gth', 'hr', 'manager', 'coordinator'), async (req, res) => {
  try {
    const { permission_id, reason, alt_date_from, alt_date_to } = req.body || {};
    if (!permission_id) return res.status(400).json({ error: 'permission_id requerido' });
    if (alt_date_from && alt_date_to && alt_date_to < alt_date_from) {
      return res.status(400).json({ error: 'La fecha alternativa de fin no puede ser anterior a la de inicio' });
    }
    const hasAlt = !!(alt_date_from || alt_date_to);
    const [r] = await sequelize.query(
      `UPDATE permissions SET
         status = 'rejected', rejection_reason = ?, approved_by = ?, approved_at = NOW(),
         alt_date_from = ?, alt_date_to = ?, alt_proposed_by = ?,
         alt_proposed_at = ${hasAlt ? 'NOW()' : 'NULL'}
       WHERE id = ?`,
      { replacements: [
        reason || null, req.user?.id || null,
        alt_date_from || null, alt_date_to || null,
        hasAlt ? (req.user?.id || null) : null,
        permission_id,
      ] }
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Solicitud no encontrada' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
