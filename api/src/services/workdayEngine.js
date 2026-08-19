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
 * Parámetros por defecto.
 *
 * NINGUNO codifica una regla legal. Son umbrales de FORMA de la jornada
 * (cuánto puede durar un tramo, cuánta pausa sigue siendo la misma jornada)
 * y todos se pueden sobreescribir por llamada y, aguas arriba, por
 * configuración persistida. Las 48 h semanales paraguayas NO están acá: el
 * objetivo semanal es un dato de configuración y su ausencia no inventa uno.
 */
const DEFAULTS = Object.freeze({
  /** Un tramo entrada→salida más largo que esto no es un tramo: es una salida
   *  que nunca se marcó. 16 h cubre turnos de 12 h con horas extra. */
  maxSegmentMinutes: 16 * 60,

  /** Pausa entre la salida de un tramo y la entrada del siguiente que todavía
   *  cuenta como la MISMA jornada (almuerzo, descanso partido). Por encima de
   *  esto empieza una jornada nueva. 4 h separa un turno partido de dos
   *  turnos distintos del mismo día. */
  maxGapMinutes: 4 * 60,

  /** Tope de duración total de una jornada, primera entrada → última salida.
   *  Impide que una cadena de marcajes sucios encadene días enteros. */
  maxSpanMinutes: 20 * 60,

  /** Marcajes dentro de esta ventana son el mismo fichaje repetido por el
   *  reloj. Es el criterio que ya usaba el reporte de Marcadas. */
  dedupeSeconds: 60,

  /** `true` = el `type` explícito manda; `unknown` cae en alternancia. */
  typeAware: true,
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
 * Ordena, descarta lo ilegible y colapsa repeticiones del reloj.
 *
 * La deduplicación conserva el PRIMER marcaje de la ráfaga —igual que el
 * reporte actual— pero rescata el primer tipo explícito que aparezca en ella:
 * si el reloj emite `unknown` a las 08:00:00 e `in` a las 08:00:02, la
 * jornada se queda con 08:00:00 tipo `in`. Perder ese tipo sería volver a la
 * alternancia sin necesidad.
 */
function normalizePunches(punches, opts) {
  const dedupeSeconds = opts.dedupeSeconds;
  const parsed = [];

  for (const p of punches || []) {
    const raw = p && (p.timestamp !== undefined ? p.timestamp : p.ts);
    const wall = toWall(raw);
    if (!wall) continue;
    parsed.push({
      abs: wall.abs,
      date: wall.date,
      secondsOfDay: wall.secondsOfDay,
      type: effectiveType(p.type),
      datetime: absToDateTime(wall.abs),
      hhmm: absToHHmm(wall.abs),
      source: p.source || null,
      id: p.id != null ? p.id : null,
    });
  }

  parsed.sort((a, b) => (a.abs - b.abs) || ((a.id || 0) - (b.id || 0)));

  const out = [];
  for (const p of parsed) {
    const prev = out[out.length - 1];
    if (prev && p.abs - prev.abs <= dedupeSeconds) {
      if (prev.type === 'unknown' && p.type !== 'unknown') prev.type = p.type;
      prev.duplicates = (prev.duplicates || 0) + 1;
      continue;
    }
    out.push(p);
  }
  return out;
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
  const warnings = [];
  const maxSegmentSeconds = opts.maxSegmentMinutes * 60;
  let open = null;

  const cerrarAbierto = (motivo) => {
    segments.push({ in: open, out: null, seconds: 0, open: true });
    warnings.push({ code: motivo, at: open.datetime });
    open = null;
  };

  for (const p of punches) {
    const tipo = opts.typeAware ? p.type : 'unknown';

    if (!open) {
      if (tipo === 'out') {
        // Salida sin entrada: puede ser el cierre de una jornada que empezó
        // antes de la ventana consultada. Se anota y NO se inventa entrada.
        warnings.push({ code: 'salida_huerfana', at: p.datetime });
        continue;
      }
      open = p;
      continue;
    }

    if (tipo === 'in') {
      // Segunda entrada con un tramo abierto: el reloj perdió la salida.
      cerrarAbierto('salida_faltante');
      open = p;
      continue;
    }

    const dur = p.abs - open.abs;
    if (dur > maxSegmentSeconds) {
      // Demasiado largo para ser un tramo real: la salida nunca se marcó y
      // este marcaje pertenece a otra jornada.
      cerrarAbierto('salida_faltante');
      if (tipo === 'out') {
        warnings.push({ code: 'salida_huerfana', at: p.datetime });
      } else {
        open = p;
      }
      continue;
    }

    segments.push({ in: open, out: p, seconds: dur, open: false });
    open = null;
  }

  if (open) cerrarAbierto('salida_faltante');
  return { segments, warnings };
}

// ─────────────────────────────────────────────────────────────────────
// Agrupación en jornadas
// ─────────────────────────────────────────────────────────────────────

/**
 * Encadena tramos en jornadas.
 *
 * Un tramo continúa la jornada anterior si la pausa desde el cierre previo no
 * supera `maxGapMinutes` Y la jornada resultante no excede `maxSpanMinutes`.
 * En cualquier otro caso abre una jornada nueva.
 *
 * Un tramo ABIERTO (sin salida) cierra la cadena: no se puede medir la pausa
 * que le sigue, así que el marcaje siguiente empieza jornada nueva en vez de
 * encadenarse sobre un dato que no existe.
 */
function groupWorkdays(segments, opts) {
  const maxGapSeconds = opts.maxGapMinutes * 60;
  const maxSpanSeconds = opts.maxSpanMinutes * 60;
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
  const normalized = normalizePunches(punches, opts);
  const { segments, warnings } = buildSegments(normalized, opts);
  const grupos = groupWorkdays(segments, opts);

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

    const jornada = {
      work_date: g.work_date,
      mode,
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
      })),
      presence_minutes: presenceMinutes,
      segment_minutes: segmentMinutes,
      worked_minutes: workedMinutes,
      break_minutes: breakMinutes,
      break_mode: breakMode,
      gap_minutes: gapMinutes,
      late_minutes: null,
      early_leave_minutes: null,
      expected_minutes: null,
      schedule_id: cfg ? (cfg.schedule_id != null ? cfg.schedule_id : null) : null,
      weekly_target_minutes: cfg && cfg.weekly_target_minutes != null
        ? cfg.weekly_target_minutes
        : null,
    };

    if (mode === MODE_CONFIGURED) aplicarConfiguracion(jornada, cfg, primeraEntrada, ultimaSalida);
    return jornada;
  });

  return { workdays, warnings };
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
    jornada.expected_minutes = Math.max(0, esperado - descuento);
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
 * El margen es `maxSpanMinutes` redondeado a días enteros, así la consulta
 * sigue siendo sargable sobre `idx_emp_ts` con un rango de DATETIME.
 */
function punchWindow({ from, to }, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const dias = Math.max(1, Math.ceil(opts.maxSpanMinutes / (24 * 60)));
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
  minutesToHM,
  DEFAULTS,
  MODE_HISTORICAL_FALLBACK,
  MODE_CONFIGURED,
  BREAK_NONE,
  BREAK_FIXED_UNPAID,
  BREAK_PUNCHED,
};
