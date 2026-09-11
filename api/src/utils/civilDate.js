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

/**
 * Rango civil [primer día, último día] de un mes (mes 1-12), como cadenas
 * `YYYY-MM-DD`, INVARIANTE a la zona horaria del proceso.
 *
 * Motivación: `new Date(year, month, 0).toISOString().split('T')[0]` construye
 * un Date en hora LOCAL (medianoche del último día) y luego lo pasa a UTC: en
 * una TZ con offset positivo (p.ej. Asia/Tokyo, UTC+9) el instante UTC cae en el
 * día ANTERIOR, así que el "último día del mes" se corre uno para atrás y se
 * pierde el último día. Acá se usa `Date.UTC` + getters UTC: mismo resultado en
 * UTC, America/Asuncion y Asia/Tokyo.
 *
 * `Date.UTC(y, m, 0)` = día 0 del mes m+1 (0-indexado) = último día del mes m
 * (1-indexado). Cubre febrero bisiesto (29) y no-bisiesto (28) correctamente.
 */
function civilMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  return { dateFrom: civilDateISO(first), dateTo: civilDateISO(last) };
}

module.exports = {
  parseCivilDate,
  civilDateISO,
  addDaysUTC,
  dayOfWeekUTC,
  todayInCompanyTZ,
  civilMonthRange,
  COMPANY_TZ,
};
