/**
 * civilDate.js — Aritmética de fechas civiles (YYYY-MM-DD) invariante a la
 * zona horaria del proceso.
 *
 * Motivación: `new Date('YYYY-MM-DD')` parsea como UTC midnight; combinado con
 * getters/setters locales (`getDay`, `getDate`, `setDate`, `toISOString`) el
 * resultado depende de la TZ del proceso. Esto produjo saldos de vacaciones
 * distintos entre CI (UTC) y producción (America/Asuncion).
 *
 * Regla única: toda fecha "de calendario" (sin hora) se representa como un
 * Date a UTC midnight y se manipula únicamente con getters/setters UTC.
 */

const CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, '0');

function parseCivilDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return new Date(Date.UTC(
      value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(),
    ));
  }
  if (typeof value !== 'string') return null;
  const s = value.slice(0, 10);
  if (!CIVIL_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

function civilDateISO(dt) {
  if (!(dt instanceof Date) || isNaN(dt.getTime())) return null;
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function addDaysUTC(dt, n) {
  const out = new Date(dt.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function dayOfWeekUTC(dt) {
  return dt.getUTCDay();
}

const COMPANY_TZ = process.env.COMPANY_TZ || 'America/Asuncion';

function todayInCompanyTZ(now = new Date(), tz = COMPANY_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

module.exports = {
  parseCivilDate,
  civilDateISO,
  addDaysUTC,
  dayOfWeekUTC,
  todayInCompanyTZ,
  COMPANY_TZ,
};
