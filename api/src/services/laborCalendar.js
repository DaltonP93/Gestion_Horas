'use strict';

/**
 * laborCalendar.js — lógica PURA de calendario laboral (sin base de datos).
 *
 * Clasifica cada fecha civil como laborable o no, componiendo:
 *   - excepciones del calendario (no laborable / laborable / especial),
 *   - feriados,
 *   - el modelo de semana (domingo de descanso por defecto) o los `work_days`
 *     configurados.
 *
 * INVARIANTE DE ZONA HORARIA: opera sólo sobre fechas civiles (YYYY-MM-DD) con
 * los helpers UTC de `civilDate`, así el resultado NO depende de la TZ del
 * proceso (mismo output en UTC, America/Asuncion o Asia/Tokyo). La TZ del
 * calendario sólo importa para decidir "qué día es hoy", no para clasificar una
 * fecha dada.
 *
 * Convención de `work_days`: 1=domingo … 7=sábado (igual que el motor de
 * jornada). JS `getUTCDay()` da 0=domingo … 6=sábado, por eso se mapea +1.
 */

const {
  parseCivilDate, civilDateISO, addDaysUTC, dayOfWeekUTC, todayInCompanyTZ, COMPANY_TZ,
} = require('../utils/civilDate');

const MAX_RANGE_DAYS = 800; // límite defensivo (~2 años)

function mysqlDow(jsDow) {
  return jsDow + 1; // 0..6 → 1..7 (1=domingo)
}

/**
 * Clasifica una fecha.
 * @param {string} iso  YYYY-MM-DD
 * @param {object} opts
 *   - workDays: número[] con 1..7 (1=domingo) o null/undefined (desconocido).
 *   - holidaySet: Set<string> de fechas feriado (YYYY-MM-DD).
 *   - exceptionMap: Map<string, 'nonworking'|'working'|'special'>.
 * @returns {{date, working, reason, label?}}
 */
function classifyDay(iso, { workDays = null, holidaySet = new Set(), exceptionMap = new Map() } = {}) {
  const dt = parseCivilDate(iso);
  if (!dt) throw new Error(`Fecha civil inválida: ${iso}`);
  const date = civilDateISO(dt);
  const dow = dayOfWeekUTC(dt); // 0=domingo

  const exc = exceptionMap.get(date);
  if (exc === 'working') return { date, working: true, reason: 'exception_working' };
  if (exc === 'nonworking') return { date, working: false, reason: 'exception_nonworking' };

  if (holidaySet.has(date)) return { date, working: false, reason: 'holiday' };

  let working;
  if (Array.isArray(workDays) && workDays.length) {
    working = workDays.includes(mysqlDow(dow));
  } else {
    working = dow !== 0; // sin config: descanso dominical por defecto
  }

  let reason;
  if (working) reason = exc === 'special' ? 'special' : 'workday';
  else reason = dow === 0 ? 'sunday' : 'rest_day';

  return { date, working, reason };
}

/**
 * Compone el calendario efectivo para un rango [from, to] inclusive.
 * Puro: no consulta base. Rechaza rangos inválidos o excesivos.
 */
function composeRange(from, to, opts = {}) {
  const start = parseCivilDate(from);
  const end = parseCivilDate(to);
  if (!start || !end) throw new Error('Rango de fechas inválido');
  if (end.getTime() < start.getTime()) throw new Error('`to` es anterior a `from`');
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error(`Rango demasiado amplio (máx ${MAX_RANGE_DAYS} días)`);

  const out = [];
  let cur = start;
  for (let i = 0; i < days; i++) {
    out.push(classifyDay(civilDateISO(cur), opts));
    cur = addDaysUTC(cur, 1);
  }
  return out;
}

function isSunday(iso) {
  const dt = parseCivilDate(iso);
  if (!dt) return false;
  return dayOfWeekUTC(dt) === 0;
}

/** Cuenta de días laborables en el rango compuesto. */
function countWorking(range) {
  return range.reduce((n, d) => n + (d.working ? 1 : 0), 0);
}

module.exports = {
  classifyDay,
  composeRange,
  isSunday,
  countWorking,
  mysqlDow,
  todayInCompanyTZ,
  COMPANY_TZ,
  MAX_RANGE_DAYS,
};
