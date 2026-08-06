/**
 * outbox.js — cola local durable de marcaciones del Bridge.
 *
 * ── Estado: DESCONECTADO ─────────────────────────────────────────────
 *
 * Este módulo NO está enganchado a nada. No lo llama el PUSH, ni el polling,
 * ni la API, ni Redis, ni MySQL. Con `BRIDGE_OUTBOX_ENABLED` distinto de
 * `true` no crea el archivo, no abre SQLite y no intercepta ninguna marcación.
 * Hoy sólo lo ejercitan los tests.
 *
 * Existe para que, más adelante, una marcación pueda guardarse ANTES de
 * transmitirse y borrarse SÓLO después del ACK del servidor. Hoy, si el core
 * está caído cuando el reloj emite, la marcación se pierde.
 *
 * ── Por qué SQLite y no un archivo ───────────────────────────────────
 *
 * Lo que hace falta es durabilidad ante corte de energía y exclusión entre
 * consumidores. Un JSON en disco no da ninguna de las dos: un crash a mitad
 * de escritura deja el archivo corrupto, y dos procesos que lo lean a la vez
 * transmiten la misma marcación dos veces.
 *
 * ── Máquina de estados ───────────────────────────────────────────────
 *
 *   pending ──claimBatch──> sending ──acknowledge──> acknowledged
 *      ^                       │
 *      └──releaseForRetry──────┤
 *                              └──moveToDeadLetter──> dead_letter
 *
 * `recoverStaleClaims` devuelve a `pending` las filas que quedaron en
 * `sending` porque el proceso murió con el lote en vuelo.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateEvent } = require('../../contracts/punchContractV1');

const STATUS = Object.freeze({
  PENDING:      'pending',
  SENDING:      'sending',
  ACKNOWLEDGED: 'acknowledged',
  DEAD_LETTER:  'dead_letter',
});

const OUTBOX_ERRORS = Object.freeze({
  DISABLED:          'outbox_disabled',
  PATH_MISSING:      'outbox_path_missing',
  OPEN_FAILED:       'outbox_open_failed',
  CONTRACT_INVALID:  'outbox_contract_invalid',
  NOT_OPEN:          'outbox_not_open',
  UNKNOWN_EVENT:     'outbox_unknown_event',
  BUSY:              'outbox_busy',
});

const DEFAULTS = Object.freeze({
  CLAIM_TTL_MS: 5 * 60 * 1000,   // un lote en vuelo más de 5 min se da por muerto
  MAX_ATTEMPTS: 10,
  BUSY_TIMEOUT_MS: 5000,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         TEXT    NOT NULL UNIQUE,
  device_id        INTEGER NOT NULL,
  payload          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT    NULL,
  created_at       TEXT    NOT NULL,
  acknowledged_at  TEXT    NULL,
  last_error_code  TEXT    NULL,
  claimed_at       TEXT    NULL,
  -- Identifica UN reclamo concreto. Sin esto, si recoverStaleClaims devuelve
  -- una fila a pending y otro consumidor la reclama, el ACK o el retry del
  -- consumidor viejo caen sobre el reclamo NUEVO. Serializar la transacción no
  -- arregla esa carrera: es semántica, no de concurrencia de escritura.
  claim_token      TEXT    NULL,
  CHECK (status IN ('pending','sending','acknowledged','dead_letter'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_claim   ON outbox_events (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox_events (created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_device  ON outbox_events (device_id);
CREATE INDEX IF NOT EXISTS idx_outbox_stale   ON outbox_events (status, claimed_at);
`;

// ── Configuración ────────────────────────────────────────────────────

function readConfig(env = process.env) {
  return {
    enabled: env.BRIDGE_OUTBOX_ENABLED === 'true',
    dbPath: (env.BRIDGE_OUTBOX_PATH || '').trim(),
    claimTtlMs: entero(env.BRIDGE_OUTBOX_CLAIM_TTL_MS, DEFAULTS.CLAIM_TTL_MS),
    maxAttempts: entero(env.BRIDGE_OUTBOX_MAX_ATTEMPTS, DEFAULTS.MAX_ATTEMPTS),
  };
}

function entero(valor, porDefecto) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return porDefecto;
  const n = Number(String(valor).trim());
  return Number.isInteger(n) && n > 0 ? n : porDefecto;
}

// ── Saneado del payload ──────────────────────────────────────────────

/**
 * Construye el payload desde una LISTA CERRADA de campos.
 *
 * El Outbox es un archivo sin cifrar en el disco del Bridge, que vive en la
 * misma LAN que los relojes. Guardar selfies, plantillas biométricas o
 * credenciales ahí sería crear un objetivo nuevo. La IP tampoco: no aporta a
 * la identidad de la marcación y es topología de red.
 *
 * Antes esto era una lista de PROHIBIDOS, y era insuficiente por construcción:
 * `validateEvent` ignora las propiedades desconocidas, así que un evento
 * perfectamente válido con `auth_token` —o con `metadata: { token }`, anidado y
 * por lo tanto invisible para una comprobación de primer nivel— pasaba entero
 * al disco. Una lista negra sólo detiene lo que alguien pensó en nombrar.
 *
 * La lista blanca es exactamente el contrato v1: si el contrato crece, esto se
 * actualiza a propósito, y mientras tanto nada nuevo entra por descuido.
 */
const CAMPOS_PERMITIDOS = Object.freeze([
  'event_id',
  'device_id',
  'device_user_id',
  'occurred_at',
  'event_type',
  'verify_mode',
  'work_code',
]);

function sanitizePayload(evento) {
  const limpio = {};
  for (const k of CAMPOS_PERMITIDOS) {
    if (evento[k] !== undefined) limpio[k] = evento[k];
  }
  return limpio;
}

// ── Outbox ───────────────────────────────────────────────────────────

class Outbox {
  constructor(config) {
    this.config = config;
    this.db = null;
  }

  get isOpen() { return this.db !== null; }

  /**
   * Abre (y crea si hace falta) la base. Devuelve `{ ok, error_code }`.
   *
   * Nunca lanza: un Bridge que no puede abrir su Outbox tiene que seguir
   * recibiendo marcaciones por el camino actual, no caerse.
   */
  open() {
    if (this.db) return { ok: true };
    if (!this.config.enabled) return { ok: false, error_code: OUTBOX_ERRORS.DISABLED };
    if (!this.config.dbPath) return { ok: false, error_code: OUTBOX_ERRORS.PATH_MISSING };

    let Database;
    try {
      // Carga perezosa a propósito: con la flag apagada el driver nativo ni
      // siquiera se resuelve, así que una instalación sin él funciona igual.
      Database = require('better-sqlite3');
    } catch (err) {
      return { ok: false, error_code: OUTBOX_ERRORS.OPEN_FAILED, detail: 'better-sqlite3 no instalado' };
    }

    try {
      fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
      const db = new Database(this.config.dbPath);

      // WAL: un lector no bloquea al escritor, y sobrevive a un corte sin
      // dejar la base a medias.
      db.pragma('journal_mode = WAL');
      // FULL y no NORMAL: NORMAL puede perder las últimas transacciones ante
      // un corte de energía, que es justamente el caso que el Outbox existe
      // para cubrir.
      db.pragma('synchronous = FULL');
      db.pragma(`busy_timeout = ${DEFAULTS.BUSY_TIMEOUT_MS}`);
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA);

      this.db = db;
      return { ok: true };
    } catch (err) {
      this.db = null;
      return { ok: false, error_code: OUTBOX_ERRORS.OPEN_FAILED, detail: codigoDeError(err) };
    }
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch { /* ya cerrada */ }
    this.db = null;
  }

  /**
   * Encola una marcación. Idempotente por `event_id`: reencolar lo mismo no
   * duplica ni pisa el estado de la fila existente.
   */
  enqueue(evento, { now = new Date() } = {}) {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };

    // El contrato v1 valida ANTES de tocar el disco: una marcación que no
    // pasa el contrato no se puede transmitir después, así que guardarla sólo
    // llenaría la cola de basura imposible de drenar.
    const check = validateEvent(evento, { checkEventIds: true });
    if (!check.ok) {
      return { ok: false, error_code: OUTBOX_ERRORS.CONTRACT_INVALID, detail: check.error_code };
    }

    const limpio = sanitizePayload(evento);
    const fila = this.db.prepare(`
      INSERT INTO outbox_events (event_id, device_id, payload, status, attempts, created_at)
      VALUES (@event_id, @device_id, @payload, '${STATUS.PENDING}', 0, @created_at)
      ON CONFLICT(event_id) DO NOTHING
    `).run({
      event_id: evento.event_id,
      device_id: evento.device_id,
      payload: JSON.stringify(limpio),
      created_at: now.toISOString(),
    });

    return { ok: true, inserted: fila.changes === 1, event_id: evento.event_id };
  }

  /**
   * Reclama hasta `limit` filas transmitibles y las marca `sending`.
   *
   * El UPDATE y el SELECT van en UNA transacción: si dos consumidores
   * corren a la vez, el segundo no puede ver como `pending` lo que el
   * primero ya reclamó. Sin eso, la misma marcación se transmite dos veces.
   */
  claimBatch({ limit = 50, now = new Date() } = {}) {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };
    const ahora = now.toISOString();
    const token = crypto.randomUUID();

    const tx = this.db.transaction(() => {
      const candidatas = this.db.prepare(`
        SELECT id FROM outbox_events
         WHERE status = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id
         LIMIT ?
      `).all(STATUS.PENDING, ahora, limit);

      if (!candidatas.length) return [];

      const ids = candidatas.map(c => c.id);
      const marcas = ids.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE outbox_events
           SET status = ?, claimed_at = ?, claim_token = ?
         WHERE id IN (${marcas})
      `).run(STATUS.SENDING, ahora, token, ...ids);

      return this.db.prepare(
        `SELECT id, event_id, device_id, payload, attempts FROM outbox_events WHERE id IN (${marcas}) ORDER BY id`
      ).all(...ids);
    });

    // IMMEDIATE, no la transacción por defecto.
    //
    // `db.transaction()` es DEFERRED: toma el lock de lectura en el primer
    // SELECT y recién lo sube a escritura en el UPDATE. Dos procesos pueden
    // entonces leer las MISMAS filas como `pending` y uno recibe SQLITE_BUSY
    // al escribir — o peor, ambos creen haberlas reclamado. IMMEDIATE toma el
    // lock de escritura de entrada, así que el segundo espera (busy_timeout)
    // y vuelve a leer el estado ya actualizado.
    //
    // Esto NO se puede probar dentro de un proceso: better-sqlite3 es síncrono
    // y nada puede interleavearse. El test que lo cubre levanta procesos hijos
    // de verdad.
    // SQLITE_BUSY se traduce a resultado, no se propaga: el contrato del
    // módulo es que ninguna operación lanza. Si esto escapara, una vez
    // conectado el Outbox tumbaría el ciclo del consumidor en vez de dejarlo
    // reintentar.
    let filas;
    try {
      filas = tx.immediate();
    } catch (err) {
      return { ok: false, error_code: OUTBOX_ERRORS.BUSY, detail: codigoDeError(err) };
    }

    return {
      ok: true,
      claim_token: token,
      events: filas.map(f => ({
        id: f.id,
        event_id: f.event_id,
        device_id: f.device_id,
        attempts: f.attempts,
        payload: JSON.parse(f.payload),
      })),
    };
  }

  /**
   * Confirma la entrega. Sólo acá se considera transmitida una marcación.
   *
   * Idempotente: un ACK repetido —el servidor reintenta, el consumidor
   * duplica el aviso— no cambia nada ni falla.
   */
  acknowledge(eventIds, { now = new Date(), claimToken = null } = {}) {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };
    const lista = Array.isArray(eventIds) ? eventIds : [eventIds];
    if (!lista.length) return { ok: true, acknowledged: 0 };

    // Con `claimToken` sólo se confirma el reclamo propio. Sin él se confirma
    // igual —un ACK es idempotente y confirmar de más no pierde datos— pero
    // el consumidor real debería pasarlo siempre.
    const condicion = claimToken ? 'AND claim_token = ?' : '';
    const stmt = this.db.prepare(`
      UPDATE outbox_events
         SET status = ?, acknowledged_at = ?, claimed_at = NULL, claim_token = NULL, last_error_code = NULL
       WHERE event_id = ? AND status <> ? ${condicion}
    `);
    const tx = this.db.transaction(() => {
      let n = 0;
      for (const id of lista) {
        const args = [STATUS.ACKNOWLEDGED, now.toISOString(), id, STATUS.ACKNOWLEDGED];
        if (claimToken) args.push(claimToken);
        n += stmt.run(...args).changes;
      }
      return n;
    });

    try { return { ok: true, acknowledged: tx.immediate() }; }
    catch (err) { return { ok: false, error_code: OUTBOX_ERRORS.BUSY, detail: codigoDeError(err) }; }
  }

  /** Devuelve a `pending` con backoff. Al superar maxAttempts va a dead_letter. */
  releaseForRetry(eventIds, { errorCode = null, backoffMs = 30000, now = new Date(), claimToken = null } = {}) {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };
    const lista = Array.isArray(eventIds) ? eventIds : [eventIds];
    if (!lista.length) return { ok: true, released: 0, dead_lettered: 0 };

    const proximo = new Date(now.getTime() + backoffMs).toISOString();
    // Se exige el token del reclamo: si recoverStaleClaims devolvió la fila a
    // pending y otro consumidor la reclamó, el consumidor viejo NO debe tocar
    // el reclamo nuevo — devolverlo a pending o sumarle un intento hacia
    // dead_letter sería castigar a un lote que está en vuelo y sano.
    const leer = claimToken
      ? this.db.prepare('SELECT id, attempts FROM outbox_events WHERE event_id = ? AND status = ? AND claim_token = ?')
      : this.db.prepare('SELECT id, attempts FROM outbox_events WHERE event_id = ? AND status = ?');
    const reintentar = this.db.prepare(`
      UPDATE outbox_events
         SET status = ?, attempts = attempts + 1, next_attempt_at = ?,
             claimed_at = NULL, claim_token = NULL, last_error_code = ?
       WHERE event_id = ?
    `);
    const aMuertas = this.db.prepare(`
      UPDATE outbox_events
         SET status = ?, attempts = attempts + 1, claimed_at = NULL, claim_token = NULL,
             next_attempt_at = NULL, last_error_code = ?
       WHERE event_id = ?
    `);

    const tx = this.db.transaction(() => {
      let released = 0, dead = 0;
      for (const id of lista) {
        const fila = claimToken ? leer.get(id, STATUS.SENDING, claimToken) : leer.get(id, STATUS.SENDING);
        if (!fila) continue;                       // no estaba en vuelo
        if (fila.attempts + 1 >= this.config.maxAttempts) {
          aMuertas.run(STATUS.DEAD_LETTER, errorCode, id);
          dead++;
        } else {
          reintentar.run(STATUS.PENDING, proximo, errorCode, id);
          released++;
        }
      }
      return { released, dead };
    });

    let r;
    try { r = tx.immediate(); }
    catch (err) { return { ok: false, error_code: OUTBOX_ERRORS.BUSY, detail: codigoDeError(err) }; }
    return { ok: true, released: r.released, dead_lettered: r.dead };
  }

  /** Descarta explícitamente, sin esperar a agotar los intentos. */
  moveToDeadLetter(eventIds, { errorCode = null } = {}) {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };
    const lista = Array.isArray(eventIds) ? eventIds : [eventIds];
    const stmt = this.db.prepare(`
      UPDATE outbox_events SET status = ?, claimed_at = NULL, claim_token = NULL, next_attempt_at = NULL, last_error_code = ?
       WHERE event_id = ? AND status <> ?
    `);
    const tx = this.db.transaction(() => {
      let n = 0;
      for (const id of lista) n += stmt.run(STATUS.DEAD_LETTER, errorCode, id, STATUS.ACKNOWLEDGED).changes;
      return n;
    });
    return { ok: true, dead_lettered: tx() };
  }

  /**
   * Rescata filas que quedaron en `sending` porque el proceso murió con el
   * lote en vuelo. Sin esto, un crash deja marcaciones atascadas para siempre.
   */
  recoverStaleClaims({ now = new Date() } = {}) {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };
    const limite = new Date(now.getTime() - this.config.claimTtlMs).toISOString();

    const r = this.db.prepare(`
      UPDATE outbox_events
         SET status = ?, claimed_at = NULL, claim_token = NULL
       WHERE status = ? AND (claimed_at IS NULL OR claimed_at <= ?)
    `).run(STATUS.PENDING, STATUS.SENDING, limite);

    return { ok: true, recovered: r.changes };
  }

  /** Conteos por estado, para health y diagnóstico. Sin datos personales. */
  stats() {
    if (!this.db) return { ok: false, error_code: OUTBOX_ERRORS.NOT_OPEN };
    const filas = this.db.prepare('SELECT status, COUNT(*) AS n FROM outbox_events GROUP BY status').all();
    const porEstado = Object.fromEntries(Object.values(STATUS).map(s => [s, 0]));
    for (const f of filas) porEstado[f.status] = f.n;

    const masVieja = this.db.prepare(
      `SELECT MIN(created_at) AS t FROM outbox_events WHERE status IN (?, ?)`
    ).get(STATUS.PENDING, STATUS.SENDING);

    return {
      ok: true,
      by_status: porEstado,
      total: Object.values(porEstado).reduce((a, b) => a + b, 0),
      oldest_unsent_at: masVieja?.t || null,
    };
  }
}

function codigoDeError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'unknown';
}

/**
 * Punto de entrada. Con la flag apagada devuelve un Outbox cerrado que no
 * tocó el disco: `isOpen` es false y toda operación responde `outbox_not_open`.
 */
function createOutbox(env = process.env) {
  return new Outbox(readConfig(env));
}

module.exports = {
  createOutbox,
  Outbox,
  readConfig,
  sanitizePayload,
  STATUS,
  OUTBOX_ERRORS,
  DEFAULTS,
  CAMPOS_PERMITIDOS,
};
