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

module.exports = { pyHHMM, pyDate, inWindow, computeNextRun };
