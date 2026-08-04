/**
 * punchContractV1.js
 * Contrato canónico e idempotente de marcaciones — versión 1.
 *
 * NO está conectado a nada. Define la forma y las reglas para que Bridge, API
 * de ingesta, Outbox, Redis Stream y Sync Worker puedan hablar el mismo idioma
 * más adelante. Ninguna ruta se registra, no se escribe en Redis ni en MySQL,
 * y el pipeline actual (PUSH y polling) sigue exactamente igual.
 *
 * ── Por qué hace falta ────────────────────────────────────────────
 * Hoy conviven tres formas distintas de la misma marcación:
 *
 *   PUSH ADMS   línea ATTLOG: userId \t datetime \t status \t verify \t workCode
 *   Polling     objeto de node-zklib: { userId, timestamp, state, ... }
 *   att2000     fila CHECKINOUT: USERID, CHECKTIME, CHECKTYPE ('I'/'O')
 *
 * y cada camino arma su propio objeto antes de publicar. La deduplicación
 * depende de comparar (SN, userId, timestamp) en una ventana de 24 h, lo que
 * obliga a consultar estado para saber si algo ya se procesó.
 *
 * Con un `event_id` determinista, la idempotencia deja de depender del estado:
 * el mismo marcaje calcula el mismo identificador en cualquier proceso, en
 * cualquier momento y sin coordinación.
 *
 * ── Zona horaria ──────────────────────────────────────────────────
 * Los relojes ZKTeco emiten hora de pared SIN offset. Hoy el bridge hace
 * `new Date('2026-08-04 07:15:00'.replace(' ','T'))`, que interpreta ese texto
 * en la zona del PROCESO: el mismo marcaje da un instante distinto según dónde
 * corra el bridge. Acá el offset es obligatorio y explícito: una hora sin
 * offset se interpreta en America/Asuncion (UTC-03:00 fijo — Paraguay dejó de
 * aplicar horario de verano en 2024) y se normaliza a UTC.
 */

'use strict';

const crypto = require('crypto');

const PUNCH_CONTRACT_VERSION = 1;

/** Zona civil de referencia. Sin DST: offset fijo. */
const CIVIL_TIMEZONE = 'America/Asuncion';
const CIVIL_OFFSET_MINUTES = -180;

const EVENT_TYPES = Object.freeze(['in', 'out', 'break_start', 'break_end', 'unknown']);

const LIMITS = Object.freeze({
  MAX_EVENTS_PER_BATCH: 100,
  MAX_BATCH_BYTES: 256 * 1024,     // sin comprimir
  MAX_DEVICE_USER_ID: 64,
  MAX_WORK_CODE: 32,
  MAX_BRIDGE_ID: 64,
  MAX_BATCH_ID: 64,
  MAX_FUTURE_SKEW_MS: 5 * 60 * 1000,
  MAX_PAST_AGE_MS: 400 * 24 * 60 * 60 * 1000,   // ~13 meses
  MIN_VERIFY_MODE: 0,
  MAX_VERIFY_MODE: 255,
});

const REJECT_CODES = Object.freeze({
  UNSUPPORTED_VERSION: 'PUNCH_UNSUPPORTED_VERSION',
  BATCH_NOT_OBJECT:    'PUNCH_BATCH_NOT_OBJECT',
  BATCH_EMPTY:         'PUNCH_BATCH_EMPTY',
  BATCH_TOO_LARGE:     'PUNCH_BATCH_TOO_LARGE',
  BATCH_TOO_MANY:      'PUNCH_BATCH_TOO_MANY_EVENTS',
  BATCH_ID_INVALID:    'PUNCH_BATCH_ID_INVALID',
  BRIDGE_ID_INVALID:   'PUNCH_BRIDGE_ID_INVALID',
  DEVICE_ID_INVALID:   'PUNCH_DEVICE_ID_INVALID',
  GENERATED_AT_INVALID:'PUNCH_GENERATED_AT_INVALID',
  EVENT_NOT_OBJECT:    'PUNCH_EVENT_NOT_OBJECT',
  USER_ID_INVALID:     'PUNCH_USER_ID_INVALID',
  TIMESTAMP_INVALID:   'PUNCH_TIMESTAMP_INVALID',
  TIMESTAMP_FUTURE:    'PUNCH_TIMESTAMP_FUTURE',
  TIMESTAMP_TOO_OLD:   'PUNCH_TIMESTAMP_TOO_OLD',
  EVENT_TYPE_INVALID:  'PUNCH_EVENT_TYPE_INVALID',
  VERIFY_MODE_INVALID: 'PUNCH_VERIFY_MODE_INVALID',
  WORK_CODE_INVALID:   'PUNCH_WORK_CODE_INVALID',
  EVENT_ID_MISMATCH:   'PUNCH_EVENT_ID_MISMATCH',
  SEPARATOR_IN_VALUE:  'PUNCH_SEPARATOR_IN_VALUE',
});

// Separador de campos del string canónico. Es un carácter de control que no
// puede aparecer en un valor legítimo; si aparece, el evento se rechaza en vez
// de arriesgar una colisión de identificadores.
const FIELD_SEP = '';
const CANONICAL_PREFIX = 'sishoras.punch.v1';

// ── Normalización ────────────────────────────────────────────────

/**
 * Normaliza el identificador de usuario del reloj: NFC + trim, y nada más.
 *
 * Los ceros a la izquierda se CONSERVAN por defecto. La tentación es quitarlos
 * —"0042" y "42" parecen el mismo empleado— pero el sistema ya trata este
 * campo como string exacto: `employee_device_map.device_user_id` se compara
 * con el valor trimeado tal cual (`zktecoReader.js`), así que "0042" y "42"
 * son DOS asignaciones distintas. Unificarlos acá colapsaría los marcajes de
 * dos personas en un solo event_id, que es exactamente el fallo que este
 * contrato existe para evitar.
 *
 * Si un despliegue confirma que su reloj rellena con ceros el mismo id, puede
 * activarse con `stripLeadingZeros: true` — pero es una decisión por
 * instalación, no un default.
 */
function normalizeDeviceUserId(raw, { stripLeadingZeros = false } = {}) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).normalize('NFC').trim();
  if (!s) return null;
  if (stripLeadingZeros && /^\d+$/.test(s)) {
    const sinCeros = s.replace(/^0+/, '');
    return sinCeros === '' ? '0' : sinCeros;
  }
  return s;
}

/** Trim + NFC; vacío → null. */
function normalizeString(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).normalize('NFC').trim();
  return s === '' ? null : s;
}

function normalizeEventType(raw) {
  const s = normalizeString(raw);
  if (s === null) return 'unknown';
  const lower = s.toLowerCase();
  return EVENT_TYPES.includes(lower) ? lower : 'unknown';
}

/**
 * El modo de verificación puede venir en blanco: la línea ATTLOG trae la
 * columna con espacios de relleno. `Number('   ')` es 0, así que sin trimear
 * un dato AUSENTE se publicaba como el modo 0, que es un valor real.
 * También se exige decimal: Number aceptaría '0x10' y '1e2'.
 */
function normalizeVerifyMode(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return NaN;               // el validador lo rechaza
  return Number(s);
}

const ISO_CON_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_SIN_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * Lleva una marca de tiempo a instante UTC con precisión de SEGUNDO.
 *
 * Los milisegundos se descartan a propósito: los relojes reportan segundos, y
 * conservarlos haría que el mismo marcaje leído por dos caminos distintos
 * calculara identificadores distintos.
 *
 * @returns {string|null} ISO 8601 UTC ("2026-08-04T10:15:00Z") o null si no se pudo interpretar.
 */
function normalizeTimestamp(raw, { assumeOffsetMinutes = CIVIL_OFFSET_MINUTES, dateMeans = null } = {}) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    // Un Date NO dice de dónde viene. El polling hace `new Date(r.timestamp)`
    // sobre la hora de pared del reloj, así que el objeto ya quedó anclado a
    // la zona DEL PROCESO: hashearlo como instante conserva exactamente la
    // dependencia que este contrato existe para eliminar. Y no se puede
    // recuperar la intención mirando el objeto.
    //
    // Así que hay que declararla. Sin `dateMeans` el valor se rechaza.
    if (Number.isNaN(raw.getTime())) return null;
    if (dateMeans === 'utc_instant') return truncarASegundo(raw.getTime());
    if (dateMeans === 'civil_wall') {
      // Se reconstruye la hora de pared desde los componentes locales y se
      // reancla al offset civil.
      const utcMs = Date.UTC(
        raw.getFullYear(), raw.getMonth(), raw.getDate(),
        raw.getHours(), raw.getMinutes(), raw.getSeconds()
      );
      return truncarASegundo(utcMs - assumeOffsetMinutes * 60 * 1000);
    }
    return null;
  }
  const s = String(raw).trim();
  if (!s) return null;

  const conOffset = ISO_CON_OFFSET.exec(s);
  if (conOffset) {
    // Date.parse "arregla" fechas imposibles: 2026-02-31 se convierte en
    // 2026-03-03 sin avisar, y el marcaje cambiaría de día antes de hashearse.
    const [, y, mo, d, h, mi, sec] = conOffset;
    if (!fechaCivilValida(+y, +mo, +d, +h, +mi, sec ? +sec : 0)) return null;
    const ms = Date.parse(normalizarTextoIso(s));
    return Number.isNaN(ms) ? null : truncarASegundo(ms);
  }

  const sinOffset = ISO_SIN_OFFSET.exec(s);
  if (sinOffset) {
    // Hora de pared del reloj: se ancla a la zona civil, nunca a la del proceso.
    const [, y, mo, d, h, mi, sec] = sinOffset;
    const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0);
    if (Number.isNaN(utcMs)) return null;
    if (!fechaCivilValida(+y, +mo, +d, +h, +mi, sec ? +sec : 0)) return null;
    return truncarASegundo(utcMs - assumeOffsetMinutes * 60 * 1000);
  }
  return null;
}

function normalizarTextoIso(s) {
  // "2026-08-04 10:15:00-03:00" → "2026-08-04T10:15:00-03:00"; "-0300" → "-03:00"
  return s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

function fechaCivilValida(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (h > 23 || mi > 59 || s > 59) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function truncarASegundo(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

// ── event_id determinista ────────────────────────────────────────

function encodeField(v) {
  if (v === null || v === undefined) return 'n';
  if (typeof v === 'number') return `i:${v}`;
  return `s:${v}`;
}

/**
 * Campos ESTABLES que definen la identidad de un marcaje: qué reloj, qué
 * persona, cuándo y de qué tipo.
 *
 * Fuera quedan `verify_mode` y `work_code`, que son ATRIBUTOS del marcaje y no
 * su identidad. La razón es concreta, no estética: el PUSH parsea `verify` y
 * `workCode` de la línea ATTLOG, pero el polling no los publica. Con esos
 * campos dentro del hash, el mismo marcaje leído por PUSH y por polling daba
 * DOS identificadores distintos — y el sistema los habría insertado dos veces,
 * que es justo lo que el contrato promete evitar.
 *
 * También fuera: batch_id, fecha de recepción, orden dentro del lote, IP del
 * reloj, bridge_id y cualquier dato variable del transporte.
 */
function canonicalString(evento) {
  const campos = [
    CANONICAL_PREFIX,
    encodeField(evento.device_id),
    encodeField(evento.device_user_id),
    encodeField(evento.occurred_at),
    encodeField(evento.event_type),
  ];
  return campos.join(FIELD_SEP);
}

/**
 * Calcula el event_id. Depende sólo de los valores, nunca del orden de las
 * claves del objeto ni de su serialización JSON.
 */
function computeEventId(evento) {
  const canon = canonicalString(evento);
  return `sha256:${crypto.createHash('sha256').update(canon, 'utf8').digest('hex')}`;
}

/**
 * Construye un evento canónico desde cualquiera de las formas de origen.
 * Devuelve { ok, event, error_code, detail }.
 */
function buildEvent(input = {}, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error_code: REJECT_CODES.EVENT_NOT_OBJECT };
  }

  const device_id = toDeviceId(input.device_id ?? opts.device_id);
  if (device_id === null) return { ok: false, error_code: REJECT_CODES.DEVICE_ID_INVALID };

  const device_user_id = normalizeDeviceUserId(input.device_user_id ?? input.userId ?? input.employeeCode, opts);
  if (!device_user_id) return { ok: false, error_code: REJECT_CODES.USER_ID_INVALID };
  if (device_user_id.length > LIMITS.MAX_DEVICE_USER_ID) {
    return { ok: false, error_code: REJECT_CODES.USER_ID_INVALID, detail: 'demasiado largo' };
  }

  const occurred_at = normalizeTimestamp(input.occurred_at ?? input.timestamp, opts);
  if (!occurred_at) {
    const esDate = (input.occurred_at ?? input.timestamp) instanceof Date;
    return {
      ok: false,
      error_code: REJECT_CODES.TIMESTAMP_INVALID,
      detail: esDate ? 'un Date necesita dateMeans: utc_instant | civil_wall' : undefined,
    };
  }

  const event_type = normalizeEventType(input.event_type ?? input.type);

  const verify_mode = normalizeVerifyMode(input.verify_mode ?? input.verify);
  if (Number.isNaN(verify_mode)) return { ok: false, error_code: REJECT_CODES.VERIFY_MODE_INVALID };
  if (verify_mode !== null && (verify_mode < LIMITS.MIN_VERIFY_MODE || verify_mode > LIMITS.MAX_VERIFY_MODE)) {
    return { ok: false, error_code: REJECT_CODES.VERIFY_MODE_INVALID };
  }

  const work_code = normalizeString(input.work_code ?? input.workCode);
  if (work_code !== null && work_code.length > LIMITS.MAX_WORK_CODE) {
    return { ok: false, error_code: REJECT_CODES.WORK_CODE_INVALID };
  }

  for (const v of [device_user_id, work_code]) {
    if (typeof v === 'string' && v.includes(FIELD_SEP)) {
      return { ok: false, error_code: REJECT_CODES.SEPARATOR_IN_VALUE };
    }
  }

  const evento = { device_id, device_user_id, occurred_at, event_type, verify_mode, work_code };
  return { ok: true, event: { event_id: computeEventId(evento), ...evento } };
}

/**
 * Identificador de reloj: entero positivo, o el string decimal que lo
 * representa. Nada más.
 *
 * `Number` es demasiado generoso para esto: convierte `true` en 1, `[1]` en 1,
 * `'0x10'` en 16 y `'1e2'` en 100. Cualquiera de esos habría pasado como un
 * reloj real, y con un event_id calculado para otro.
 */
function toDeviceId(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Lote ─────────────────────────────────────────────────────────

/**
 * Un lote pertenece a UN reloj. Si un evento declara otro, se rechaza acá en
 * vez de dejar que el productor emita un lote que este mismo contrato va a
 * rechazar del otro lado.
 */
function buildBatch({ bridge_id, device_id, events = [], batch_id, generated_at } = {}, opts = {}) {
  let delLote = toDeviceId(device_id);

  // Sin reloj de lote válido, se deriva del de los eventos SI todos coinciden.
  // Sin esto, `delLote` quedaba en null, el chequeo de discrepancia se saltaba
  // y el lote salía con device_id: null — que validateBatch rechaza. Otra vez
  // el productor diciendo ok sobre algo que el consumidor no acepta.
  if (delLote === null) {
    const declarados = new Set();
    for (const e of events) {
      if (e && e.device_id !== undefined) declarados.add(toDeviceId(e.device_id));
    }
    if (declarados.size === 1 && !declarados.has(null)) {
      delLote = [...declarados][0];
    } else {
      return {
        ok: false,
        error_code: REJECT_CODES.DEVICE_ID_INVALID,
        detail: declarados.size > 1
          ? 'un lote es de un solo reloj y los eventos declaran varios'
          : 'falta el device_id del lote y no puede derivarse de los eventos',
      };
    }
  }

  const construidos = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const propio = e && e.device_id !== undefined ? toDeviceId(e.device_id) : null;
    if (delLote !== null && propio !== null && propio !== delLote) {
      return {
        ok: false,
        error_code: REJECT_CODES.DEVICE_ID_INVALID,
        detail: 'el evento declara un reloj distinto al del lote',
        index: i,
      };
    }
    const r = buildEvent(e, { ...opts, device_id: e && e.device_id !== undefined ? e.device_id : device_id });
    if (!r.ok) return { ...r, index: i };
    construidos.push(r.event);
  }
  return {
    ok: true,
    batch: {
      schema_version: PUNCH_CONTRACT_VERSION,
      batch_id: batch_id || `b-${crypto.randomBytes(8).toString('hex')}`,
      bridge_id: normalizeString(bridge_id) || 'desconocido',
      device_id: delLote,
      generated_at: new Date().toISOString(),
      events: construidos,
    },
  };
}

function reject(code, detail, index) {
  return { ok: false, error_code: code, detail: detail || null, ...(index !== undefined ? { index } : {}) };
}

/**
 * Valida un lote recibido. No lanza nunca.
 *
 * `checkEventIds` recalcula cada event_id y exige que coincida con el
 * declarado: si el emisor normalizó distinto, es mejor rechazar el lote que
 * aceptar identificadores que romperían la idempotencia río abajo.
 */
function validateBatch(batch, { now = Date.now(), checkEventIds = true } = {}) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    return reject(REJECT_CODES.BATCH_NOT_OBJECT);
  }
  if (batch.schema_version !== PUNCH_CONTRACT_VERSION) {
    return reject(REJECT_CODES.UNSUPPORTED_VERSION, `schema_version ${batch.schema_version}`);
  }

  const batchId = normalizeString(batch.batch_id);
  if (!batchId || batchId.length > LIMITS.MAX_BATCH_ID) return reject(REJECT_CODES.BATCH_ID_INVALID);

  const bridgeId = normalizeString(batch.bridge_id);
  if (!bridgeId || bridgeId.length > LIMITS.MAX_BRIDGE_ID) return reject(REJECT_CODES.BRIDGE_ID_INVALID);

  if (toDeviceId(batch.device_id) === null) return reject(REJECT_CODES.DEVICE_ID_INVALID);
  if (!normalizeTimestamp(batch.generated_at)) return reject(REJECT_CODES.GENERATED_AT_INVALID);

  if (!Array.isArray(batch.events) || batch.events.length === 0) return reject(REJECT_CODES.BATCH_EMPTY);
  if (batch.events.length > LIMITS.MAX_EVENTS_PER_BATCH) {
    return reject(REJECT_CODES.BATCH_TOO_MANY, `${batch.events.length} > ${LIMITS.MAX_EVENTS_PER_BATCH}`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(batch), 'utf8');
  if (bytes > LIMITS.MAX_BATCH_BYTES) {
    return reject(REJECT_CODES.BATCH_TOO_LARGE, `${bytes} > ${LIMITS.MAX_BATCH_BYTES}`);
  }

  for (let i = 0; i < batch.events.length; i++) {
    const r = validateEvent(batch.events[i], { now, checkEventIds, batchDeviceId: batch.device_id });
    if (!r.ok) return { ...r, index: i };
  }

  return { ok: true, batch_id: batchId, count: batch.events.length, bytes };
}

function validateEvent(evento, { now = Date.now(), checkEventIds = true, batchDeviceId } = {}) {
  if (!evento || typeof evento !== 'object' || Array.isArray(evento)) {
    return reject(REJECT_CODES.EVENT_NOT_OBJECT);
  }

  const device_id = toDeviceId(evento.device_id ?? batchDeviceId);
  if (device_id === null) return reject(REJECT_CODES.DEVICE_ID_INVALID);
  // Un evento no puede declarar otro reloj que el del lote. Si pudiera, un
  // lote de device_id 1 con un evento de device_id 2 —y su hash consistente—
  // pasaría la validación, y quien confíe en el reloj del lote para mapear o
  // guardar estaría atribuyendo el marcaje al equipo equivocado.
  const delLote = toDeviceId(batchDeviceId);
  if (delLote !== null && evento.device_id !== undefined && device_id !== delLote) {
    return reject(REJECT_CODES.DEVICE_ID_INVALID, 'no coincide con el device_id del lote');
  }

  const userId = normalizeString(evento.device_user_id);
  if (!userId || userId.length > LIMITS.MAX_DEVICE_USER_ID) return reject(REJECT_CODES.USER_ID_INVALID);
  if (userId !== evento.device_user_id) {
    return reject(REJECT_CODES.USER_ID_INVALID, 'sin normalizar (espacios o forma Unicode)');
  }
  // Un separador embebido permitiría fabricar dos eventos distintos con el
  // mismo string canónico. buildEvent ya lo rechaza; acá también, porque un
  // lote externo llega con su event_id ya calculado.
  if (userId.includes(FIELD_SEP)) return reject(REJECT_CODES.SEPARATOR_IN_VALUE);

  const occurred = normalizeTimestamp(evento.occurred_at);
  if (!occurred) return reject(REJECT_CODES.TIMESTAMP_INVALID);
  if (occurred !== evento.occurred_at) {
    return reject(REJECT_CODES.TIMESTAMP_INVALID, 'no está en forma canónica UTC con segundos');
  }
  const ms = Date.parse(occurred);
  if (ms - now > LIMITS.MAX_FUTURE_SKEW_MS) return reject(REJECT_CODES.TIMESTAMP_FUTURE);
  if (now - ms > LIMITS.MAX_PAST_AGE_MS) return reject(REJECT_CODES.TIMESTAMP_TOO_OLD);

  if (!EVENT_TYPES.includes(evento.event_type)) return reject(REJECT_CODES.EVENT_TYPE_INVALID);

  const vm = evento.verify_mode;
  if (vm !== null && vm !== undefined) {
    if (!Number.isInteger(vm) || vm < LIMITS.MIN_VERIFY_MODE || vm > LIMITS.MAX_VERIFY_MODE) {
      return reject(REJECT_CODES.VERIFY_MODE_INVALID);
    }
  }

  const wc = evento.work_code;
  if (wc !== null && wc !== undefined) {
    if (typeof wc !== 'string' || wc.length > LIMITS.MAX_WORK_CODE) {
      return reject(REJECT_CODES.WORK_CODE_INVALID);
    }
    // Debe venir ya canónico: buildEvent convierte '' y los espacios a null,
    // así que aceptar aquí una variante daría DOS event_id válidos para el
    // mismo marcaje según qué lado lo haya generado.
    if (normalizeString(wc) !== wc) {
      return reject(REJECT_CODES.WORK_CODE_INVALID, 'sin normalizar (vacío o espacios)');
    }
    if (wc.includes(FIELD_SEP)) return reject(REJECT_CODES.SEPARATOR_IN_VALUE);
  }

  if (checkEventIds) {
    const esperado = computeEventId({
      device_id,
      device_user_id: userId,
      occurred_at: occurred,
      event_type: evento.event_type,
    });
    if (evento.event_id !== esperado) return reject(REJECT_CODES.EVENT_ID_MISMATCH);
  }

  return { ok: true };
}

module.exports = {
  PUNCH_CONTRACT_VERSION,
  CIVIL_TIMEZONE,
  CIVIL_OFFSET_MINUTES,
  EVENT_TYPES,
  LIMITS,
  REJECT_CODES,
  FIELD_SEP,
  normalizeDeviceUserId,
  normalizeString,
  normalizeEventType,
  normalizeVerifyMode,
  normalizeTimestamp,
  canonicalString,
  computeEventId,
  buildEvent,
  buildBatch,
  validateBatch,
  validateEvent,
};
