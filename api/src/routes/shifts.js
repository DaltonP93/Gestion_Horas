/**
 * shifts.js — Turnera (programación de turnos / calendario).
 *
 * Permite armar la planilla mensual de turnos por sede/departamento,
 * replicando la turnera de recepción: cada empleado tiene por día uno o
 * dos tramos de horario (turno partido), se calculan las horas por día y
 * el total semanal, y se controla el cumplimiento de las 48 hs semanales.
 *
 * Endpoints (montado en /api/shifts):
 *   GET    /templates                     lista de plantillas de turno
 *   POST   /templates                     crea plantilla
 *   PUT    /templates/:id                 edita plantilla
 *   DELETE /templates/:id                 elimina plantilla
 *
 *   GET    /schedules?branch_id=&year=&month=   lista de turneras
 *   POST   /schedules                     crea turnera (cabecera)
 *   GET    /schedules/:id                 turnera completa (grilla + totales)
 *   PUT    /schedules/:id                 edita cabecera / publica
 *   DELETE /schedules/:id                 elimina turnera
 *   PUT    /schedules/:id/assignments     upsert masivo de asignaciones
 *   GET    /schedules/:id/export?format=xlsx   exporta la grilla a Excel
 */
const router = require('express').Router();
const ExcelJS = require('exceljs');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { sequelize } = require('../config/database');

router.use(authenticate);
// Incluye 'gestor': el módulo 'turnera' es de sección gestión, así que
// defaultsForRole('gestor') le da can_view; si no estuviera acá, el allowlist
// del router respondería 403 antes de que requirePermission aplique la flag.
router.use(authorize('admin', 'super_admin', 'gth', 'hr', 'manager', 'coordinator', 'supervisor', 'gestor'));

const MODULE = 'turnera';
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S']; // Domingo..Sábado (como la turnera)

// ── Helpers ────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// Minutos entre dos horas "HH:MM[:SS]". Si el fin es menor al inicio se asume
// que cruza medianoche (turno nocturno). Descuenta el break.
function shiftMinutes(start, end, breakMin = 0) {
  if (!start || !end) return 0;
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  let diff = toMin(end) - toMin(start);
  if (diff < 0) diff += 24 * 60; // cruza medianoche
  diff -= Number(breakMin || 0);
  return diff > 0 ? diff : 0;
}

// Devuelve los días del mes y las semanas (Domingo→Sábado) que lo cubren,
// arrancando desde el domingo anterior al día 1 (igual que la turnera, que
// empieza en la semana que contiene al 1).
function buildCalendar(year, month) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  // Retroceder hasta el domingo (getDay()===0) de esa semana.
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const weeks = [];
  let cursor = new Date(start);
  while (cursor <= last) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      days.push({
        date: ymd(d),
        day: d.getDate(),
        dow: DOW[d.getDay()],
        in_month: d.getMonth() === month - 1,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push({ start: days[0].date, end: days[6].date, days });
  }
  return { weeks, from: ymd(start), to: ymd(new Date(weeks[weeks.length - 1].end)) };
}

async function loadSchedule(id) {
  const [rows] = await sequelize.query('SELECT * FROM shift_schedules WHERE id = ? LIMIT 1', { replacements: [id] });
  return rows[0] || null;
}

// Empleados activos que corresponden a la turnera (por sede/depto si aplica).
async function scheduleEmployees(sched) {
  const where = ["e.status = 'active'"];
  const params = [];
  if (sched.branch_id) { where.push('e.branch_id = ?'); params.push(sched.branch_id); }
  if (sched.department_id) { where.push('e.department_id = ?'); params.push(sched.department_id); }
  const [rows] = await sequelize.query(`
    SELECT e.id, e.code, CONCAT(e.first_name, ' ', e.last_name) AS name,
           COALESCE(d.name,'') AS department, COALESCE(b.name,'') AS branch
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN branches b    ON b.id = e.branch_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.first_name, e.last_name
  `, { replacements: params });
  return rows;
}

// ── Plantillas de turno ────────────────────────────────────────
router.get('/templates', requirePermission(MODULE, 'view'), async (req, res, next) => {
  try {
    const [rows] = await sequelize.query('SELECT * FROM shift_templates ORDER BY active DESC, name');
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/templates', requirePermission(MODULE, 'create'), async (req, res, next) => {
  try {
    const { name, start_time, end_time, break_minutes, color } = req.body || {};
    if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const [r] = await sequelize.query(
      'INSERT INTO shift_templates (name, start_time, end_time, break_minutes, color) VALUES (?,?,?,?,?)',
      { replacements: [name, start_time || null, end_time || null, +(break_minutes || 0), color || '#0ea5e9'] }
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

router.put('/templates/:id', requirePermission(MODULE, 'update'), async (req, res, next) => {
  try {
    const { name, start_time, end_time, break_minutes, color, active } = req.body || {};
    await sequelize.query(
      `UPDATE shift_templates SET name=?, start_time=?, end_time=?, break_minutes=?, color=?, active=? WHERE id=?`,
      { replacements: [name, start_time || null, end_time || null, +(break_minutes || 0), color || '#0ea5e9',
        active == null ? 1 : (active ? 1 : 0), req.params.id] }
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/templates/:id', requirePermission(MODULE, 'delete'), async (req, res, next) => {
  try {
    await sequelize.query('DELETE FROM shift_templates WHERE id = ?', { replacements: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Turneras (cabecera) ────────────────────────────────────────
router.get('/schedules', requirePermission(MODULE, 'view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.year)  { where.push('s.year = ?');  params.push(+req.query.year); }
    if (req.query.month) { where.push('s.month = ?'); params.push(+req.query.month); }
    if (req.query.branch_id) { where.push('s.branch_id = ?'); params.push(+req.query.branch_id); }
    const [rows] = await sequelize.query(`
      SELECT s.*, COALESCE(b.name,'') AS branch_name, COALESCE(d.name,'') AS department_name
      FROM shift_schedules s
      LEFT JOIN branches b    ON b.id = s.branch_id
      LEFT JOIN departments d ON d.id = s.department_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.year DESC, s.month DESC, s.name
    `, { replacements: params });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/schedules', requirePermission(MODULE, 'create'), async (req, res, next) => {
  try {
    const now = new Date();
    const { name, branch_id, department_id, notes } = req.body || {};
    const year  = +(req.body?.year  || now.getFullYear());
    const month = +(req.body?.month || (now.getMonth() + 1));
    const weekly = +(req.body?.weekly_target_minutes || 2880);
    const finalName = name || `Turnera ${MESES[month - 1]} ${year}`;
    const [r] = await sequelize.query(
      `INSERT INTO shift_schedules (name, branch_id, department_id, year, month, weekly_target_minutes, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      { replacements: [finalName, branch_id || null, department_id || null, year, month, weekly, notes || null, req.user?.id || null] }
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

router.put('/schedules/:id', requirePermission(MODULE, 'update'), async (req, res, next) => {
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) return res.status(404).json({ error: 'Turnera no encontrada' });
    const name = req.body?.name ?? sched.name;
    const notes = req.body?.notes ?? sched.notes;
    const status = req.body?.status ?? sched.status;
    const weekly = req.body?.weekly_target_minutes ?? sched.weekly_target_minutes;
    await sequelize.query(
      'UPDATE shift_schedules SET name=?, notes=?, status=?, weekly_target_minutes=? WHERE id=?',
      { replacements: [name, notes, status, weekly, req.params.id] }
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/schedules/:id', requirePermission(MODULE, 'delete'), async (req, res, next) => {
  try {
    await sequelize.query('DELETE FROM shift_schedules WHERE id = ?', { replacements: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Turnera completa: cabecera + calendario + empleados + asignaciones + totales.
router.get('/schedules/:id', requirePermission(MODULE, 'view'), async (req, res, next) => {
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) return res.status(404).json({ error: 'Turnera no encontrada' });

    const cal = buildCalendar(sched.year, sched.month);
    const employees = await scheduleEmployees(sched);

    const [assigns] = await sequelize.query(
      `SELECT id, employee_id, DATE_FORMAT(work_date,'%Y-%m-%d') AS work_date,
              segment, start_time, end_time, template_id, kind, note, minutes
       FROM shift_assignments WHERE schedule_id = ? ORDER BY employee_id, work_date, segment`,
      { replacements: [req.params.id] }
    );

    // Index asignaciones por empleado→fecha→[tramos]
    const byEmp = {};
    for (const a of assigns) {
      (byEmp[a.employee_id] ||= {});
      (byEmp[a.employee_id][a.work_date] ||= []).push(a);
    }

    // Totales por empleado y por semana.
    const target = sched.weekly_target_minutes || 2880;
    for (const emp of employees) {
      const cells = byEmp[emp.id] || {};
      emp.weekly = cal.weeks.map(w => {
        let minutes = 0;
        for (const d of w.days) {
          for (const a of (cells[d.date] || [])) minutes += Number(a.minutes || 0);
        }
        return { start: w.start, end: w.end, minutes, meets_target: minutes >= target };
      });
      emp.total_minutes = emp.weekly.reduce((s, w) => s + w.minutes, 0);
    }

    res.json({ schedule: sched, calendar: cal, weekly_target_minutes: target, employees, assignments: assigns });
  } catch (e) { next(e); }
});

// Upsert masivo de asignaciones (guardar la grilla).
// body: { assignments:[{employee_id,work_date,segment,start_time,end_time,template_id,kind,note}], removed:[ids] }
router.put('/schedules/:id/assignments', requirePermission(MODULE, 'update'), async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) { await t.rollback(); return res.status(404).json({ error: 'Turnera no encontrada' }); }

    const removed = Array.isArray(req.body?.removed) ? req.body.removed.filter(Number.isFinite) : [];
    if (removed.length) {
      await sequelize.query(
        `DELETE FROM shift_assignments WHERE schedule_id = ? AND id IN (${removed.map(() => '?').join(',')})`,
        { replacements: [req.params.id, ...removed], transaction: t }
      );
    }

    // Cargar breaks de plantillas referenciadas para el cálculo de minutos.
    const [tpls] = await sequelize.query('SELECT id, break_minutes FROM shift_templates', { transaction: t });
    const breakOf = Object.fromEntries(tpls.map(x => [x.id, x.break_minutes]));

    const items = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    for (const a of items) {
      if (!a.employee_id || !a.work_date) continue;
      const segment = +(a.segment || 1);
      const kind = a.kind || 'work';
      const brk = a.template_id ? (breakOf[a.template_id] || 0) : 0;
      const minutes = kind === 'work' ? shiftMinutes(a.start_time, a.end_time, brk) : 0;
      await sequelize.query(
        `INSERT INTO shift_assignments
           (schedule_id, employee_id, work_date, segment, start_time, end_time, template_id, kind, note, minutes)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           start_time=VALUES(start_time), end_time=VALUES(end_time),
           template_id=VALUES(template_id), kind=VALUES(kind),
           note=VALUES(note), minutes=VALUES(minutes)`,
        { replacements: [
          req.params.id, a.employee_id, a.work_date, segment,
          a.start_time || null, a.end_time || null, a.template_id || null,
          kind, a.note || null, minutes,
        ], transaction: t }
      );
    }

    await t.commit();
    res.json({ ok: true, saved: items.length, removed: removed.length });
  } catch (e) { await t.rollback(); next(e); }
});

// ── Exportar la turnera a Excel (grilla estilo planilla) ───────
router.get('/schedules/:id/export', requirePermission(MODULE, 'view'), async (req, res, next) => {
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) return res.status(404).json({ error: 'Turnera no encontrada' });
    const cal = buildCalendar(sched.year, sched.month);
    const employees = await scheduleEmployees(sched);
    const [assigns] = await sequelize.query(
      `SELECT employee_id, DATE_FORMAT(work_date,'%Y-%m-%d') AS work_date, segment,
              TIME_FORMAT(start_time,'%H:%i') AS start_time, TIME_FORMAT(end_time,'%H:%i') AS end_time,
              kind, minutes
       FROM shift_assignments WHERE schedule_id = ? ORDER BY employee_id, work_date, segment`,
      { replacements: [sched.id] }
    );
    const byEmp = {};
    for (const a of assigns) {
      (byEmp[a.employee_id] ||= {});
      (byEmp[a.employee_id][a.work_date] ||= []).push(a);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Turnera ${MESES[sched.month - 1]}`);
    const allDays = cal.weeks.flatMap(w => w.days);

    // Fila 1: título
    ws.mergeCells(1, 1, 1, allDays.length + 2);
    ws.getCell(1, 1).value = `${sched.name} — ${MESES[sched.month - 1]} ${sched.year}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };

    // Fila 2 (DOW) y 3 (día del mes)
    ws.getCell(2, 1).value = 'Empleado';
    ws.getCell(3, 1).value = '';
    allDays.forEach((d, i) => {
      const c = i + 2;
      ws.getCell(2, c).value = d.dow;
      ws.getCell(3, c).value = d.day;
      ws.getCell(2, c).alignment = ws.getCell(3, c).alignment = { horizontal: 'center' };
      if (!d.in_month) { ws.getCell(2, c).font = ws.getCell(3, c).font = { color: { argb: 'FFBBBBBB' } }; }
    });
    ws.getCell(2, allDays.length + 2).value = 'Total hs';
    ws.getRow(2).font = { bold: true };
    ws.getRow(3).font = { bold: true };

    const target = sched.weekly_target_minutes || 2880;
    let r = 4;
    for (const emp of employees) {
      const cells = byEmp[emp.id] || {};
      ws.getCell(r, 1).value = emp.name;
      let totalMin = 0;
      allDays.forEach((d, i) => {
        const segs = cells[d.date] || [];
        const txt = segs.filter(s => s.kind === 'work' && s.start_time)
          .map(s => `${s.start_time}-${s.end_time}`).join(' / ')
          || (segs.find(s => s.kind && s.kind !== 'work')?.kind || '');
        ws.getCell(r, i + 2).value = txt;
        ws.getCell(r, i + 2).alignment = { horizontal: 'center' };
        totalMin += segs.reduce((s, x) => s + Number(x.minutes || 0), 0);
      });
      const tCell = ws.getCell(r, allDays.length + 2);
      tCell.value = +(totalMin / 60).toFixed(2);
      tCell.font = { bold: true };
      r++;
    }

    ws.getColumn(1).width = 24;
    for (let i = 0; i < allDays.length; i++) ws.getColumn(i + 2).width = 11;
    ws.getColumn(allDays.length + 2).width = 10;

    // Nota: los totales semanales (control de 48 hs) se ven en la app; el
    // Excel exporta el total mensual por empleado.
    void target;

    const fname = `turnera_${sched.year}-${pad(sched.month)}_${sched.id}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

// ── Cumplimiento: turno planificado vs. asistencia real ────────
// Compara la turnera (shift_assignments) con lo efectivamente marcado
// (daily_summary) en el mismo período: atrasos, ausencias y días
// trabajados sin turno asignado.
function toMin(t) {
  if (!t) return null;
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1] * 60 + +m[2]) : null;
}

router.get('/schedules/:id/compliance', requirePermission(MODULE, 'view'), async (req, res, next) => {
  try {
    const sched = await loadSchedule(req.params.id);
    if (!sched) return res.status(404).json({ error: 'Turnera no encontrada' });
    const tol = Number.isFinite(+req.query.tol) ? +req.query.tol : 10; // tolerancia atraso (min)
    const cal = buildCalendar(sched.year, sched.month);
    const employees = await scheduleEmployees(sched);

    // Turnos planificados por empleado/día (tramos work).
    const [plans] = await sequelize.query(`
      SELECT employee_id, DATE_FORMAT(work_date,'%Y-%m-%d') AS d,
             TIME_FORMAT(MIN(start_time),'%H:%i') AS ps, TIME_FORMAT(MAX(end_time),'%H:%i') AS pe,
             SUM(minutes) AS pm
      FROM shift_assignments
      WHERE schedule_id = ? AND kind = 'work'
      GROUP BY employee_id, work_date
    `, { replacements: [sched.id] });
    const planned = {};
    for (const p of plans) (planned[p.employee_id] ||= {})[p.d] = p;

    // Marcaciones reales del período.
    const empIds = employees.map(e => e.id);
    let actuals = [];
    if (empIds.length) {
      const [rows] = await sequelize.query(`
        SELECT employee_id, DATE_FORMAT(date,'%Y-%m-%d') AS d,
               TIME_FORMAT(first_in,'%H:%i') AS ai, TIME_FORMAT(last_out,'%H:%i') AS ao,
               COALESCE(worked_minutes,0) AS wm, status
        FROM daily_summary
        WHERE employee_id IN (${empIds.map(() => '?').join(',')}) AND date BETWEEN ? AND ?
      `, { replacements: [...empIds, cal.from, cal.to] });
      actuals = rows;
    }
    const actual = {};
    for (const a of actuals) (actual[a.employee_id] ||= {})[a.d] = a;

    // Sólo hasta hoy: un turno planificado a futuro aún no tiene marcación y
    // no debe reportarse como ausencia. Se usa la fecha calendario de Paraguay
    // (UTC-3, igual que la BD) y no la del proceso, que en producción es UTC.
    const pyNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const today = `${pyNow.getUTCFullYear()}-${pad(pyNow.getUTCMonth() + 1)}-${pad(pyNow.getUTCDate())}`;
    const allDays = cal.weeks.flatMap(w => w.days)
      .filter(d => d.in_month && d.date <= today).map(d => d.date);

    const result = employees.map(emp => {
      const pj = planned[emp.id] || {};
      const aj = actual[emp.id] || {};
      const days = [];
      const sum = { planificados: 0, trabajados: 0, ausencias: 0, atrasos: 0, sin_plan: 0, atraso_min: 0 };
      for (const date of allDays) {
        const p = pj[date];
        const a = aj[date];
        const worked = a && (a.status === 'present' || a.status === 'late' || Number(a.wm) > 0);
        let flag = null, lateMin = 0;
        if (p) {
          sum.planificados++;
          if (worked) {
            sum.trabajados++;
            const ps = toMin(p.ps), ai = toMin(a.ai);
            if (ps != null && ai != null && ai > ps + tol) { flag = 'late'; lateMin = ai - ps; sum.atrasos++; sum.atraso_min += lateMin; }
            else flag = 'ok';
          } else {
            flag = 'absent'; sum.ausencias++;
          }
        } else if (worked) {
          flag = 'unplanned'; sum.sin_plan++;
        }
        if (flag) days.push({
          date, flag, late_min: lateMin,
          planned: p ? { start: p.ps, end: p.pe, minutes: Number(p.pm) } : null,
          actual: a ? { in: a.ai, out: a.ao, worked_min: Number(a.wm), status: a.status } : null,
        });
      }
      return { id: emp.id, code: emp.code, name: emp.name, department: emp.department, summary: sum, days };
    });

    res.json({ schedule: { id: sched.id, name: sched.name, year: sched.year, month: sched.month }, tolerance_min: tol, employees: result });
  } catch (e) { next(e); }
});

module.exports = router;
