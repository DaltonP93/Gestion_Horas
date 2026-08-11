/**
 * shadow.js — captura en modo SOMBRA de las marcaciones que ya llegan por PUSH.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────
 *
 * Toma una COPIA de un marcaje que el camino actual ya está procesando, lo
 * normaliza con el contrato v1, le calcula el `event_id` determinista y lo
 * guarda en el almacén sombra. Después no hace nada más: el marcaje sigue por
 * donde iba, sin enterarse.
 *
 * Sombra NO significa productor autoritativo nuevo. No hay INSERT en
 * `attendance`, ni UPDATE de `daily_summary`, ni XADD a Redis, ni POST a la
 * API, ni ACK al reloj, ni apagado del polling, ni borrado de logs del reloj.
 *
 * ── Best-effort, de verdad ───────────────────────────────────────────
 *
 * Todo lo de acá es secundario respecto de recibir la marcación. `capture()`
 * NO lanza nunca —ni con el almacén roto, ni con SQLite ausente, ni con un
 * evento imposible— porque un fallo de la observación que impidiera procesar
 * el PUSH convertiría una herramienta de diagnóstico en una causa de pérdida
 * de marcaciones.
 *
 * ── Allowlist: vacía = nadie ─────────────────────────────────────────
 *
 * Ojo con la asimetría respecto de `ZKTECO_PUSH_WHITELIST`, donde vacío
 * significa "todos permitidos". Acá vacío significa NADIE. Son semánticas
 * opuestas a propósito: la whitelist filtra quién puede marcar —abrirla de
 * más deja pasar relojes—, y la allowlist de sombra decide sobre quién se
 * empieza a acumular una copia de datos. El valor por defecto de una copia
 * nueva tiene que ser "de nadie", y encenderla se hace nombrando el reloj.
 *
 * ── Identidad del reloj ──────────────────────────────────────────────
 *
 * La correlación usa la identidad ESTABLE que el reloj reporta (su serial),
 * nunca la posición dentro de `ZKTECO_DEVICES`. `resolveDevices` asigna
 * `id = índice + 1`, así que agregar un reloj al principio de la variable
 * renumera todos los que siguen: filas ya escritas pasarían a "pertenecer" a
 * otro reloj y la comparación PUSH↔polling compararía cosas distintas. El
 * `id` posicional no entra en este módulo en ningún momento.
 */

'use strict';

const { buildEvent, validateEvent } = require('../../contracts/punchContractV1');
const {
  parseAllowlist,
  canonicalSerial,
  stableDeviceKey,
  findConfiguredDevice,
  isDeviceAllowed,
} = require('./deviceIdentity');
const {
  createShadowStore,
  deviceIdFromKey,
  SHADOW_ERRORS,
} = require('./shadowStore');

const SHADOW_SKIP = Object.freeze({
  DISABLED:        'shadow_disabled',
  PUSH_NOT_CAPTURED: 'shadow_push_not_captured',
  DEVICE_UNKNOWN:  'shadow_device_unknown',
  DEVICE_NOT_ALLOWED: 'shadow_device_not_allowed',
});

// ── Configuración ────────────────────────────────────────────────────

function readShadowConfig(env = process.env) {
  return {
    enabled: env.BRIDGE_SHADOW_ENABLED === 'true',
    capturePush: env.BRIDGE_SHADOW_CAPTURE_PUSH !== 'false',   // por defecto true
    allowlist: parseAllowlist(env.BRIDGE_SHADOW_DEVICE_ALLOWLIST),
  };
}

// ── Identidad estable ────────────────────────────────────────────────
//
// Las reglas viven en `deviceIdentity.js`, compartidas con el servidor PUSH.
// Estaban acá cuando la sombra era su único consumidor; el modo observe-only
// necesita responder la MISMA pregunta —"¿este marcaje viene del reloj que
// nombré?"— y dos copias que se separen producirían el peor resultado
// posible: un reloj observado por la sombra y publicado igual por el PUSH.
//
// Se reexportan al final para no romper a quien ya las importaba desde acá.

// ── Contadores ───────────────────────────────────────────────────────

/**
 * Métricas AGREGADAS del proceso en curso. Sólo conteos y marcas de tiempo:
 * ni nombres, ni códigos de empleado, ni IPs, ni payload.
 *
 * Se reinician con el proceso a propósito: lo que tiene que sobrevivir a un
 * reinicio son los eventos guardados, y ésos los cuenta `store.stats()`
 * leyendo el disco.
 */
function nuevasMetricas() {
  return {
    events_received: 0,
    events_valid: 0,
    duplicates: 0,
    invalid: 0,
    persisted: 0,
    errors: 0,
    skipped_not_allowed: 0,
    skipped_unknown_device: 0,
    first_event_at: null,
    last_event_at: null,
  };
}

// ── Sombra ───────────────────────────────────────────────────────────

class Shadow {
  constructor({ config, store, devices = [], logger = null }) {
    this.config = config;
    this.store = store;
    this.devices = devices;
    this.logger = logger;
    this.metrics = nuevasMetricas();
    this.opened = false;
    this.openError = null;
  }

  get enabled() { return this.config.enabled; }

  /**
   * Abre el almacén. Con la flag apagada no se toca el disco, no se carga
   * `better-sqlite3` y no se crea ningún archivo.
   */
  start() {
    if (!this.config.enabled) return { ok: false, error_code: SHADOW_SKIP.DISABLED };
    const r = this.store.open();
    this.opened = r.ok;
    this.openError = r.ok ? null : (r.error_code || SHADOW_ERRORS.OPEN_FAILED);
    if (!r.ok && this.logger) {
      // Código de error solamente: ni la ruta del archivo ni el detalle del
      // driver van a un log que se rota y se comparte.
      this.logger.warn(`🕶️  Modo sombra no pudo abrir su almacén: ${this.openError}`);
    }
    return r;
  }

  stop() {
    try { this.store.close(); } catch { /* nada que hacer */ }
    this.opened = false;
  }

  /**
   * Captura una observación. NUNCA lanza y nunca devuelve una promesa
   * rechazada: es la garantía de la que depende que el PUSH siga funcionando
   * pase lo que pase acá.
   *
   * `ip` se usa sólo para correlacionar con el reloj configurado; no se
   * guarda ni se registra en ningún lado.
   */
  capture(observacion = {}, { source = 'push', now = new Date() } = {}) {
    try {
      return this._capture(observacion, { source, now });
    } catch (err) {
      this.metrics.errors++;
      if (this.logger) this.logger.warn(`🕶️  Modo sombra: error capturando (${err?.code || err?.name || 'error'})`);
      return { ok: false, error_code: SHADOW_ERRORS.WRITE_FAILED };
    }
  }

  _capture(observacion, { source, now }) {
    // Flag apagada: no-op real. Ni contadores, ni resolución de reloj, ni
    // disco. No hay forma de distinguir esto de que el módulo no existiera.
    if (!this.config.enabled) {
      return { ok: false, error_code: SHADOW_SKIP.DISABLED, skipped: true };
    }
    if (source === 'push' && !this.config.capturePush) {
      return { ok: false, error_code: SHADOW_SKIP.PUSH_NOT_CAPTURED, skipped: true };
    }

    this.metrics.events_received++;

    const device = findConfiguredDevice(observacion, this.devices);

    if (!isDeviceAllowed({ ...observacion, device }, this.config.allowlist)) {
      this.metrics.skipped_not_allowed++;
      return { ok: false, error_code: SHADOW_SKIP.DEVICE_NOT_ALLOWED, skipped: true };
    }

    const deviceKey = stableDeviceKey({ sn: observacion.sn, device });
    if (!deviceKey) {
      this.metrics.skipped_unknown_device++;
      return { ok: false, error_code: SHADOW_SKIP.DEVICE_UNKNOWN, skipped: true };
    }

    // La hora se pasa TAL CUAL la mandó el reloj (hora de pared, sin offset).
    // Convertirla antes con `new Date(...)` la anclaría a la zona del proceso,
    // que es justo la dependencia que el contrato v1 existe para eliminar.
    const construido = buildEvent({
      device_id:      deviceIdFromKey(deviceKey),
      device_user_id: observacion.deviceUserId,
      occurred_at:    observacion.occurredAtRaw,
      event_type:     observacion.eventType,
      verify_mode:    observacion.verifyMode,
      work_code:      observacion.workCode,
    });

    if (!construido.ok) {
      this.metrics.invalid++;
      return { ok: false, error_code: construido.error_code, invalid: true };
    }

    // `buildEvent` normaliza pero NO comprueba la ventana temporal: el rechazo
    // por marcaje futuro o demasiado viejo vive en `validateEvent`. Sin esta
    // segunda pasada, un reloj con la hora corrida producía eventos que el
    // almacén rechazaba después, y el fallo se contaba como `errors` —avería
    // de la sombra— cuando en realidad es `invalid` —el evento no pasa el
    // contrato—. Son dos diagnósticos distintos y la métrica tiene que
    // distinguirlos para que sirva de algo.
    const valido = validateEvent(construido.event, { checkEventIds: true });
    if (!valido.ok) {
      this.metrics.invalid++;
      return { ok: false, error_code: valido.error_code, invalid: true };
    }

    this.metrics.events_valid++;
    this._marcarVentana(construido.event.occurred_at);

    if (!this.opened) {
      this.metrics.errors++;
      return { ok: false, error_code: this.openError || SHADOW_ERRORS.NOT_OPEN };
    }

    const guardado = this.store.record(construido.event, { source, deviceKey, now });
    if (!guardado.ok) {
      this.metrics.errors++;
      return guardado;
    }
    if (guardado.inserted) this.metrics.persisted++;
    else this.metrics.duplicates++;

    return { ok: true, inserted: guardado.inserted, duplicate: !guardado.inserted, event_id: construido.event.event_id };
  }

  _marcarVentana(occurredAt) {
    const m = this.metrics;
    if (!m.first_event_at || occurredAt < m.first_event_at) m.first_event_at = occurredAt;
    if (!m.last_event_at  || occurredAt > m.last_event_at)  m.last_event_at = occurredAt;
  }

  /** Estado agregado: contadores del proceso + lo que sobrevive en disco. */
  status() {
    const almacenado = this.opened ? this.store.stats() : { ok: false, error_code: this.openError || SHADOW_ERRORS.NOT_OPEN };
    return {
      enabled: this.config.enabled,
      capture_push: this.config.capturePush,
      allowlist_size: this.config.allowlist.length,
      store_open: this.opened,
      store_error: this.openError,
      runtime: { ...this.metrics },
      stored: almacenado.ok ? almacenado : null,
    };
  }
}

/**
 * Sombra apagada por defecto. `devices` viene de `resolveDevices` y se usa
 * SÓLO para traducir nombre/IP a la identidad estable del reloj.
 */
function createShadow({ env = process.env, devices = [], logger = null, store = null } = {}) {
  return new Shadow({
    config: readShadowConfig(env),
    store: store || createShadowStore(env),
    devices,
    logger,
  });
}

module.exports = {
  createShadow,
  Shadow,
  readShadowConfig,
  parseAllowlist,
  canonicalSerial,
  stableDeviceKey,
  findConfiguredDevice,
  isDeviceAllowed,
  SHADOW_SKIP,
};
