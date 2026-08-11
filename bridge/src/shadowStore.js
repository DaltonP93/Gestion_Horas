/**
 * shadowStore.js — almacenamiento durable de observaciones en modo SOMBRA.
 *
 * ── Qué es el modo sombra ────────────────────────────────────────────
 *
 * Guardar una COPIA de lo que ya llega por PUSH, normalizada con el contrato
 * v1, para poder compararla más adelante contra lo que ve el polling. Nada
 * más. La marcación sigue su camino actual sin enterarse: el modo sombra no
 * es un productor autoritativo.
 *
 * Lo que este módulo NO hace, y no debe empezar a hacer sin una decisión
 * explícita: INSERT en `attendance`, UPDATE en `daily_summary`, XADD a Redis,
 * POST a la API, ACK al reloj, apagar el polling o borrar logs del reloj.
 *
 * ── Por qué no reutiliza el Outbox ───────────────────────────────────
 *
 * El Outbox (`outbox.js`) es una cola de TRANSMISIÓN: sus filas existen para
 * salir y se borran tras el ACK, y su máquina de estados
 * (pending→sending→acknowledged) sólo tiene sentido si hay alguien
 * transmitiendo. La sombra es lo contrario: un registro de OBSERVACIÓN que no
 * sale a ningún lado y que se conserva justamente para poder mirarlo después.
 *
 * Meterlas en la misma tabla ataría dos ciclos de vida distintos y, sobre
 * todo, ataría las flags: hoy `BRIDGE_OUTBOX_ENABLED=false` y encender la
 * sombra no puede encender de refilón una cola de transmisión. Son archivos,
 * flags y tablas separados a propósito.
 *
 * ── UNIQUE (source, event_id), no UNIQUE (event_id) ──────────────────
 *
 * `event_id` sale de la IDENTIDAD del marcaje —device_id, device_user_id,
 * occurred_at, event_type— y de nada más. Es lo que hace posible la
 * comparación: el mismo marcaje visto por PUSH y por polling calcula el mismo
 * identificador sin coordinación.
 *
 * Por eso mismo, un UNIQUE sobre `event_id` solo haría imposible guardar la
 * observación de polling de un marcaje que PUSH ya vio, que es exactamente el
 * caso que este almacén existe para poder contrastar. La unicidad va por
 * (source, event_id): "una observación por origen", y el duplicado dentro de
 * un mismo origen se descarta en silencio.
 *
 * ── Retención ────────────────────────────────────────────────────────
 *
 * No hay limpieza automática, ni por edad ni por tamaño. Vaciar es una
 * operación administrativa explícita (`purge`), expuesta sólo detrás de la
 * clave de la API del Bridge. Una sombra que se borra sola perdería
 * justamente el período que se quiere comparar.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateEvent, normalizeTimestamp } = require('../../contracts/punchContractV1');

/** Orígenes de observación. `polling` está previsto pero NO conectado. */
const SHADOW_SOURCES = Object.freeze(['push', 'polling']);

const SHADOW_ERRORS = Object.freeze({
  DISABLED:         'shadow_disabled',
  PATH_MISSING:     'shadow_path_missing',
  OPEN_FAILED:      'shadow_open_failed',
  NOT_OPEN:         'shadow_not_open',
  CONTRACT_INVALID: 'shadow_contract_invalid',
  SOURCE_INVALID:   'shadow_source_invalid',
  DEVICE_KEY_MISSING: 'shadow_device_key_missing',
  WRITE_FAILED:     'shadow_write_failed',
  BEFORE_INVALID:   'shadow_before_invalid',
});

/**
 * Instante ISO-8601 con offset EXPLÍCITO (`Z` o `±HH:MM`).
 *
 * El offset no es opcional acá. `occurred_at` se guarda siempre en UTC, y una
 * hora de pared sin offset obligaría a suponer una zona para decidir qué se
 * borra: en una operación destructiva, suponer está fuera de discusión.
 */
const ISO_CON_OFFSET_ESTRICTO =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Valida el corte de `purge`. Devuelve `{ ok, value }`.
 *
 * Sin esto, el valor viajaba tal cual a una comparación LEXICOGRÁFICA de
 * SQLite. `occurred_at < 'not-a-date'` es verdadero para TODA marca de tiempo
 * ISO —'2' < 'n'—, así que un `before` mal tipeado no acotaba el borrado: lo
 * volvía total. Un purge que se pidió parcial no puede vaciar la tabla porque
 * la fecha estaba mal escrita.
 */
function normalizeBefore(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  if (!ISO_CON_OFFSET_ESTRICTO.test(s)) return { ok: false };

  // El contrato rechaza además fechas civiles imposibles (2026-02-31), que la
  // expresión regular acepta por forma.
  const canon = normalizeTimestamp(s);
  return canon ? { ok: true, value: canon } : { ok: false };
}

const DEFAULTS = Object.freeze({
  BUSY_TIMEOUT_MS: 5000,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT    NOT NULL,
  -- Identidad ESTABLE del reloj (serial, o ip:puerto si no declara serial).
  -- Nunca la posición dentro de ZKTECO_DEVICES: reordenar la variable no
  -- puede cambiar a quién pertenece una fila ya escrita.
  device_key     TEXT    NOT NULL,
  -- Entero exigido por el contrato v1, derivado de device_key. Es un
  -- subrogado LOCAL de la sombra: no es devices.id de MySQL ni el índice de
  -- ZKTECO_DEVICES. Se guarda para poder recomputar el event_id.
  device_id      INTEGER NOT NULL,
  source         TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  occurred_at    TEXT    NOT NULL,
  observed_at    TEXT    NOT NULL,
  CHECK (source IN ('push','polling')),
  UNIQUE (source, event_id)
);
CREATE INDEX IF NOT EXISTS idx_shadow_device   ON shadow_events (device_key, occurred_at);
CREATE INDEX IF NOT EXISTS idx_shadow_source   ON shadow_events (source, occurred_at);
CREATE INDEX IF NOT EXISTS idx_shadow_event    ON shadow_events (event_id);
CREATE INDEX IF NOT EXISTS idx_shadow_occurred ON shadow_events (occurred_at);
`;

// ── Configuración ────────────────────────────────────────────────────

function readStoreConfig(env = process.env) {
  return {
    enabled: env.BRIDGE_SHADOW_ENABLED === 'true',
    dbPath: (env.BRIDGE_SHADOW_PATH || '').trim(),
  };
}

/**
 * Campos que se persisten. Lista CERRADA, igual que en el Outbox y por el
 * mismo motivo: es un archivo sin cifrar en un host de la misma LAN que los
 * relojes. `validateEvent` ignora las propiedades que no conoce, así que una
 * lista de prohibidos dejaría pasar `auth_token` —o un `metadata` anidado—
 * sin que nadie lo note. Acá sólo entra lo que está nombrado.
 *
 * En particular NO se guarda: nombre del empleado, IP del reloj, plantilla
 * biométrica, foto, ni la línea ATTLOG cruda.
 */
const CAMPOS_PERSISTIDOS = Object.freeze([
  'event_id',
  'device_id',
  'device_user_id',
  'occurred_at',
  'event_type',
  'verify_mode',
  'work_code',
]);

function sanitizeShadowPayload(evento) {
  const limpio = {};
  for (const k of CAMPOS_PERSISTIDOS) {
    if (evento[k] !== undefined) limpio[k] = evento[k];
  }
  return limpio;
}

/**
 * Entero positivo estable derivado de la identidad del reloj.
 *
 * El contrato v1 exige `device_id` entero > 0, pero la identidad estable
 * disponible en el Bridge es texto (el serial que el reloj reporta por PUSH).
 * Se deriva por hash para que el mismo reloj dé siempre el mismo número, en
 * cualquier proceso y sin coordinación —que es lo que necesita el event_id
 * para ser comparable entre PUSH y polling—.
 *
 * Se usan 6 bytes (< 2^53) para que quepa exacto en un entero de JS y SQLite
 * lo guarde como INTEGER y no como float.
 */
function deviceIdFromKey(deviceKey) {
  const h = crypto.createHash('sha256').update(String(deviceKey), 'utf8').digest();
  const n = h.readUIntBE(0, 6);
  return n + 1;   // > 0 incluso en el caso imposible de que el hash arranque en cero
}

// ── Almacén ──────────────────────────────────────────────────────────

class ShadowStore {
  constructor(config) {
    this.config = config;
    this.db = null;
  }

  get isOpen() { return this.db !== null; }

  /**
   * Abre (y crea si hace falta) la base. Devuelve `{ ok, error_code }` y nunca
   * lanza: la sombra es best-effort y un fallo suyo no puede impedir que el
   * Bridge siga recibiendo marcaciones por el camino de siempre.
   *
   * Con la flag apagada ni siquiera se resuelve `better-sqlite3`: una
   * instalación sin el driver nativo funciona igual mientras la sombra esté
   * apagada.
   */
  open() {
    if (this.db) return { ok: true };
    if (!this.config.enabled) return { ok: false, error_code: SHADOW_ERRORS.DISABLED };
    if (!this.config.dbPath) return { ok: false, error_code: SHADOW_ERRORS.PATH_MISSING };

    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      return { ok: false, error_code: SHADOW_ERRORS.OPEN_FAILED, detail: 'better-sqlite3 no instalado' };
    }

    try {
      fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
      const db = new Database(this.config.dbPath);
      db.pragma('journal_mode = WAL');
      // FULL, igual que el Outbox: lo que se quiere observar incluye
      // justamente lo que pasa alrededor de un corte de energía.
      db.pragma('synchronous = FULL');
      db.pragma(`busy_timeout = ${DEFAULTS.BUSY_TIMEOUT_MS}`);
      db.exec(SCHEMA);
      this.db = db;
      return { ok: true };
    } catch (err) {
      this.db = null;
      return { ok: false, error_code: SHADOW_ERRORS.OPEN_FAILED, detail: codigoDeError(err) };
    }
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch { /* ya cerrada */ }
    this.db = null;
  }

  /**
   * Guarda una observación. Idempotente dentro de un mismo `source`:
   * reobservar el mismo marcaje no duplica la fila ni pisa la original.
   *
   * Devuelve `{ ok, inserted, duplicate }`. `inserted:false` con `ok:true`
   * significa duplicado, que es un resultado normal y no un error.
   */
  record(evento, { source = 'push', deviceKey, now = new Date() } = {}) {
    if (!this.db) return { ok: false, error_code: SHADOW_ERRORS.NOT_OPEN };
    if (!SHADOW_SOURCES.includes(source)) {
      return { ok: false, error_code: SHADOW_ERRORS.SOURCE_INVALID };
    }
    if (!deviceKey || typeof deviceKey !== 'string') {
      return { ok: false, error_code: SHADOW_ERRORS.DEVICE_KEY_MISSING };
    }

    // El contrato valida ANTES de tocar el disco. Una observación que no pasa
    // el contrato no se puede comparar con nada después: guardarla sólo
    // ensuciaría el período que se quiere medir.
    const check = validateEvent(evento, { checkEventIds: true });
    if (!check.ok) {
      return { ok: false, error_code: SHADOW_ERRORS.CONTRACT_INVALID, detail: check.error_code };
    }

    try {
      const fila = this.db.prepare(`
        INSERT INTO shadow_events
          (event_id, device_key, device_id, source, payload, occurred_at, observed_at)
        VALUES
          (@event_id, @device_key, @device_id, @source, @payload, @occurred_at, @observed_at)
        ON CONFLICT(source, event_id) DO NOTHING
      `).run({
        event_id:    evento.event_id,
        device_key:  deviceKey,
        device_id:   evento.device_id,
        source,
        payload:     JSON.stringify(sanitizeShadowPayload(evento)),
        occurred_at: evento.occurred_at,
        observed_at: now.toISOString(),
      });
      return { ok: true, inserted: fila.changes === 1, duplicate: fila.changes === 0 };
    } catch (err) {
      return { ok: false, error_code: SHADOW_ERRORS.WRITE_FAILED, detail: codigoDeError(err) };
    }
  }

  /**
   * Métricas agregadas de lo YA ALMACENADO — sobrevive al reinicio del
   * proceso, a diferencia de los contadores en memoria de `shadow.js`.
   *
   * Sólo conteos y marcas de tiempo: ningún dato de persona sale de acá.
   */
  stats() {
    if (!this.db) return { ok: false, error_code: SHADOW_ERRORS.NOT_OPEN };
    const total = this.db.prepare(`
      SELECT COUNT(*) AS stored,
             MIN(occurred_at) AS first_event_at,
             MAX(occurred_at) AS last_event_at
        FROM shadow_events
    `).get();
    const porOrigen = this.db.prepare(`
      SELECT source, COUNT(*) AS stored FROM shadow_events GROUP BY source
    `).all();
    const porReloj = this.db.prepare(`
      SELECT device_key, COUNT(*) AS stored FROM shadow_events GROUP BY device_key
    `).all();

    return {
      ok: true,
      stored: total.stored,
      first_event_at: total.first_event_at,
      last_event_at: total.last_event_at,
      by_source: Object.fromEntries(porOrigen.map(r => [r.source, r.stored])),
      by_device: Object.fromEntries(porReloj.map(r => [r.device_key, r.stored])),
    };
  }

  /**
   * Comparación PUSH ↔ polling en una ventana, SIN conectar nada.
   *
   * Hoy la mitad `polling` está siempre vacía porque nadie escribe con ese
   * origen todavía: el worker no está enganchado y este PR no lo engancha. La
   * consulta ya está escrita para el día que lo esté, y mientras tanto sirve
   * para leer lo que PUSH observó.
   *
   * `event_id` es identidad pura, así que el JOIN por event_id empareja el
   * mismo marcaje visto por los dos caminos, y `verify_mode`/`work_code`
   * —que NO entran en el identificador— son justamente los que pueden diferir.
   */
  compare({ from = null, to = null, deviceKey = null } = {}) {
    if (!this.db) return { ok: false, error_code: SHADOW_ERRORS.NOT_OPEN };

    const filtros = [];
    const params = {};
    if (from)      { filtros.push('occurred_at >= @from'); params.from = from; }
    if (to)        { filtros.push('occurred_at <= @to');   params.to = to; }
    if (deviceKey) { filtros.push('device_key = @deviceKey'); params.deviceKey = deviceKey; }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

    const ventana = `SELECT event_id, source, payload FROM shadow_events ${where}`;
    const filas = this.db.prepare(ventana).all(params);

    const push = new Map();
    const polling = new Map();
    for (const f of filas) {
      let p;
      try { p = JSON.parse(f.payload); } catch { p = {}; }
      (f.source === 'push' ? push : polling).set(f.event_id, p);
    }

    const comunes = [];
    const soloPush = [];
    const difVerify = [];
    const difWork = [];

    for (const [id, p] of push) {
      if (!polling.has(id)) { soloPush.push(id); continue; }
      comunes.push(id);
      const q = polling.get(id);
      if ((p.verify_mode ?? null) !== (q.verify_mode ?? null)) difVerify.push(id);
      if ((p.work_code ?? null) !== (q.work_code ?? null)) difWork.push(id);
    }
    const soloPolling = [...polling.keys()].filter(id => !push.has(id));

    return {
      ok: true,
      window: { from, to, device_key: deviceKey },
      // `polling` en cero no significa "coinciden": significa que todavía no
      // hay nadie escribiendo ese origen. Se dice explícito para que un
      // informe vacío no se lea como un resultado.
      polling_connected: polling.size > 0,
      totals: {
        push: push.size,
        polling: polling.size,
        common: comunes.length,
        only_push: soloPush.length,
        only_polling: soloPolling.length,
        verify_mode_differs: difVerify.length,
        work_code_differs: difWork.length,
      },
    };
  }

  /**
   * Vaciado administrativo explícito. No hay limpieza automática y este método
   * es el único camino para borrar: el llamador debe estar autenticado.
   */
  purge({ before = null } = {}) {
    if (!this.db) return { ok: false, error_code: SHADOW_ERRORS.NOT_OPEN };

    // Se valida ACÁ y no sólo en la ruta HTTP: es el borrado, y quien lo llame
    // —una ruta, un script, un test— no puede acabar vaciando la tabla entera
    // por una fecha mal formada.
    const corte = normalizeBefore(before);
    if (!corte.ok) return { ok: false, error_code: SHADOW_ERRORS.BEFORE_INVALID };

    const r = corte.value
      ? this.db.prepare('DELETE FROM shadow_events WHERE occurred_at < @before').run({ before: corte.value })
      : this.db.prepare('DELETE FROM shadow_events').run();
    return { ok: true, deleted: r.changes };
  }
}

function codigoDeError(err) {
  return err?.code || err?.name || 'error';
}

function createShadowStore(env = process.env) {
  return new ShadowStore(readStoreConfig(env));
}

module.exports = {
  createShadowStore,
  ShadowStore,
  readStoreConfig,
  sanitizeShadowPayload,
  deviceIdFromKey,
  normalizeBefore,
  SHADOW_SOURCES,
  SHADOW_ERRORS,
  CAMPOS_PERSISTIDOS,
};
