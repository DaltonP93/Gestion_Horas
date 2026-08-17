/**
 * historicalRepair.js — Núcleo de la reparación histórica de attendance_logs.
 *
 * QUÉ SE REPARA
 *
 * El flujo histórico `source='device'` guardó el INSTANTE UTC en una columna
 * DATETIME que todo el resto del sistema trata como hora de pared. Verificado
 * contra att2000.CHECKINOUT: la hora guardada está corrida exactamente el
 * offset que Paraguay tenía en ese momento.
 *
 *   invierno ≤ 2024 (UTC-4)  →  guardado = pared - 4 h   →  corregir +240
 *   desde 2024-10-06 (UTC-3) →  guardado = pared - 3 h   →  corregir +180
 *
 * El flujo `zkteco_direct` guarda bien (shift 0 verificado) y NO se toca.
 *
 * CRITERIO
 *
 * No se infiere el desplazamiento por la fecha. Se BUSCA en ATT2000 —la
 * fuente de verdad— y se exige un único candidato inequívoco. Un registro sin
 * respaldo en ATT2000, o con más de un candidato compatible, no se actualiza
 * nunca: queda reportado para revisión humana. Es preferible dejar filas sin
 * reparar que escribir una hora inventada sobre un registro de asistencia.
 *
 * Este módulo es PURO: no abre conexiones ni escribe archivos, para que toda
 * la lógica de decisión sea testeable sin base. El script de línea de comandos
 * (scripts/historical-attendance-repair.js) aporta la E/S.
 */

const crypto = require('crypto');

/** Desplazamientos candidatos, en minutos. */
const SHIFTS = [180, 240];

/**
 * Versión del ALGORITMO de clasificación.
 *
 * Se sube cada vez que cambia el criterio con el que se decide qué corregir.
 * El apply rechaza manifests de otra versión.
 *
 * Historia:
 *   1 — versión inicial: el shift 0 tenía prioridad y el CHECKTYPE desempataba.
 *   2 — vigente: se corrige sólo si EXACTAMENTE UNO de los desplazamientos
 *       coincide; el CHECKTYPE no desempata. El criterio 1 podía dejar filas
 *       corruptas en silencio y elegir mal el desplazamiento, así que un
 *       manifest generado con él NO debe poder aplicarse.
 */
const REPAIR_ALGORITHM_VERSION = 2;

/** Versión del FORMATO del archivo de manifest. */
const MANIFEST_VERSION = 1;

/**
 * Único origen autorizado a escribir.
 *
 * La reparación se autorizó sólo para el flujo histórico `device`.
 * `zkteco_direct` guarda bien y el resto no fue analizado, así que el apply
 * rechaza cualquier otro origen tanto a nivel de parámetro como fila por fila.
 */
const APPLICABLE_SOURCE = 'device';

/** Estados posibles de cada fila del manifest. */
const STATUS = {
  MATCH_180:       'MATCH_180',
  MATCH_240:       'MATCH_240',
  ALREADY_CORRECT: 'ALREADY_CORRECT',
  NO_MATCH:        'NO_MATCH',
  AMBIGUOUS:       'AMBIGUOUS',
  COLLISION:       'COLLISION',
};

/** Estados que habilitan escritura. Cualquier otro NUNCA se actualiza. */
const APPLICABLE = new Set([STATUS.MATCH_180, STATUS.MATCH_240]);

const pad2 = (n) => String(n).padStart(2, '0');
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * Normaliza un valor de fecha-hora a string de pared "YYYY-MM-DD HH:mm:ss".
 *
 * Acepta el string crudo del driver y también un Date. Para el Date se lee en
 * UTC a propósito: los drivers de este proyecto entregan las columnas
 * DATETIME con un offset fijo conocido, y el llamador es responsable de
 * pasarlas ya normalizadas o de leerlas con `dateStrings`. Nunca se usan
 * getters locales, que dependerían de la zona del proceso.
 */
function toWall(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`
      + ` ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}:${pad2(value.getUTCSeconds())}`;
  }
  const m = WALL_RE.exec(String(value));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : null;
}

/**
 * Suma minutos a una hora de pared y devuelve otra hora de pared.
 *
 * Usa `Date.UTC` sólo como aritmética de calendario —maneja fines de mes,
 * años bisiestos y cambios de año—. Eso NO es lo mismo que operar con un
 * `Date` local: `Date.UTC` no aplica ninguna zona horaria, y el resultado se
 * formatea a mano campo por campo. Por eso el resultado es idéntico corriendo
 * en UTC, America/Asuncion o Asia/Tokyo, y nunca se entrega un objeto Date a
 * la base, que es donde el driver volvería a convertir.
 */
function addMinutesWall(wall, minutes) {
  const m = WALL_RE.exec(String(wall || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + minutes * 60000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    + ` ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * Valida una fecha civil "YYYY-MM-DD" y devuelve su instante UTC, o null.
 *
 * La validación es ESTRICTA a propósito. `Date.UTC` normaliza los valores
 * fuera de rango en vez de rechazarlos: `2025-02-29` —que no existe— se
 * convierte en el 1 de marzo, y `2024-13-01` en enero del año siguiente. Si
 * eso llegara a `--to`, el rango "inclusive" abarcaría días de más sin avisar.
 * Por eso se comprueba que la fecha reconstruida coincida con la escrita.
 */
function parseCivilDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date == null ? '' : date).trim());
  if (!m) return null;
  const Y = +m[1], M = +m[2], D = +m[3];
  const t = Date.UTC(Y, M - 1, D);
  const d = new Date(t);
  if (d.getUTCFullYear() !== Y || d.getUTCMonth() !== M - 1 || d.getUTCDate() !== D) return null;
  return t;
}

/** ¿Es una fecha civil existente? */
function isCivilDate(date) {
  return parseCivilDate(date) != null;
}

/**
 * Día siguiente de una fecha civil "YYYY-MM-DD". null si la fecha no existe.
 *
 * Sirve para armar el intervalo semiabierto [desde, díaSiguiente(hasta)), que
 * es la única forma de que `--to` sea realmente inclusivo: un `< 'to 23:59:59'`
 * excluye exactamente los marcajes de 23:59:59.
 */
function nextDayISO(date) {
  const t = parseCivilDate(date);
  if (t == null) return null;
  const d = new Date(t + 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Margen, en minutos, que hay que mirar MÁS ALLÁ del rango de attendance_logs.
 *
 * Los candidatos válidos de un registro están en +0, +180 y +240 minutos, así
 * que para un lote de logs acotado a [desde, hasta) los candidatos posibles
 * caen en [desde, hasta + 240min]. Ese 240 es el máximo de SHIFTS y no un
 * número elegido a dedo: si algún día se agregara un desplazamiento mayor, el
 * margen tiene que crecer con él.
 */
const WINDOW_MARGIN_MINUTES = Math.max(...SHIFTS);

/**
 * Ventana de horas de pared donde pueden caer los candidatos y las horas
 * propuestas, para un rango de fechas civiles [from, to] ambas inclusive.
 *
 * Devuelve límites INCLUSIVOS { desde, hasta }, o null si no hay rango —en ese
 * caso el llamador consulta sin acotar, que es el comportamiento histórico.
 *
 * Sirve para dos consultas distintas y por el mismo motivo:
 *
 * - los CHECKINOUT de ATT2000 que hay que traer;
 * - las claves UNIQUE de attendance_logs con las que se detectan colisiones,
 *   porque una hora propuesta = hora vieja + 180 o + 240.
 *
 * Es deliberadamente un SUPERCONJUNTO de lo estrictamente necesario: se
 * prefiere traer alguna fila de más antes que perder una coincidencia o una
 * colisión. Sin acotar, analizar un mes obligaba a cargar la historia completa
 * de cada empleado involucrado.
 */
function candidateWindow({ from, to } = {}) {
  if (!from && !to) return null;
  const desde = from ? `${from} 00:00:00` : null;
  let hasta = null;
  if (to) {
    const finExclusivo = nextDayISO(to);
    if (!finExclusivo) return null;
    hasta = addMinutesWall(`${finExclusivo} 00:00:00`, WINDOW_MARGIN_MINUTES);
  }
  if (from && !isCivilDate(from)) return null;
  return { desde, hasta };
}

/**
 * Ventana derivada de las filas de un manifest, para revalidar en el apply.
 *
 * Se calcula sobre las horas VIEJAS —que son las que se vuelven a clasificar—
 * más el margen de los desplazamientos. Así el apply no necesita reconstruir
 * los parámetros del dry-run ni volver a leer toda la historia.
 */
function candidateWindowForRows(filas) {
  const viejas = (filas || []).map(f => f && f.old_timestamp).filter(Boolean).sort();
  if (!viejas.length) return null;
  return {
    desde: viejas[0],
    hasta: addMinutesWall(viejas[viejas.length - 1], WINDOW_MARGIN_MINUTES),
  };
}

/** Parte de fecha de una hora de pared. */
function wallDate(wall) {
  const m = WALL_RE.exec(String(wall || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Clave del índice UNIQUE de attendance_logs:
 * (employee_id, timestamp, IFNULL(device_id, 0)).
 */
function uniqueKey(employeeId, wall, deviceId) {
  return `${employeeId}|${wall}|${deviceId == null ? 0 : deviceId}`;
}

/** CHECKTYPE de ATT2000 → 'in' | 'out' | null cuando no es utilizable. */
function normalizeCheckType(checkType) {
  if (checkType == null) return null;
  const s = String(checkType).trim().toUpperCase();
  if (s === 'I' || s === '0' || s === 'IN')  return 'in';
  if (s === 'O' || s === '1' || s === 'OUT') return 'out';
  return null;
}

/**
 * Clasifica UN registro contra los candidatos de ATT2000 del mismo USERID.
 *
 * `candidates` son filas { checktime, checktype } ya acotadas al empleado, con
 * `checktime` como hora de pared. Se exige coincidencia EXACTA; no hay
 * ventana de tolerancia, porque una ventana volvería ambiguos los marcajes
 * cercanos entre sí.
 *
 * LA REGLA ES UNA SOLA: se corrige únicamente cuando EXACTAMENTE UNO de los
 * desplazamientos —0, +180, +240— encuentra candidato. Cualquier otra cosa es
 * ambigua y no se toca.
 *
 * Dos consecuencias que valen explicitarse, porque en versiones anteriores de
 * este archivo se resolvían mal:
 *
 * 1. Coincidir a shift 0 NO prueba que ese sea el evento de esta fila. Sólo
 *    prueba que ATT2000 tiene ALGÚN marcaje a esa hora. Si alguien marcó a
 *    las 03:00 y a las 06:00, y el evento de las 06:00 quedó guardado como
 *    03:00 por el desfase, los dos candidatos existen: declararlo
 *    ALREADY_CORRECT dejaría la fila corrupta en silencio. Por eso el shift 0
 *    sólo gana cuando es la ÚNICA coincidencia.
 *
 * 2. El CHECKTYPE NO se usa para desempatar. El tipo del lado MySQL puede
 *    venir de detectMarkType, que alterna por paridad de marcas del día: si
 *    falta una marca histórica la paridad se invierte, y con dos candidatos
 *    separados exactamente una hora ese tipo inferido elegiría el
 *    desplazamiento equivocado y corrompería el timestamp. Los tipos vistos
 *    se reportan en `reason` para que decida una persona.
 */
function classify({ timestamp, type }, candidates = []) {
  const wall = toWall(timestamp);
  if (!wall) return { status: STATUS.NO_MATCH, proposed: null, delta: null, reason: 'timestamp ilegible' };

  const porHora = new Map();
  for (const c of candidates) {
    const w = toWall(c.checktime);
    if (!w) continue;
    if (!porHora.has(w)) porHora.set(w, []);
    porHora.get(w).push(normalizeCheckType(c.checktype));
  }

  const golpes = [];
  for (const shift of [0, ...SHIFTS]) {
    if (porHora.has(addMinutesWall(wall, shift))) golpes.push(shift);
  }

  if (golpes.length === 0) {
    return { status: STATUS.NO_MATCH, proposed: null, delta: null, reason: 'sin candidato en ATT2000' };
  }

  if (golpes.length > 1) {
    // Se informan los tipos vistos en cada desplazamiento: es la evidencia
    // que necesita una persona para resolverlo a mano.
    const detalle = golpes
      .map(s => `${s}=[${(porHora.get(addMinutesWall(wall, s)) || []).map(t => t || '?').join(',')}]`)
      .join(' ');
    return {
      status: STATUS.AMBIGUOUS, proposed: null, delta: null,
      reason: `coincide con más de un desplazamiento (tipo del log: ${normalizeCheckType(type) || '?'}) → ${detalle}`,
    };
  }

  const shift = golpes[0];
  if (shift === 0) {
    return { status: STATUS.ALREADY_CORRECT, proposed: wall, delta: 0, reason: null };
  }
  return {
    status: shift === 180 ? STATUS.MATCH_180 : STATUS.MATCH_240,
    proposed: addMinutesWall(wall, shift),
    delta: shift,
    reason: null,
  };
}

/**
 * Construye el manifest completo.
 *
 * `logs`      filas de attendance_logs (ya filtradas por source)
 * `candidatesByCode`  Map: employee_code → filas de CHECKINOUT
 * `existingKeys`      Set de claves UNIQUE ya presentes en la tabla
 *
 * Las colisiones se detectan ANTES de aplicar, en dos frentes: contra las
 * filas que ya existen, y contra las otras filas propuestas del mismo
 * manifest —dos registros distintos pueden proponer la misma hora final—.
 */
function buildManifest({ logs, candidatesByCode, existingKeys = new Set() }) {
  const propuestas = new Map();   // clave UNIQUE → id del log que la reclamó
  const filas = [];

  for (const log of logs) {
    const wall = toWall(log.timestamp);
    const cands = candidatesByCode.get(String(log.employee_code)) || [];
    const r = classify({ timestamp: wall, type: log.type }, cands);

    const fila = {
      attendance_log_id:  log.id,
      employee_id:        log.employee_id,
      employee_code:      log.employee_code,
      device_id:          log.device_id ?? null,
      source:             log.source,
      // `type` viaja en el manifest porque el guard optimista del apply lo
      // compara: si cambió entre el dry-run y la escritura, la fila ya no es
      // la que se evaluó.
      type:               log.type ?? null,
      old_timestamp:      wall,
      proposed_timestamp: r.proposed,
      delta_minutes:      r.delta,
      status:             r.status,
      reason:             r.reason,
      // La corrección puede mover el registro a otro día: eso obliga a
      // recalcular el resumen del día viejo Y el del nuevo.
      date_changes: Boolean(r.proposed) && wallDate(r.proposed) !== wallDate(wall),
    };

    if (APPLICABLE.has(r.status)) {
      const clave = uniqueKey(log.employee_id, r.proposed, log.device_id);
      if (existingKeys.has(clave) || propuestas.has(clave)) {
        fila.status = STATUS.COLLISION;
        fila.reason = existingKeys.has(clave)
          ? 'la hora propuesta ya existe en attendance_logs'
          : `choca con la propuesta del registro ${propuestas.get(clave)}`;
        fila.proposed_timestamp = r.proposed;   // se conserva para diagnóstico
      } else {
        propuestas.set(clave, log.id);
      }
    }

    fila.digest = rowDigest(fila);
    filas.push(fila);
  }

  return filas;
}

/**
 * Huella de una fila del manifest.
 *
 * Cubre los campos que DECIDEN la escritura más la versión del algoritmo. Su
 * propósito es detectar ediciones del archivo: cambiar a mano un AMBIGUOUS a
 * MATCH_240 invalida la huella y el apply rechaza la fila.
 *
 * NO es una firma criptográfica: quien conozca el algoritmo puede recalcularla.
 * La defensa real contra un manifest fabricado es la revalidación contra
 * ATT2000 que hace el apply antes de escribir; esto ataja el error humano.
 */
function rowDigest(fila) {
  const canonico = [
    REPAIR_ALGORITHM_VERSION,
    fila.attendance_log_id, fila.employee_id, fila.employee_code,
    fila.device_id == null ? 0 : fila.device_id,
    fila.source, fila.type,
    fila.old_timestamp, fila.proposed_timestamp,
    fila.delta_minutes, fila.status,
  ].join('|');
  return crypto.createHash('sha256').update(canonico).digest('hex').slice(0, 32);
}

/** Huella del conjunto, para detectar filas agregadas o borradas. */
function manifestDigest(filas) {
  const h = crypto.createHash('sha256');
  h.update(`v${REPAIR_ALGORITHM_VERSION}:${MANIFEST_VERSION}:${filas.length}`);
  for (const f of filas) h.update(`|${f.digest || rowDigest(f)}`);
  return h.digest('hex').slice(0, 32);
}

/** ¿La huella de la fila corresponde a su contenido y al algoritmo vigente? */
function rowDigestOk(fila) {
  return Boolean(fila && fila.digest) && fila.digest === rowDigest(fila);
}

/** ¿Esta fila del manifest habilita escritura? */
function isApplicable(fila) {
  return APPLICABLE.has(fila.status)
    && fila.source === APPLICABLE_SOURCE
    && Boolean(fila.proposed_timestamp)
    && fila.proposed_timestamp !== fila.old_timestamp;
}

/**
 * Resumen agregado del manifest, por período, dispositivo y origen.
 */
function summarize(filas) {
  const vacio = () => Object.fromEntries(Object.values(STATUS).map(s => [s, 0]));
  const total = vacio();
  const porMes = {};
  const porDevice = {};
  const porSource = {};

  let cambianDeDia = 0;

  for (const f of filas) {
    total[f.status] = (total[f.status] || 0) + 1;
    if (f.date_changes && isApplicable(f)) cambianDeDia++;

    const mes = (wallDate(f.old_timestamp) || '????-??').slice(0, 7);
    const dev = f.device_id == null ? 'sin_device' : String(f.device_id);

    (porMes[mes]     || (porMes[mes]     = vacio()))[f.status]++;
    (porDevice[dev]  || (porDevice[dev]  = vacio()))[f.status]++;
    (porSource[f.source] || (porSource[f.source] = vacio()))[f.status]++;
  }

  return {
    total_registros: filas.length,
    aplicables: filas.filter(isApplicable).length,
    cambian_de_dia: cambianDeDia,
    por_estado: total,
    por_mes: porMes,
    por_device: porDevice,
    por_source: porSource,
  };
}

/**
 * Pares (employee_id, date) a recalcular después de aplicar.
 *
 * Incluye el día viejo y el nuevo de cada fila aplicable: mover un marcaje de
 * día deja mal los DOS resúmenes. NO se recalcula automáticamente; esto es
 * sólo la lista.
 */
function recalcTargets(filas) {
  const set = new Set();
  for (const f of filas) {
    if (!isApplicable(f)) continue;
    set.add(`${f.employee_id}|${wallDate(f.old_timestamp)}`);
    set.add(`${f.employee_id}|${wallDate(f.proposed_timestamp)}`);
  }
  return [...set]
    .map(k => { const [employee_id, date] = k.split('|'); return { employee_id: Number(employee_id), date }; })
    .sort((a, b) => (a.date === b.date ? a.employee_id - b.employee_id : a.date < b.date ? -1 : 1));
}

module.exports = {
  SHIFTS,
  STATUS,
  APPLICABLE,
  APPLICABLE_SOURCE,
  REPAIR_ALGORITHM_VERSION,
  MANIFEST_VERSION,
  nextDayISO,
  isCivilDate,
  WINDOW_MARGIN_MINUTES,
  candidateWindow,
  candidateWindowForRows,
  rowDigest,
  manifestDigest,
  rowDigestOk,
  toWall,
  addMinutesWall,
  wallDate,
  uniqueKey,
  normalizeCheckType,
  classify,
  buildManifest,
  isApplicable,
  summarize,
  recalcTargets,
};
