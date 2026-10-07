/**
 * syncSchedule.js — Utilidades de programación del auto-polling.
 *
 * Compartidas por el worker (sishoras-sync-worker) y por las rutas de
 * configuración (para calcular next_auto_sync_at al activar, sin dejar NULL).
 * Funciones puras → cubiertas por tests.
 */

// Hora Paraguay HH:MM (24h).
const pyHHMM = (d = new Date()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d);

// Fecha Paraguay YYYY-MM-DD.
const pyDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion' }).format(d);

// ─── Fechas CIVILES 'YYYY-MM-DD' (sin hora ni zona) ─────────────
// Un rango de lectura es un par de días del calendario de Paraguay. Se opera
// sobre el texto: convertirlo en un instante UTC y volver a formatearlo en
// Paraguay corre el día (00:00 UTC = 21:00 del día anterior en Paraguay).
const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCivilDate(s) {
  const m = typeof s === 'string' && s.match(CIVIL_DATE_RE);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Fecha civil tal cual llega de una columna DATE (mysql2/sequelize la devuelven
// como texto 'YYYY-MM-DD'). Cualquier otra representación se rechaza en vez de
// reinterpretarla como instante.
function civilDate(v, label = 'fecha') {
  if (isCivilDate(v)) return v;
  throw new Error(`${label} no es una fecha civil YYYY-MM-DD: ${v instanceof Date ? 'Date' : JSON.stringify(v)}`);
}

// Suma días de calendario a una fecha civil (aritmética UTC pura: no depende
// de la zona del proceso ni de cambios de horario).
function addCivilDays(ymd, days) {
  const [y, m, d] = civilDate(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ¿Está HH:MM dentro de la ventana "HH:MM-HH:MM"? Ventana inválida = sin restricción.
function inWindow(win, hhmm = pyHHMM()) {
  const m = String(win || '').match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
  if (!m) return true;
  return hhmm >= m[1] && hhmm <= m[2];
}

// Próxima ejecución alineada al offset, en la hora local del proceso (TZ del server).
// intervalo 15 offset 5 → :05 :20 :35 :50. Mínimo 1 minuto en el futuro.
function computeNextRun(intervalMin, offsetMin, from = new Date()) {
  const interval = Math.max(5, parseInt(intervalMin, 10) || 15);
  const base = ((parseInt(offsetMin, 10) || 0) % interval + interval) % interval;
  const d = new Date(from.getTime() + 60_000);
  const mins = d.getHours() * 60 + d.getMinutes();
  let m = Math.ceil((mins - base) / interval) * interval + base;
  if (m <= mins) m += interval;
  const next = new Date(d);
  next.setHours(0, m, 0, 0);   // JS normaliza minutos > 59
  return next;
}

module.exports = { pyHHMM, pyDate, isCivilDate, civilDate, addCivilDays, inWindow, computeNextRun };
