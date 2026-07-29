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

// ─── Estado de conexión para el panel legado (frontend) ──────────────
// Enmascara el host para mostrarlo sin revelarlo por completo.
function maskHost(h) {
  const s = String(h || '').trim();
  if (!s) return '—';
  const parts = s.split('.');
  if (parts.length === 4) return `${parts[0]}.•••.•••.${parts[3]}`;
  return s.length <= 4 ? '•••' : `${s.slice(0, 2)}•••${s.slice(-2)}`;
}

// La conexión legada está configurada si hay host att2000 (ATT_HOST, el que
// usa realmente config/att2000.js para conectarse).
function connectionConfigured() {
  return !!(process.env.ATT_HOST && String(process.env.ATT_HOST).trim());
}

// Última comprobación (test de conexión). Sólo el resultado, sin credenciales.
let _lastCheck = null; // { at, ok, error }

/** Registra el resultado de un test de conexión. No incluye datos sensibles. */
function recordCheck(r = {}) {
  _lastCheck = {
    at: new Date().toISOString(),
    ok: r.ok !== false,
    error: r.error ? String(r.error).slice(0, 300) : null,
  };
  return _lastCheck;
}

/**
 * Estado de conexión para el panel legado del frontend.
 * NUNCA expone credenciales: sólo disponibilidad, host ENMASCARADO, base
 * (nombre lógico), última comprobación, último resultado y pull automático.
 */
function getConnectionStatus() {
  return {
    available: connectionConfigured(),
    auto_pull_enabled: autoPullEnabled(),
    host_masked: maskHost(process.env.ATT_HOST),
    database: String(process.env.ATT_DATABASE || 'att2000'),
    last_check: _lastCheck,
    last_run: _lastRun,
  };
}

// Sólo para pruebas: reinicia el estado en memoria.
function _reset() { _lastRun = null; _lastCheck = null; }

module.exports = {
  autoPullEnabled, available, recordRun, getStatus,
  maskHost, connectionConfigured, recordCheck, getConnectionStatus,
  _reset,
};
