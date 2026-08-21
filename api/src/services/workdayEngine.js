/**
 * workdayEngine.js — Motor único de jornada laboral.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Hoy la jornada se arma en DOS lugares que no se hablan entre sí:
 *
 *   - `scheduler.generateMarcadasReport()` agrupa marcajes por "fecha
 *     laboral" con un corte fijo a las 05:00 y los empareja por posición
 *     (par = entrada, impar = salida).
 *   - `attendanceController.recalcDailySummary()` toma los marcajes de UNA
 *     fecha civil y calcula primera entrada / última salida.
 *
 * Los dos dan resultados distintos para la misma persona y el mismo día, y
 * los dos se equivocan en turno nocturno. Este módulo es la única definición
 * de "jornada" del sistema; los reportes pasan a consumirlo.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DEFECTOS CONFIRMADOS QUE ESTE MOTOR CORRIGE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. REINTERPRETACIÓN HORARIA DEL HISTÓRICO.
 *
 *    `scheduler.toDate()` toma el string DATETIME de MySQL y construye un
 *    instante fijando `-03:00`; después `pyHour()` / `pyDateStr()` /
 *    `fmtTime()` lo formatean con `Intl` y `America/Asuncion`, que SÍ aplica
 *    la tzdata histórica (Paraguay estuvo en UTC-4 hasta el 2024-10-06).
 *    El resultado es que toda marcación anterior a esa fecha, en invierno,
 *    se muestra una hora antes de lo guardado. Verificado:
 *
 *        guardado 2024-08-01 08:00:00  →  se imprime 07:00 del 01/08/2024
 *        guardado 2024-06-15 00:30:00  →  se imprime 23:30 del 14/06/2024
 *
 *    El segundo caso además cambia de DÍA: la marca se contabiliza en la
 *    jornada equivocada. Acá nunca se convierte zona: el DATETIME guardado
 *    es hora de pared y se lee como hora de pared.
 *
 * 2. CORTE FIJO A LAS 05:00 PARA EL TURNO NOCHE.
 *
 *    La regla "las marcas antes de las 05:00 pertenecen al día anterior" es
 *    una heurística sobre el reloj, no sobre la jornada. Falla en los dos
 *    sentidos:
 *
 *      - una salida a las 07:04 del día siguiente queda asignada al día
 *        siguiente, partiendo en dos una jornada que empezó a las 18:30;
 *      - una salida a las 05:29 queda en su propio día por 29 minutos.
 *
 *    Acá la jornada se arma ENCADENANDO marcajes: una salida pertenece a la
 *    jornada que abrió su entrada, sin importar en qué fecha civil cayó.
 *
 * 3. EMPAREJAMIENTO POSICIONAL.
 *
 *    Emparejar por índice (par/impar) ignora `attendance_logs.type`. Un
 *    marcaje espurio corre TODOS los pares del día. Acá el tipo manda cuando
 *    es explícito (`in` / `out`) y sólo se recurre a la alternancia cuando
 *    vale `unknown`, que es el caso del histórico importado.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * MODELO
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   marcaje  →  segmento (entrada→salida)  →  jornada (1..n segmentos)
 *
 * Una jornada agrupa segmentos consecutivos separados por pausas cortas. Su
 * `work_date` es la FECHA CIVIL DE LA PRIMERA ENTRADA, no la de cada marca.
 * Es la única definición que hace que un turno 18:30→07:04 sea una jornada
 * del día que empezó.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DOS MODOS
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   'historical_fallback'  Sin configuración vigente para esa fecha. Sólo se
 *                          describe lo que los marcajes dicen: segmentos,
 *                          permanencia, tiempo trabajado. NO se calcula
 *                          atraso ni horas extra, porque no hay contra qué
 *                          compararlos. Es el modo del histórico: aplicar el
 *                          `schedule_id` de hoy a 2024 inventaría atrasos.
 *
 *   'configured'           Hay configuración vigente PARA ESA FECHA (via
 *                          `employee_schedule_history`). Se agregan atraso,
 *                          salida anticipada, descanso según su modo y
 *                          comparación contra el objetivo semanal.
 *
 * El modo se decide por fecha, nunca por empleado: la misma persona puede
 * estar en `historical_fallback` en 2024 y en `configured` en 2026.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HORA DE PARED — REQUISITO CRÍTICO
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Toda la aritmética usa un contador absoluto de segundos derivado de las
 * PARTES CIVILES (año, mes, día, hora, minuto, segundo) del valor guardado.
 * No hay `Intl`, no hay tzdata, no hay offsets históricos. Por eso los
 * resultados son idénticos corriendo el proceso en UTC, en America/Asuncion
 * o en Asia/Tokyo, y por eso los tests pueden fijar valores absolutos.
 *
 * El módulo es PURO: no consulta la base ni lee `process.env`. Quien lo usa
 * le pasa los marcajes y la configuración ya resueltos.
 */

const { dbWallClock } = require('../utils/dbTime');
const calc = require('./dailySummaryCalc');

const MODE_HISTORICAL_FALLBACK = 'historical_fallback';
const MODE_CONFIGURED = 'configured';

const BREAK_NONE = 'none';
const BREAK_FIXED_UNPAID = 'fixed_unpaid';
const BREAK_PUNCHED = 'punched';

/**
 * Versión de la política de cálculo.
 *
 * Se guarda en cada jornada calculada. Sirve para responder, meses después,
 * "¿con qué reglas se produjo este número?" sin tener que adivinar qué commit
 * estaba desplegado. Subirla es obligatorio cuando cambie cualquier umbral o
 * criterio que altere resultados ya emitidos.
 *
 *   1 — versión inicial: encadenamiento por pausas, pairing por tipo,
 *       descansos none/fixed_unpaid/punched.
 */
const POLICY_VERSION = 1;

/**
 * Catálogo de anomalías.
 *
 * Existe como constantes y no como strings sueltos porque estos códigos
 * viajan al CLI de auditoría y a la UI: un typo silencioso convertiría una
 * anomalía real en una categoría que nadie mira.
 *
 * La regla de fondo: ante una secuencia que no se puede interpretar, el motor
 * REPORTA y deja el tiempo sin contar. No inventa la marca que falta. Un cero
 * acompañado de su anomalía es un dato honesto; un número estimado es una
 * laguna disfrazada de medición.
 */
const ANOMALY = Object.freeze({
  /** Salida sin ninguna entrada previa que cerrar. */
  SALIDA_SIN_ENTRADA: 'salida_sin_entrada',
  /** Entrada que nunca se cerró: el tramo queda abierto y en cero. */
  ENTRADA_SIN_SALIDA: 'entrada_sin_salida',
  /** Dos entradas seguidas: se perdió la salida intermedia. */
  ENTRADAS_CONSECUTIVAS: 'entradas_consecutivas',
  /** Dos salidas seguidas: se perdió la entrada intermedia. */
  SALIDAS_CONSECUTIVAS: 'salidas_consecutivas',
  /** Fichaje repetido por el reloj, colapsado conservando trazabilidad. */
  MARCAJE_DUPLICADO: 'marcaje_duplicado',
  /** Tramo más largo que `historicalMaxSessionSpanMinutes`. */
  SESION_EXCESIVA: 'sesion_excesiva',
  /** Jornada que alcanzó el tope de duración total. */
  JORNADA_EXCESIVA: 'jornada_excesiva',
  /** Valor de `timestamp` que no se pudo interpretar. */
  MARCAJE_ILEGIBLE: 'marcaje_ilegible',
});

/**
 * Parámetros por defecto.
 *
 * NINGUNO codifica una regla legal. Son umbrales de FORMA de la jornada
 * (cuánto puede durar un tramo, cuánta pausa sigue siendo la misma jornada)
 * y todos se pueden sobreescribir por llamada y, aguas arriba, por
 * configuración persistida. Las 48 h semanales paraguayas NO están acá: el
 * objetivo semanal es un dato de configuración y su ausencia no inventa uno.
 */
const DEFAULTS = Object.freeze({
  /**
   * `historical_max_session_span_minutes`
   *
   * Un tramo entrada→salida más largo que esto no es un tramo: es una salida
   * que nunca se marcó. 16 h cubre turnos de 12 h con horas extra sin llegar a
   * encadenar dos jornadas distintas.
   */
  historicalMaxSessionSpanMinutes: 16 * 60,

  /**
   * `historical_max_intersegment_gap_minutes`
   *
   * Pausa entre la salida de un tramo y la entrada del siguiente que todavía
   * cuenta como la MISMA jornada (almuerzo, turno partido). Por encima de esto
   * empieza una jornada nueva. 4 h separa un turno partido de dos turnos
   * distintos del mismo día.
   *
   * Deliberadamente NO es la regla "todo lo anterior a las 05:00 pertenece al
   * día anterior": esa mira el reloj, ésta mira la jornada.
   */
  historicalMaxIntersegmentGapMinutes: 4 * 60,

  /**
   * `historical_max_workday_span_minutes`
   *
   * Tope de duración total de una jornada, primera entrada → última salida.
   * Impide que una cadena de marcajes sucios encadene días enteros.
   */
  historicalMaxWorkdaySpanMinutes: 20 * 60,

  /**
   * `duplicate_window_seconds`
   *
   * Marcajes de tipo compatible dentro de esta ventana son el mismo fichaje
   * repetido por el reloj. Es el criterio que ya usaba el reporte de Marcadas.
   * Una entrada y una salida dentro de la ventana NO se colapsan entre sí.
   */
  duplicateWindowSeconds: 60,

  /** `true` = el `type` explícito manda; `unknown` cae en alternancia. */
  typeAware: true,

  /**
   * Franja nocturna, en minutos del día. `null` = no hay franja definida y
   * `night_minutes` sale en 0.
   *
   * Deliberadamente sin valor por defecto: el horario nocturno y su recargo
   * son materia legal y de convenio. Poner 20:00→06:00 "porque es lo usual"
   * sería exactamente la regla laboral hardcodeada que no corresponde meter.
   */
  nightStartMinute: null,
  nightEndMinute: null,
});

// ─────────────────────────────────────────────────────────────────────
// Primitivas de hora de pared
// ─────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Valor DATETIME → { date, secondsOfDay, abs }.
 *
 * `abs` es un contador de segundos derivado exclusivamente de las partes
 * civiles: `Date.UTC` se usa como CALENDARIO PURO (cuántos días hay entre dos
 * fechas), no como instante. Restar dos `abs` da la diferencia de hora de
 * pared exacta, atraviese o no la medianoche, sin que ninguna zona horaria
 * intervenga.
 *
 * Devuelve null si el valor no se puede interpretar; nunca lanza, para que un
 * registro corrupto aislado no tumbe un reporte entero.
 *
 * La validación es ESTRICTA por ida y vuelta, y hace falta: `Date.UTC`
 * normaliza en silencio lo imposible. `Date.UTC(2025, 12, 45)` no falla, da el
 * 2026-02-14; `Date.UTC(2025, 1, 29)` da el 1 de marzo. Sin el round-trip, una
 * fecha basura no se rechazaría sino que se convertiría en otra fecha
 * perfectamente creíble, y el error viajaría hasta el reporte.
 */
function toWall(value) {
  const wc = dbWallClock(value);
  if (!wc) return null;
  const [y, m, d] = wc.date.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(utc)) return null;
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== m || back.getUTCDate() !== d) {
    return null;
  }
  return { date: wc.date, secondsOfDay: wc.seconds, abs: (utc / 86400000) * 86400 + wc.seconds };
}

/** Segundos absolutos → 'YYYY-MM-DD'. Inverso exacto de `toWall`. */
function absToDateISO(abs) {
  const days = Math.floor(abs / 86400);
  const d = new Date(days * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Segundos absolutos → 'HH:mm' de pared. */
function absToHHmm(abs) {
  const s = ((abs % 86400) + 86400) % 86400;
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}

/** Segundos absolutos → 'YYYY-MM-DD HH:mm:ss' de pared (formato MySQL). */
function absToDateTime(abs) {
  const s = ((abs % 86400) + 86400) % 86400;
  return `${absToDateISO(abs)} ${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/**
 * Día de la semana de una fecha civil: 0 = Domingo … 6 = Sábado.
 *
 * Se calcula desde el contador de días, no con `new Date(iso).getDay()`, que
 * lee la fecha en la zona del proceso y puede correrse un día. Ancla: el
 * 1970-01-01 fue jueves (4).
 */
function dayOfWeekISO(dateISO) {
  const w = toWall(`${dateISO} 00:00:00`);
  if (!w) return null;
  const days = Math.floor(w.abs / 86400);
  return ((days % 7) + 4 + 7) % 7;
}

/** Minutos → 'H:mm'. Nunca negativo. */
function minutesToHM(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Normalización de marcajes
// ─────────────────────────────────────────────────────────────────────

const TIPOS_APERTURA = new Set(['in', 'break_end']);
const TIPOS_CIERRE = new Set(['out', 'break_start']);

/**
 * Tipo efectivo de un marcaje: 'in' | 'out' | 'unknown'.
 *
 * `break_start` / `break_end` se mapean a cierre / apertura porque para el
 * cómputo de tiempo trabajado se comportan igual: el descanso interrumpe el
 * tramo. Cualquier otro valor —incluido el `unknown` masivo del histórico
 * importado— queda como 'unknown' y lo resuelve la alternancia.
 */
function effectiveType(type) {
  const t = String(type || '').toLowerCase();
  if (TIPOS_APERTURA.has(t)) return 'in';
  if (TIPOS_CIERRE.has(t)) return 'out';
  return 'unknown';
}

/**
 * ¿Dos marcajes cercanos son el MISMO fichaje repetido por el reloj?
 *
 * La cercanía sola no alcanza, y ésta es la parte que importa. Un reloj que
 * emite el mismo fichaje dos veces por segundo produce dos marcas del mismo
 * tipo: ésas sí se colapsan. Pero una ENTRADA y una SALIDA separadas por
 * treinta segundos son dos eventos distintos —alguien fichó, se dio cuenta de
 * que era el marcador equivocado y volvió a fichar, o entró y salió— y
 * colapsarlas destruye el cierre del tramo: el segmento queda abierto y la
 * jornada pierde sus minutos.
 *
 * Por eso el criterio es: se colapsa cuando los tipos son COMPATIBLES —
 * iguales, o alguno todavía sin determinar— y nunca cuando son explícitamente
 * opuestos.
 *
 * El caso `unknown` contra `unknown` sigue colapsando, que es lo que el
 * histórico importado necesita: sin tipo no hay forma de distinguir la ráfaga
 * del reloj de dos eventos reales, y el criterio heredado del reporte es el
 * único respaldado por los datos.
 */
function tiposCompatiblesParaDedupe(a, b) {
  if (a === b) return true;
  return a === 'unknown' || b === 'unknown';
}

/**
 * Ordena, descarta lo ilegible y colapsa repeticiones del reloj.
 *
 * La deduplicación conserva el PRIMER marcaje de la ráfaga —igual que el
 * reporte actual— pero rescata el primer tipo explícito que aparezca en ella:
 * si el reloj emite `unknown` a las 08:00:00 e `in` a las 08:00:02, la
 * jornada se queda con 08:00:00 tipo `in`. Perder ese tipo sería volver a la
 * alternancia sin necesidad.
 *
 * TRAZABILIDAD: cada marcaje conserva `logIds`, la lista de
 * `attendance_logs.id` que quedaron representados por él. Colapsar sin dejar
 * rastro haría imposible explicar de dónde salió un total; con la lista, el
 * CLI de auditoría puede mostrar exactamente qué filas se usaron y cuáles se
 * consideraron repetición.
 */
function normalizePunches(punches, opts) {
  const dedupeSeconds = opts.duplicateWindowSeconds;
  const parsed = [];

  for (const p of punches || []) {
    const raw = p && (p.timestamp !== undefined ? p.timestamp : p.ts);
    const wall = toWall(raw);
    if (!wall) continue;
    const id = p.id != null ? p.id : (p.attendance_log_id != null ? p.attendance_log_id : null);
    parsed.push({
      abs: wall.abs,
      date: wall.date,
      secondsOfDay: wall.secondsOfDay,
      type: effectiveType(p.type),
      rawType: p.type != null ? String(p.type) : null,
      datetime: absToDateTime(wall.abs),
      hhmm: absToHHmm(wall.abs),
      source: p.source || null,
      deviceId: p.device_id != null ? p.device_id : null,
      id,
      logIds: id != null ? [id] : [],
    });
  }

  parsed.sort((a, b) => (a.abs - b.abs) || ((a.id || 0) - (b.id || 0)));

  const out = [];
  const duplicados = [];
  for (const p of parsed) {
    const prev = out[out.length - 1];
    if (prev
      && p.abs - prev.abs <= dedupeSeconds
      && tiposCompatiblesParaDedupe(prev.type, p.type)
    ) {
      if (prev.type === 'unknown' && p.type !== 'unknown') prev.type = p.type;
      prev.duplicates = (prev.duplicates || 0) + 1;
      if (p.id != null) prev.logIds.push(p.id);
      duplicados.push({ code: ANOMALY.MARCAJE_DUPLICADO, at: p.datetime, log_id: p.id });
      continue;
    }
    out.push(p);
  }
  return { punches: out, duplicados };
}

// ─────────────────────────────────────────────────────────────────────
// Segmentación (entrada → salida)
// ─────────────────────────────────────────────────────────────────────

/**
 * Arma tramos entrada→salida a partir de los marcajes normalizados.
 *
 * REGLA CENTRAL: no se inventan marcajes. Una salida sin entrada previa no
 * genera una entrada ficticia al inicio del día, y una entrada sin salida no
 * genera una salida al final: se registran como tramo abierto o como marca
 * huérfana, con su advertencia, y quedan visibles en el reporte. Estimar el
 * dato faltante convertiría una laguna conocida en un número que parece
 * medido.
 */
function buildSegments(punches, opts) {
  const segments = [];
  const anomalies = [];
  const maxSegmentSeconds = opts.historicalMaxSessionSpanMinutes * 60;
  let open = null;
  let ultimoTipo = null;

  const anotar = (code, punch, extra) => {
    anomalies.push({ code, at: punch.datetime, log_ids: punch.logIds.slice(), ...extra });
  };

  const cerrarAbierto = (code) => {
    segments.push({ in: open, out: null, seconds: 0, open: true });
    anotar(code, open);
    open = null;
  };

  for (const p of punches) {
    const tipo = opts.typeAware ? p.type : 'unknown';

    if (!open) {
      if (tipo === 'out') {
        // Salida sin entrada. Puede ser el cierre legítimo de una jornada que
        // empezó antes de la ventana consultada, o una entrada que el reloj
        // nunca registró. En los dos casos se anota y NO se inventa entrada:
        // fabricar un IN al inicio del día produciría horas que nadie trabajó.
        anotar(
          ultimoTipo === 'out' ? ANOMALY.SALIDAS_CONSECUTIVAS : ANOMALY.SALIDA_SIN_ENTRADA,
          p,
        );
        ultimoTipo = 'out';
        continue;
      }
      open = p;
      ultimoTipo = tipo;
      continue;
    }

    if (tipo === 'in') {
      // Segunda entrada con un tramo abierto: el reloj perdió la salida.
      cerrarAbierto(ANOMALY.ENTRADAS_CONSECUTIVAS);
      open = p;
      ultimoTipo = 'in';
      continue;
    }

    const dur = p.abs - open.abs;
    if (dur > maxSegmentSeconds) {
      // Demasiado largo para ser un tramo real: la salida nunca se marcó y
      // este marcaje pertenece a otra jornada. Contar la diferencia daría una
      // sesión de días enteros.
      cerrarAbierto(ANOMALY.SESION_EXCESIVA);
      if (tipo === 'out') {
        anotar(ANOMALY.SALIDA_SIN_ENTRADA, p);
        ultimoTipo = 'out';
      } else {
        open = p;
        ultimoTipo = tipo;
      }
      continue;
    }

    segments.push({ in: open, out: p, seconds: dur, open: false });
    open = null;
    ultimoTipo = tipo;
  }

  if (open) cerrarAbierto(ANOMALY.ENTRADA_SIN_SALIDA);
  return { segments, anomalies };
}

// ─────────────────────────────────────────────────────────────────────
// Agrupación en jornadas
// ─────────────────────────────────────────────────────────────────────

/**
 * Encadena tramos en jornadas.
 *
 * Un tramo continúa la jornada anterior si la pausa desde el cierre previo no
 * supera `historicalMaxIntersegmentGapMinutes` Y la jornada resultante no
 * excede `historicalMaxWorkdaySpanMinutes`. En cualquier otro caso abre una
 * jornada nueva.
 *
 * Un tramo ABIERTO (sin salida) cierra la cadena: no se puede medir la pausa
 * que le sigue, así que el marcaje siguiente empieza jornada nueva en vez de
 * encadenarse sobre un dato que no existe.
 */
function groupWorkdays(segments, opts) {
  const maxGapSeconds = opts.historicalMaxIntersegmentGapMinutes * 60;
  const maxSpanSeconds = opts.historicalMaxWorkdaySpanMinutes * 60;
  const days = [];
  let cur = null;

  for (const seg of segments) {
    const fin = seg.out ? seg.out.abs : seg.in.abs;

    if (cur && !cur.abierta) {
      const gap = seg.in.abs - cur.lastAbs;
      const span = fin - cur.startAbs;
      if (gap >= 0 && gap <= maxGapSeconds && span <= maxSpanSeconds) {
        cur.gaps.push(gap);
        cur.segments.push(seg);
        cur.lastAbs = fin;
        cur.abierta = seg.open;
        continue;
      }
      // La cadena se corta por exceso de duración, no por la pausa: es una
      // señal de marcajes sucios y merece quedar registrada.
      if (gap >= 0 && gap <= maxGapSeconds && span > maxSpanSeconds) {
        cur.excedida = true;
      }
    }

    cur = {
      work_date: seg.in.date,
      startAbs: seg.in.abs,
      lastAbs: fin,
      abierta: seg.open,
      segments: [seg],
      gaps: [],
    };
    days.push(cur);
  }

  return days;
}

// ─────────────────────────────────────────────────────────────────────
// Descansos
// ─────────────────────────────────────────────────────────────────────

/**
 * Minutos de descanso a descontar, según el modo configurado.
 *
 *   'none'          no se descuenta nada.
 *   'fixed_unpaid'  se descuenta un fijo, pero NUNCA más de lo trabajado:
 *                   descontar 60 min de una jornada de 40 daría negativo.
 *                   Sólo se aplica si la jornada supera `breakAfterMinutes`
 *                   (0 = siempre), para no castigar medias jornadas.
 *   'punched'       el descanso es el que se marcó: la suma de las pausas
 *                   entre tramos. No se descuenta de nuevo, ya está fuera de
 *                   la suma de tramos; se informa para que el reporte pueda
 *                   mostrar permanencia y trabajo por separado.
 */
function breakMinutesFor({ mode, fixedBreakMinutes, breakAfterMinutes, gapMinutes, segmentMinutes }) {
  if (mode === BREAK_FIXED_UNPAID) {
    const umbral = breakAfterMinutes || 0;
    if (segmentMinutes <= umbral) return 0;
    return Math.min(fixedBreakMinutes || 0, segmentMinutes);
  }
  if (mode === BREAK_PUNCHED) return gapMinutes;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────
// Configuración efectiva
// ─────────────────────────────────────────────────────────────────────

/**
 * Configuración vigente para una fecha, a partir del historial.
 *
 * `history` es una lista de tramos `{ valid_from, valid_to, ... }`. Gana el
 * `valid_from` MÁS RECIENTE que cubra la fecha; `valid_to` null significa
 * vigente. Si ninguno cubre la fecha, devuelve null y la jornada cae en
 * `historical_fallback`.
 *
 * Esto es lo que impide aplicar el horario de hoy al historial: una fila de
 * historial con `valid_from = 2026-01-01` NO cubre al 2024-12-01, así que
 * diciembre de 2024 se calcula sin horario y no genera atrasos inventados.
 */
function resolveEffectiveConfig(workDate, history) {
  if (!Array.isArray(history) || !history.length) return null;
  let mejor = null;
  for (const row of history) {
    const desde = row && row.valid_from ? String(row.valid_from).slice(0, 10) : null;
    if (!desde || desde > workDate) continue;
    const hasta = row.valid_to ? String(row.valid_to).slice(0, 10) : null;
    if (hasta && hasta < workDate) continue;
    if (!mejor || desde > mejor.valid_from_iso) mejor = { ...row, valid_from_iso: desde };
  }
  return mejor;
}

// ─────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────

/**
 * Construye las jornadas de UN empleado a partir de sus marcajes.
 *
 * @param {Array}  punches  `{ timestamp, type, id?, source? }`, en cualquier orden.
 * @param {Object} options
 *        - `config`   configuración única para todas las fechas, o
 *        - `history`  tramos con vigencia; se resuelve por `work_date`.
 *        - umbrales de forma (ver DEFAULTS).
 *
 * @returns {{ workdays: Array, warnings: Array }}
 *
 * Cada jornada trae, deliberadamente separados:
 *
 *   `presence_minutes`  primera entrada → última salida. Es lo que
 *                       `daily_summary.worked_minutes` viene guardando
 *                       históricamente: permanencia, con el almuerzo dentro.
 *   `segment_minutes`   suma de los tramos entrada→salida. Es lo que la
 *                       columna "Total" del reporte de Marcadas suma.
 *   `worked_minutes`    `segment_minutes` menos el descanso que corresponda
 *                       descontar según el modo.
 *
 * No son sinónimos y confundirlos es la razón por la que los dos reportes
 * nunca cerraron entre sí. El motor devuelve los tres y cada consumidor elige
 * el que su concepto necesita, en vez de recalcular a su manera.
 */
function buildWorkdays(punches, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { punches: normalized, duplicados } = normalizePunches(punches, opts);
  const { segments, anomalies } = buildSegments(normalized, opts);
  const grupos = groupWorkdays(segments, opts);

  // Las anomalías se reparten entre las jornadas que las contienen, para que
  // cada fila del reporte pueda explicarse sola. Las que no caen dentro de
  // ninguna jornada (una salida huérfana anterior al primer IN) quedan en la
  // lista global: perderlas escondería justamente el caso que hay que revisar.
  const todas = [...duplicados, ...anomalies].sort((a, b) => (a.at < b.at ? -1 : 1));
  const asignadas = new Set();

  const workdays = grupos.map((g) => {
    const cerrados = g.segments.filter((s) => !s.open);
    const segmentSeconds = cerrados.reduce((acc, s) => acc + s.seconds, 0);
    const segmentMinutes = Math.floor(segmentSeconds / 60);
    const gapMinutes = Math.floor(g.gaps.reduce((a, b) => a + b, 0) / 60);

    const primeraEntrada = g.segments[0].in;
    const ultimoCierre = [...g.segments].reverse().find((s) => s.out);
    const ultimaSalida = ultimoCierre ? ultimoCierre.out : null;
    const abierta = g.segments.some((s) => s.open);

    const presenceMinutes = ultimaSalida
      ? Math.floor((ultimaSalida.abs - primeraEntrada.abs) / 60)
      : 0;

    const cfg = options.config
      || resolveEffectiveConfig(g.work_date, options.history)
      || null;
    const mode = cfg ? MODE_CONFIGURED : MODE_HISTORICAL_FALLBACK;

    const breakMode = cfg && cfg.break_mode ? cfg.break_mode : BREAK_PUNCHED;
    const breakMinutes = breakMinutesFor({
      mode: breakMode,
      fixedBreakMinutes: cfg ? cfg.break_minutes : 0,
      breakAfterMinutes: cfg ? cfg.break_after_minutes : 0,
      gapMinutes,
      segmentMinutes,
    });

    // En 'punched' las pausas ya quedaron fuera de la suma de tramos; volver a
    // restarlas las descontaría dos veces.
    const descuento = breakMode === BREAK_FIXED_UNPAID ? breakMinutes : 0;
    const workedMinutes = Math.max(0, segmentMinutes - descuento);

    const desdeAbs = primeraEntrada.abs;
    const hastaAbs = ultimaSalida ? ultimaSalida.abs : primeraEntrada.abs;
    const propias = todas.filter((a) => {
      const w = toWall(a.at);
      if (!w || w.abs < desdeAbs || w.abs > hastaAbs) return false;
      asignadas.add(a);
      return true;
    });
    if (g.excedida) {
      propias.push({ code: ANOMALY.JORNADA_EXCESIVA, at: primeraEntrada.datetime, log_ids: [] });
    }

    const nocturnos = cerrados.reduce((acc, s) => acc + nightSeconds(s.in.abs, s.out.abs, opts), 0);

    const jornada = {
      work_date: g.work_date,
      mode,
      calculation_mode: mode,
      calculation_source: cfg ? (cfg.source || 'schedule_history') : 'attendance_logs',
      policy_version: POLICY_VERSION,

      first_in: primeraEntrada.datetime,
      first_in_hhmm: primeraEntrada.hhmm,
      last_out: ultimaSalida ? ultimaSalida.datetime : null,
      last_out_hhmm: ultimaSalida ? ultimaSalida.hhmm : '',
      crosses_midnight: !!(ultimaSalida && ultimaSalida.date !== g.work_date),
      open: abierta,

      segments: g.segments.map((s) => ({
        in: s.in.datetime,
        in_hhmm: s.in.hhmm,
        out: s.out ? s.out.datetime : null,
        out_hhmm: s.out ? s.out.hhmm : '',
        minutes: Math.floor(s.seconds / 60),
        open: s.open,
        // Trazabilidad hasta las filas originales de attendance_logs, para que
        // cualquier total del reporte pueda reconstruirse fila por fila.
        source_logs: [...s.in.logIds, ...(s.out ? s.out.logIds : [])],
      })),

      presence_minutes: presenceMinutes,
      segment_minutes: segmentMinutes,
      worked_minutes: workedMinutes,
      break_minutes: breakMinutes,
      break_mode: breakMode,
      gap_minutes: gapMinutes,

      // Reparto diurno/nocturno de los tramos cerrados. El recargo nocturno es
      // una regla legal y NO se aplica acá: el motor sólo mide cuántos minutos
      // cayeron en la franja configurada y deja la valorización a quien tenga
      // la política.
      night_minutes: Math.floor(nocturnos / 60),
      day_minutes: Math.max(0, segmentMinutes - Math.floor(nocturnos / 60)),

      late_minutes: null,
      early_leave_minutes: null,
      scheduled_minutes: null,
      contract_target_minutes: cfg && cfg.daily_target_minutes != null
        ? cfg.daily_target_minutes
        : null,
      contract_excess_minutes: null,

      schedule_id: cfg && cfg.schedule_id != null ? cfg.schedule_id : null,
      shift_schedule_id: cfg && cfg.shift_schedule_id != null ? cfg.shift_schedule_id : null,
      contract_id: cfg && cfg.contract_id != null ? cfg.contract_id : null,
      work_profile_id: cfg && cfg.work_profile_id != null ? cfg.work_profile_id : null,
      weekly_target_minutes: cfg && cfg.weekly_target_minutes != null
        ? cfg.weekly_target_minutes
        : null,

      anomalies: propias,
    };

    if (mode === MODE_CONFIGURED) aplicarConfiguracion(jornada, cfg, primeraEntrada, ultimaSalida);
    return jornada;
  });

  return {
    workdays,
    // Anomalías que no cayeron dentro de ninguna jornada.
    anomalies: todas.filter((a) => !asignadas.has(a)),
  };
}

/**
 * Segundos del tramo que caen en la franja nocturna configurada.
 *
 * La franja se expresa en minutos del día y puede cruzar la medianoche
 * (20:00→06:00 es lo habitual). El cálculo recorre día por día en aritmética
 * de pared, sin zonas horarias, así que un tramo que abarca dos madrugadas
 * suma las dos.
 *
 * Devuelve 0 si no hay franja configurada: sin definición explícita no hay
 * "nocturno", y suponer una sería introducir una regla laboral por la ventana.
 */
function nightSeconds(desdeAbs, hastaAbs, opts) {
  const desde = opts.nightStartMinute;
  const hasta = opts.nightEndMinute;
  if (desde == null || hasta == null || desde === hasta) return 0;

  let total = 0;
  const primerDia = Math.floor(desdeAbs / 86400) * 86400;
  const ultimoDia = Math.floor(hastaAbs / 86400) * 86400;

  for (let dia = primerDia - 86400; dia <= ultimoDia; dia += 86400) {
    // Una franja que cruza medianoche se parte en dos ventanas por día.
    const ventanas = desde < hasta
      ? [[dia + desde * 60, dia + hasta * 60]]
      : [[dia + desde * 60, dia + 86400], [dia, dia + hasta * 60]];
    for (const [a, b] of ventanas) {
      const ini = Math.max(a, desdeAbs);
      const fin = Math.min(b, hastaAbs);
      if (fin > ini) total += fin - ini;
    }
  }
  return total;
}

/**
 * Atraso, salida anticipada y jornada esperada, sólo en modo 'configured'.
 *
 * El atraso se calcula con `dailySummaryCalc.lateMinutes`, que ya resuelve el
 * cruce de medianoche en hora de pared de forma asimétrica. Reutilizarlo evita
 * tener dos definiciones de "llegó tarde" en el mismo sistema.
 */
function aplicarConfiguracion(jornada, cfg, primeraEntrada, ultimaSalida) {
  const entradaPrevista = calc.scheduleSeconds(cfg.check_in);
  const salidaPrevista = calc.scheduleSeconds(cfg.check_out);

  if (entradaPrevista != null) {
    jornada.late_minutes = calc.lateMinutes({
      firstInSeconds: primeraEntrada.secondsOfDay,
      checkInSeconds: entradaPrevista,
      toleranceMin: cfg.tolerance_in || 0,
    });
  }

  if (salidaPrevista != null && ultimaSalida) {
    const tolerancia = (cfg.tolerance_out || 0) * 60;
    const d = calc.wallDelta(ultimaSalida.secondsOfDay, salidaPrevista - tolerancia);
    jornada.early_leave_minutes = d > 0 ? Math.floor(d / 60) : 0;
  }

  if (entradaPrevista != null && salidaPrevista != null) {
    const bruto = calc.wallDelta(entradaPrevista, salidaPrevista);
    const esperado = bruto > 0 ? Math.floor(bruto / 60) : 0;
    const descuento = cfg.break_mode === BREAK_FIXED_UNPAID ? (cfg.break_minutes || 0) : 0;
    jornada.scheduled_minutes = Math.max(0, esperado - descuento);
  }

  // Objetivo del día: el del contrato si está cargado, si no el del horario.
  if (jornada.contract_target_minutes == null && jornada.scheduled_minutes != null) {
    jornada.contract_target_minutes = jornada.scheduled_minutes;
  }

  // EXCESO SOBRE EL OBJETIVO — no es "hora extra legal".
  //
  // Trabajar 39 h contra un objetivo de 36 da 3 h de exceso, y eso es un hecho
  // medible. Si esas 3 h se liquidan como extraordinarias, al 50 %, o se
  // compensan con descanso, es una decisión de política y de convenio que este
  // motor NO toma. Llamarlo `overtime` acá sería decidirla por omisión.
  if (jornada.contract_target_minutes != null) {
    jornada.contract_excess_minutes = Math.max(
      0,
      jornada.worked_minutes - jornada.contract_target_minutes,
    );
  }
}

/**
 * Recorta las jornadas al período pedido por el reporte.
 *
 * El límite se aplica sobre `work_date`, NO sobre la fecha civil de cada
 * marcaje. Es la diferencia entre "las jornadas de diciembre" y "las marcas de
 * diciembre": un turno que entra el 31/12 a las 22:00 y sale el 01/01 a las
 * 06:00 es una jornada de diciembre completa, y cortarla por fecha de marca la
 * partiría al medio y perdería 6 horas.
 *
 * Para que la jornada del borde inferior esté COMPLETA, el llamador tiene que
 * haber leído marcajes desde antes de `from` (ver `punchWindow`).
 */
function clipToPeriod(workdays, { from, to }) {
  return workdays.filter((w) => {
    if (from && w.work_date < from) return false;
    if (to && w.work_date > to) return false;
    return true;
  });
}

/**
 * Ventana de marcajes a leer para cubrir el período `[from, to]` completo.
 *
 * Se extiende hacia atrás y hacia adelante lo suficiente como para que ninguna
 * jornada del período quede truncada:
 *
 *   - hacia atrás: una jornada del día anterior a `from` puede terminar dentro
 *     de `from`; sin ese margen su salida aparecería como huérfana.
 *   - hacia adelante: la jornada del último día puede cerrar al día siguiente.
 *
 * El margen es `historicalMaxWorkdaySpanMinutes` redondeado a días enteros,
 * sigue siendo sargable sobre `idx_emp_ts` con un rango de DATETIME.
 */
function punchWindow({ from, to }, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const dias = Math.max(1, Math.ceil(opts.historicalMaxWorkdaySpanMinutes / (24 * 60)));
  const desde = toWall(`${from} 00:00:00`);
  const hasta = toWall(`${to} 00:00:00`);
  if (!desde || !hasta) throw new Error(`Rango inválido para la ventana de marcajes: ${from}..${to}`);
  return {
    // Inclusivo por abajo, EXCLUSIVO por arriba: `timestamp >= ? AND < ?`.
    from: absToDateTime(desde.abs - dias * 86400),
    to: absToDateTime(hasta.abs + (dias + 1) * 86400),
  };
}

module.exports = {
  buildWorkdays,
  clipToPeriod,
  punchWindow,
  resolveEffectiveConfig,
  normalizePunches,
  buildSegments,
  groupWorkdays,
  breakMinutesFor,
  effectiveType,
  toWall,
  absToDateISO,
  absToHHmm,
  absToDateTime,
  dayOfWeekISO,
  minutesToHM,
  nightSeconds,
  DEFAULTS,
  ANOMALY,
  POLICY_VERSION,
  MODE_HISTORICAL_FALLBACK,
  MODE_CONFIGURED,
  BREAK_NONE,
  BREAK_FIXED_UNPAID,
  BREAK_PUNCHED,
};
