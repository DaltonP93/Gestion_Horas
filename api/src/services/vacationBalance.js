/**
 * vacationBalance.js — Cómputo del saldo de vacaciones (self-service + gestión).
 *
 * Extraído de `routes/vacations.js` para poder reutilizar el cálculo en
 * `/api/me/vacation-balance` (portal del empleado) y en la vista global de
 * RR.HH. sin duplicar la aritmética ni el conteo de días hábiles/corridos.
 *
 * Funciones puras (testeables sin DB):
 *   - yearsBetween(hireDate, cutoff): años completos de antigüedad.
 *   - entitlementFor(brackets, years): días según los tramos configurados.
 *   - countDays(from, to, { dayType, holidaysSet }): días entre dos fechas
 *     descontando fines de semana y feriados cuando dayType='habiles'.
 *   - countTakenIn(vacations, { yearStart, yearEnd, dayType, holidaysSet }).
 *
 * Función de fachada (necesita sequelize):
 *   - computeBalance({ sequelize, employeeId, year }) → objeto con
 *     { year, day_type, hire_date, antiguedad_years, entitlement, assigned,
 *       adjustment, taken, available, note, overridden }.
 */

function yearsBetween(hireDate, cutoff) {
  if (!hireDate) return 0;
  const h = new Date(hireDate);
  const c = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (isNaN(h.getTime()) || isNaN(c.getTime())) return 0;
  let y = c.getFullYear() - h.getFullYear();
  const anniv = new Date(c.getFullYear(), h.getMonth(), h.getDate());
  if (c < anniv) y -= 1;
  return Math.max(0, y);
}

function entitlementFor(brackets, years) {
  if (!Array.isArray(brackets)) return 0;
  for (const b of brackets) {
    const okMin = years >= b.min_years;
    const okMax = b.max_years == null || years < b.max_years;
    if (okMin && okMax) return b.days;
  }
  return 0;
}

function _isoDay(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function countDays(from, to, { dayType = 'habiles', holidaysSet = new Set() } = {}) {
  const start = from instanceof Date ? new Date(from) : new Date(from);
  const end   = to   instanceof Date ? new Date(to)   : new Date(to);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return 0;
  let count = 0;
  for (const dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
    if (dayType === 'corridos') { count++; continue; }
    const dow = dt.getDay(); // 0=Dom … 6=Sáb
    if (dow !== 0 && dow !== 6 && !holidaysSet.has(_isoDay(dt))) count++;
  }
  return count;
}

function countTakenIn(vacations, { yearStart, yearEnd, dayType, holidaysSet } = {}) {
  const ys = new Date(yearStart), ye = new Date(yearEnd);
  let total = 0;
  for (const v of vacations || []) {
    let from = new Date(v.date_from), to = new Date(v.date_to);
    if (from < ys) from = new Date(ys);
    if (to > ye) to = new Date(ye);
    total += countDays(from, to, { dayType, holidaysSet });
  }
  return total;
}

async function _getDayType(sequelize) {
  const [rows] = await sequelize.query(
    "SELECT setting_value FROM notification_settings WHERE setting_key = 'vacation_day_type' LIMIT 1"
  );
  return String(rows[0]?.setting_value || 'habiles') === 'corridos' ? 'corridos' : 'habiles';
}

async function computeBalance({ sequelize, employeeId, year }) {
  const y = parseInt(year || new Date().getFullYear(), 10);
  const yearStart = `${y}-01-01`, yearEnd = `${y}-12-31`;
  const cutoff = y >= new Date().getFullYear() ? new Date() : new Date(y, 11, 31);
  const dayType = await _getDayType(sequelize);

  const [[emp]] = await sequelize.query(
    'SELECT id, hire_date FROM employees WHERE id = ? LIMIT 1',
    { replacements: [employeeId] }
  );
  if (!emp) return null;

  const [brackets] = await sequelize.query(
    'SELECT min_years, max_years, days FROM vacation_brackets WHERE active = 1 ORDER BY min_years'
  );
  const [[bal]] = await sequelize.query(
    'SELECT assigned, adjustment, note FROM vacation_balances WHERE employee_id = ? AND year = ? LIMIT 1',
    { replacements: [employeeId, y] }
  );
  const [vacs] = await sequelize.query(`
    SELECT date_from, date_to FROM permissions
    WHERE type = 'vacation' AND status = 'approved'
      AND employee_id = ? AND date_from <= ? AND date_to >= ?
  `, { replacements: [employeeId, yearEnd, yearStart] });
  const [hol] = await sequelize.query(
    'SELECT DATE_FORMAT(date, "%Y-%m-%d") AS d FROM holidays WHERE active = 1 AND date BETWEEN ? AND ?',
    { replacements: [yearStart, yearEnd] }
  );

  const years = yearsBetween(emp.hire_date, cutoff);
  const entitlement = entitlementFor(brackets, years);
  const assigned    = bal?.assigned != null ? bal.assigned : entitlement;
  const adjustment  = bal?.adjustment || 0;
  const taken       = countTakenIn(vacs, {
    yearStart, yearEnd, dayType, holidaysSet: new Set(hol.map(h => h.d)),
  });

  return {
    year: y,
    day_type: dayType,
    hire_date: emp.hire_date,
    antiguedad_years: years,
    entitlement,
    assigned,
    adjustment,
    taken,
    available: assigned + adjustment - taken,
    note: bal?.note || null,
    overridden: bal?.assigned != null,
  };
}

module.exports = {
  yearsBetween,
  entitlementFor,
  countDays,
  countTakenIn,
  computeBalance,
};
