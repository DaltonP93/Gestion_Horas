/**
 * att2000Legacy.js — Estado de la integración LEGADA att2000 (SQL Server).
 *
 * La integración att2000 pasa a ser una integración legada OPCIONAL (contingencia,
 * migración y recuperación histórica), no el flujo normal de marcaciones.
 *
 *  - `autoPullEnabled()`: kill switch del pull automático (cron). Por defecto
 *    DESHABILITADO. El cron se registra SÓLO si ATT2000_AUTO_PULL_ENABLED=true.
 *  - `available()`: la integración está configurada (hay host att2000).
 *  - `recordRun()` / `getStatus()`: última ejecución (auto o manual) para
 *    mostrar en Salud del sistema. En memoria (no persiste secretos).
 *
 * NUNCA expone credenciales: sólo estado, contadores y timestamps.
 */

function autoPullEnabled() {
  return String(process.env.ATT2000_AUTO_PULL_ENABLED || '').toLowerCase() === 'true';
}

function available() {
  return !!(process.env.ATT2000_HOST && String(process.env.ATT2000_HOST).trim());
}

// Última corrida registrada (auto o manual). No incluye datos sensibles.
let _lastRun = null; // { at, source, ok, imported, duplicate, unmapped, error }

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Registra el resultado de una corrida att2000 (cron o endpoint manual).
 * @param {object} r { source:'auto'|'manual', ok, imported, duplicate, unmapped, error }
 */
function recordRun(r = {}) {
  _lastRun = {
    at: new Date().toISOString(),
    source: r.source === 'auto' ? 'auto' : 'manual',
    ok: r.ok !== false,
    imported: num(r.imported),
    duplicate: num(r.duplicate),
    unmapped: num(r.unmapped),
    error: r.error ? String(r.error).slice(0, 300) : null,
  };
  return _lastRun;
}

/** Estado para Salud del sistema (sin secretos). */
function getStatus() {
  return {
    available: available(),
    auto_pull_enabled: autoPullEnabled(),
    last_run: _lastRun,
  };
}

// Sólo para pruebas: reinicia el estado en memoria.
function _reset() { _lastRun = null; }

module.exports = { autoPullEnabled, available, recordRun, getStatus, _reset };
