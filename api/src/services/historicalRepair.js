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

/** Desplazamientos candidatos, en minutos. */
const SHIFTS = [180, 240];

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
 * `candidates` son filas { checktime, checktype } ya acotadas al empleado. Se
 * prueba cada desplazamiento y se exige coincidencia EXACTA de hora de pared;
 * no hay ventana de tolerancia, porque una ventana volvería ambiguos los
 * marcajes cercanos entre sí.
 *
 * El CHECKTYPE se usa sólo para DESEMPATAR: si sin él quedan dos
 * desplazamientos posibles y con él queda uno solo, se toma ese. Nunca se usa
 * para descartar la única coincidencia disponible, porque el tipo del lado
 * MySQL puede haber sido inferido (detectMarkType) y no es fuente de verdad.
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

  const tipoLog = normalizeCheckType(type);
  const golpes = [];       // desplazamientos con alguna coincidencia
  const golpesTipados = [];// idem, exigiendo tipo compatible

  for (const shift of [0, ...SHIFTS]) {
    const objetivo = addMinutesWall(wall, shift);
    const tipos = porHora.get(objetivo);
    if (!tipos) continue;
    golpes.push(shift);
    if (tipoLog && tipos.some(t => t === tipoLog)) golpesTipados.push(shift);
  }

  // El shift 0 manda: la hora guardada YA existe en la fuente de verdad, así
  // que es un marcaje real y desplazarlo sería inventar. Conservador a
  // propósito, incluso si además coincidiera algún desplazamiento.
  if (golpes.includes(0)) {
    return { status: STATUS.ALREADY_CORRECT, proposed: wall, delta: 0, reason: null };
  }

  // El tipo sólo desempata; nunca descarta la única opción disponible.
  const efectivos = (golpesTipados.length === 1 && golpes.length > 1) ? golpesTipados : golpes;

  if (efectivos.length === 0) {
    return { status: STATUS.NO_MATCH, proposed: null, delta: null, reason: 'sin candidato en ATT2000' };
  }
  if (efectivos.length > 1) {
    return {
      status: STATUS.AMBIGUOUS, proposed: null, delta: null,
      reason: `coincide con más de un desplazamiento: ${efectivos.join(', ')}`,
    };
  }

  const shift = efectivos[0];
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

    filas.push(fila);
  }

  return filas;
}

/** ¿Esta fila del manifest habilita escritura? */
function isApplicable(fila) {
  return APPLICABLE.has(fila.status)
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
