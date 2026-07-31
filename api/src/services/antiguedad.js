/**
 * antiguedad.js — Cálculo derivado de la antigüedad de un empleado.
 *
 * Fuente única: `employees.hire_date`. Nunca se persiste el valor;
 * se recalcula al leer/mostrar.
 *
 * Reglas:
 *   - años completos y meses completos desde hire_date hasta refDate;
 *     un mes/año se cuenta solo si ya pasó el mismo día del mes;
 *   - año bisiesto respetado (nunca se produce 30-feb);
 *   - TZ-invariante: usa `parseCivilDate` (UTC estricto);
 *   - hire_date > refDate → { years:0, months:0 };
 *   - hire_date inválido/ausente → null.
 */

const { parseCivilDate } = require('../utils/civilDate');

function _lastDayOfUTCMonth(year, monthIndex /* 0..11 */) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function computeAntiguedad(hireDate, refDate) {
  const h = parseCivilDate(hireDate);
  const r = parseCivilDate(refDate);
  if (!h || !r) return null;
  if (h.getTime() > r.getTime()) return { years: 0, months: 0, days: 0 };

  let years  = r.getUTCFullYear()  - h.getUTCFullYear();
  let months = r.getUTCMonth()     - h.getUTCMonth();
  let days   = r.getUTCDate()      - h.getUTCDate();

  if (days < 0) {
    months -= 1;
    // días del mes previo al refDate (calendario UTC)
    const prevMonth = r.getUTCMonth() === 0 ? 11 : r.getUTCMonth() - 1;
    const prevYear  = r.getUTCMonth() === 0 ? r.getUTCFullYear() - 1 : r.getUTCFullYear();
    days += _lastDayOfUTCMonth(prevYear, prevMonth);
  }
  if (months < 0) { years -= 1; months += 12; }
  return { years, months, days };
}

// Etiqueta amigable en español. Ejemplos:
//  {years:0, months:0} → "Menos de 1 mes"
//  {years:0, months:6} → "6 meses"
//  {years:1, months:0} → "1 año"
//  {years:2, months:1} → "2 años y 1 mes"
//  {years:10, months:6} → "10 años y 6 meses"
function formatAntiguedad(a) {
  if (!a) return 'Sin fecha de ingreso';
  const { years, months } = a;
  const yLabel = years > 0 ? `${years} ${years === 1 ? 'año' : 'años'}` : '';
  const mLabel = months > 0 ? `${months} ${months === 1 ? 'mes' : 'meses'}` : '';
  if (!yLabel && !mLabel) return 'Menos de 1 mes';
  if (!yLabel) return mLabel;
  if (!mLabel) return yLabel;
  return `${yLabel} y ${mLabel}`;
}

module.exports = { computeAntiguedad, formatAntiguedad };
