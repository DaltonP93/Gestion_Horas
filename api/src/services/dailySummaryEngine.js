/**
 * dailySummaryEngine.js — `daily_summary` como materialización del motor.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUÉ PROBLEMA CIERRA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `daily_summary` se calculaba con SU PROPIO algoritmo: los marcajes de una
 * fecha civil, primera entrada, última salida. El reporte de Marcadas usaba
 * otro. Dos algoritmos distintos sobre los mismos datos dan dos respuestas
 * distintas, y ninguna de las dos se puede declarar la correcta.
 *
 * Este módulo convierte la salida del motor en la fila de `daily_summary`.
 * A partir de acá el resumen diario es una MATERIALIZACIÓN del motor —una
 * caché consultable— y no un segundo cálculo.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SEMÁNTICA DE `worked_minutes` — LA DECISIÓN QUE IMPORTA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * La columna `daily_summary.worked_minutes` viene guardando PERMANENCIA:
 * primera entrada a última salida, con el almuerzo adentro. El motor llama a
 * eso `presence_minutes`, y su `worked_minutes` es otra cosa (tramos menos
 * descanso).
 *
 * Este módulo NO cambia el significado de la columna por su cuenta. Expone las
 * dos y deja la elección explícita en `workedMinutesMode`:
 *
 *   'presence'  (por defecto)  conserva la semántica histórica. Un recálculo
 *               no reescribe el pasado con otra definición.
 *   'worked'    pasa la columna a tiempo trabajado neto. Cambia el significado
 *               de datos ya emitidos y por eso es una decisión de negocio, no
 *               un detalle de implementación.
 *
 * Cambiar esto en silencio movería todos los números históricos de RRHH sin
 * que nadie lo hubiera pedido.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ESTE MÓDULO NO ESCRIBE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Es puro: recibe marcajes y configuración, devuelve filas. Quien escriba
 * —el recálculo, cuando se habilite— lo hace afuera. Así el dry-run usa
 * exactamente el mismo código que usaría la escritura, que es la única forma
 * de que la comparación signifique algo.
 */

'use strict';

const engine = require('./workdayEngine');

/** Cómo se llena `daily_summary.worked_minutes`. */
const WORKED_PRESENCE = 'presence';
const WORKED_NET = 'worked';

/**
 * Estados que emite el motor.
 *
 * Los primeros seis existen en el ENUM de `daily_summary`. Los dos últimos NO:
 *
 *   'non_working'   día de descanso por CONFIGURACIÓN, no por ser sábado o
 *                   domingo. Puede caer un martes.
 *   'unconfigured'  no hay configuración histórica ni marcajes: no sabemos si
 *                   la persona debía trabajar. NO es ausencia.
 *
 * Persistir estos dos requiere una migración aditiva del ENUM (ver
 * docs/motor-jornada.md, §día vacío). Este PR NO la ejecuta: el motor los
 * emite para el dry-run y para la FASE C, pero `daily_summary` no se escribe.
 */
const STATUS = Object.freeze({
  PRESENT: 'present',
  LATE: 'late',
  ABSENT: 'absent',
  HOLIDAY: 'holiday',
  PERMISSION: 'permission',
  WEEKEND: 'weekend',
  NON_WORKING: 'non_working',
  UNCONFIGURED: 'unconfigured',
});

/**
 * ¿La persona DEBÍA trabajar esa fecha? true | false | null.
 *
 * Sale de la CONFIGURACIÓN EFECTIVA, nunca de que sea sábado o domingo:
 * SisHoras tiene gente que trabaja domingo, descansa un día de semana o rota
 * por Turnera. Hardcodear el fin de semana fabricaría descansos y ausencias
 * que la configuración contradice.
 *
 *   true   hay evidencia de que debía trabajar (turnera de trabajo, o el
 *          horario vigente incluye ese día de la semana).
 *   false  la configuración dice que era libre (off/vacaciones/permiso, o el
 *          horario excluye ese día).
 *   null   no hay configuración suficiente. NO se puede afirmar ausencia.
 *
 * `work_days` usa la convención DAYOFWEEK del proyecto (1=Domingo … 7=Sábado,
 * migración 046); `dayOfWeekISO` devuelve 0=Domingo, así que se suma 1.
 */
function resolveExpectation(cfg, date) {
  if (!cfg) return { expected: null, kind: null };

  if (cfg.non_working) {
    return { expected: false, kind: cfg.kind || 'off' };
  }
  if (cfg.source === 'shift_assignment') {
    // Asignación de turnera de trabajo para esa fecha exacta.
    return { expected: true, kind: 'work' };
  }
  if (Array.isArray(cfg.work_days) && cfg.work_days.length) {
    const dow = engine.dayOfWeekISO(date) + 1; // JS 0=Dom → DAYOFWEEK 1=Dom
    return cfg.work_days.includes(dow)
      ? { expected: true, kind: 'work' }
      : { expected: false, kind: 'rest_day' };
  }
  // Hay algo de configuración pero sin work_days (p. ej. una fila de historial
  // que declara "sin horario"): no sabemos qué días correspondían. Conservador:
  // desconocido, para no inventar ni ausencia ni descanso.
  return { expected: null, kind: null };
}

/**
 * Estado de un día CON jornada (hubo marcajes).
 *
 * Trabajar un feriado cuenta como trabajado: el feriado se refleja en las
 * horas extra, no en el estado. Se conserva el criterio previo.
 */
function statusWorked(jornada) {
  if (jornada.non_working_kind === 'vacation' || jornada.non_working_kind === 'permiso') {
    return STATUS.PERMISSION;
  }
  return (jornada.late_minutes || 0) > 0 ? STATUS.LATE : STATUS.PRESENT;
}

/**
 * Estado de un día SIN jornada (no hubo marcajes).
 *
 * El feriado se evalúa ANTES que la ausencia a propósito: un feriado nacional
 * cae en día laborable, y marcar `absent` a todo el padrón cada feriado sería
 * fabricar exactamente las ausencias masivas que el modelo quiere evitar. El
 * dato de si "debía trabajar" no se pierde: viaja aparte en `expected_workday`.
 */
function statusEmptyDay(expectation, isHoliday) {
  if (expectation.kind === 'vacation' || expectation.kind === 'permiso') {
    return STATUS.PERMISSION;
  }
  if (isHoliday) return STATUS.HOLIDAY;
  if (expectation.expected === false) return STATUS.NON_WORKING;
  if (expectation.expected === true) return STATUS.ABSENT;
  return STATUS.UNCONFIGURED; // expected === null
}

/**
 * Compat: firma vieja usada por algunos tests. `isWeekend` se ignora
 * deliberadamente —el fin de semana ya no decide el estado— y se traduce a la
 * semántica nueva de expectativa.
 */
function statusDe({ jornada, isHoliday = false, isWeekend = false }) {
  if (jornada) return statusWorked(jornada);
  // Sin expectativa explícita: un weekend legacy se trata como no laborable
  // conocido; en cualquier otro caso, ausencia (comportamiento previo del test).
  const expectation = isWeekend ? { expected: false, kind: 'rest_day' } : { expected: true, kind: 'work' };
  return statusEmptyDay(expectation, isHoliday);
}

/**
 * Filas de `daily_summary` para UN empleado, derivadas del motor.
 *
 * @param {Array}  punches   marcajes de la VENTANA (no de la fecha civil): un
 *                           turno nocturno cierra al día siguiente, así que
 *                           leer sólo el día perdería su salida.
 * @param {Object} options
 *        - `from` / `to`          período a materializar.
 *        - `resolveConfig`        resolvedor de configuración por fecha.
 *        - `holidays`             Set de fechas 'YYYY-MM-DD'.
 *        - `workedMinutesMode`    ver arriba. Por defecto 'presence'.
 *        - `materializeEmptyDates` emitir fila para las fechas SIN jornada
 *                                  (absent/holiday/weekend). Por defecto true.
 *
 * @returns {Array} filas listas para comparar o escribir, una por fecha civil
 *          del período. Las fechas sin marcajes NO se omiten: `daily_summary`
 *          guarda deliberadamente filas `absent`/`holiday`/`weekend`, y un
 *          recálculo que las omitiera las borraría, además de hacer que el
 *          dry-run marque cada una de esas filas guardadas como diferencia.
 */
function buildDailySummaryRows(punches, options = {}) {
  const {
    from, to,
    holidays = new Set(),
    workedMinutesMode = WORKED_PRESENCE,
    materializeEmptyDates = true,
  } = options;

  const { workdays, anomalies } = engine.buildWorkdays(punches, options);
  const delPeriodo = engine.clipToPeriod(workdays, { from, to });

  // Fichajes sueltos por fecha: los que NO formaron jornada (una salida sin
  // entrada como único registro del día). Sin esto, buildWorkdays no genera
  // jornada, la fecha cae en la rama de "día vacío" y se materializa como
  // 'absent' —una ausencia engañosa que oculta que sí hubo un fichaje—. Se
  // agrupan por la fecha civil del marcaje, acotadas al período.
  const punchById = new Map();
  for (const p of (punches || [])) {
    const id = p.id != null ? p.id : (p.attendance_log_id != null ? p.attendance_log_id : null);
    if (id != null) punchById.set(id, p);
  }
  const huerfanasPorFecha = new Map();
  for (const a of anomalies) {
    if (typeof a === 'string' || !Array.isArray(a.log_ids)) continue;
    const src = a.log_ids.map((id) => punchById.get(id)).find(Boolean);
    const at = src ? (src.timestamp || src.ts) : a.at;
    const fecha = at ? String(at).slice(0, 10) : null;
    if (!fecha || fecha < from || fecha > to) continue;
    const arr = huerfanasPorFecha.get(fecha) || [];
    arr.push({ code: a.code, src });
    huerfanasPorFecha.set(fecha, arr);
  }

  // Configuración efectiva por fecha, también para las fechas SIN jornada:
  // sin esto, un día de vacaciones o un domingo libre sin marcajes nunca vería
  // su configuración y terminaría materializado como ausencia.
  const cfgFor = (date) => options.config
    || (typeof options.resolveConfig === 'function' ? options.resolveConfig(date) : null)
    || null;

  // TODAS las jornadas de cada fecha, no sólo la primera. Dos jornadas reales
  // del mismo día —06:00-10:00 y 16:00-20:00, separadas por más de la pausa
  // máxima— comparten work_date, y descartar una perdería sus horas.
  const porFecha = new Map();
  for (const j of delPeriodo) {
    const arr = porFecha.get(j.work_date) || [];
    arr.push(j);
    porFecha.set(j.work_date, arr);
  }

  const filas = [];
  for (const date of fechasDelPeriodo(from, to)) {
    const isHoliday = holidays.has(date);
    const cfg = cfgFor(date);
    const expectation = resolveExpectation(cfg, date);
    const lista = porFecha.get(date);

    if (!lista || !lista.length) {
      if (!materializeEmptyDates) continue;
      filas.push(filaDiaSinJornada(date, expectation, cfg, isHoliday, huerfanasPorFecha.get(date) || []));
      continue;
    }

    // Una sola jornada, o la agregación determinista de varias del mismo día.
    const j = lista.length === 1 ? lista[0] : aggregateWorkdays(lista);
    const anomalyCodes = j.anomalies.map((a) => (typeof a === 'string' ? a : a.code));

    filas.push({
      date,
      first_in: j.first_in,
      last_out: j.last_out,
      worked_minutes: workedMinutesMode === WORKED_NET
        ? j.worked_minutes
        : j.presence_minutes,
      // Se conservan las dos para que la comparación pueda explicar una
      // diferencia sin volver a calcular nada.
      presence_minutes: j.presence_minutes,
      net_worked_minutes: j.worked_minutes,
      break_minutes: j.break_minutes,
      late_minutes: j.late_minutes || 0,
      // El motor mide exceso sobre el objetivo, no hora extra legal. Volcarlo
      // a `overtime_minutes` sin una política cargada convertiría una medición
      // en una liquidación; queda en 0 hasta que exista esa política.
      overtime_minutes: 0,
      contract_excess_minutes: j.contract_excess_minutes,
      status: statusWorked(j),
      // Debía trabajar o no, independiente del estado: un feriado trabajado es
      // 'present' pero `expected_workday` puede ser true.
      expected_workday: expectation.expected,
      schedule_id: j.schedule_id,
      calculation_mode: j.calculation_mode,
      policy_version: j.policy_version,
      anomalies: anomalyCodes,
      workday_count: lista.length,
      crosses_midnight: j.crosses_midnight,
    });
  }
  return filas;
}

/**
 * Agrega varias jornadas de la MISMA fecha civil en una fila determinista.
 *
 * `daily_summary` es una fila por empleado y fecha, así que dos jornadas del
 * mismo día tienen que combinarse sin perder ninguna. La regla:
 *
 *   first_in         primera entrada de todas.
 *   last_out         última salida de todas.
 *   presence_minutes SPAN total del día (primera entrada → última salida),
 *                    coherente con lo que la columna guarda; incluye el hueco
 *                    entre jornadas, que es lo que de verdad transcurrió.
 *   segment/worked/  SUMA: no se pierde ningún tramo.
 *   break/night/day
 *   late_minutes     de la PRIMERA jornada: el atraso es sobre la llegada del
 *                    día, no algo que se sume por jornada.
 *
 * Se marca con la anomalía MULTIPLE_WORKDAYS_SAME_DATE para que el caso quede
 * visible y revisable en vez de agregarse en silencio.
 */
function aggregateWorkdays(lista) {
  const ordenadas = [...lista].sort((a, b) => (a.first_in < b.first_in ? -1 : 1));
  const primera = ordenadas[0];

  // La permanencia se mide SÓLO sobre las jornadas cerradas (con salida). Una
  // jornada abierta —entrada sin salida— no aporta tiempo, así que ni su
  // entrada puede anclar el inicio del span ni su falta de salida cortarlo:
  //   · si la más TEMPRANA está abierta (06:00 suelto + 18:00-22:00), tomar su
  //     06:00 inflaría el span a 16 h cuando la permanencia real son 4;
  //   · si la más TARDÍA está abierta (06:00-10:00 + 16:00 suelto), tomar su
  //     salida null colapsaría la permanencia a 0.
  const cerradas = ordenadas.filter((j) => j.last_out);

  // Primera entrada del span: la de la jornada cerrada más temprana. Si NINGUNA
  // cerró, no hay permanencia que medir; se conserva la entrada suelta sólo
  // para que la fila muestre el marcaje huérfano (presence 0, sin salida).
  const inRef = cerradas.length ? cerradas[0] : primera;

  // Última salida: la más tardía entre las jornadas cerradas.
  let lastOut = null;
  let outWall = null;
  for (const j of cerradas) {
    const w = engine.toWall(j.last_out);
    if (w && (!outWall || w.abs > outWall.abs)) {
      outWall = w;
      lastOut = j.last_out;
    }
  }

  const inWall = engine.toWall(inRef.first_in);
  const presence = (inWall && outWall)
    ? Math.max(0, Math.floor((outWall.abs - inWall.abs) / 60))
    : 0;

  const sum = (campo) => ordenadas.reduce((acc, j) => acc + (j[campo] || 0), 0);
  const codes = new Set();
  for (const j of ordenadas) for (const a of j.anomalies) codes.add(typeof a === 'string' ? a : a.code);
  codes.add(engine.ANOMALY.MULTIPLE_WORKDAYS_SAME_DATE);

  return {
    work_date: primera.work_date,
    // first_in y late se leen de la jornada que ancla el span (la cerrada más
    // temprana), no de una entrada abierta que no aporta permanencia; así
    // first_in, last_out y presence quedan coherentes entre sí.
    first_in: inRef.first_in,
    last_out: lastOut,
    presence_minutes: presence,
    segment_minutes: sum('segment_minutes'),
    worked_minutes: sum('worked_minutes'),
    break_minutes: sum('break_minutes'),
    late_minutes: inRef.late_minutes || 0,
    night_minutes: sum('night_minutes'),
    day_minutes: sum('day_minutes'),
    // El exceso contractual se deriva del objetivo diario contra el total; con
    // dos jornadas la resta cambia y no se puede sumar sin arrastrar el
    // objetivo dos veces. Se deja en null: la anomalía marca que hay que
    // revisar cómo se valoriza, en vez de dar un número que parece cerrado.
    contract_excess_minutes: null,
    crosses_midnight: ordenadas.some((j) => j.crosses_midnight),
    schedule_id: primera.schedule_id,
    calculation_mode: primera.calculation_mode,
    policy_version: primera.policy_version,
    non_working_kind: primera.non_working_kind,
    anomalies: [...codes],
  };
}

/**
 * Fila de una fecha sin jornada computable.
 *
 * El caso base es el día vacío (sin marcas): sale de `filaVacia`. Pero una fecha
 * puede no tener jornada y aun así tener un FICHAJE SUELTO —una salida sin
 * entrada como único registro—. Ese día NO es una ausencia limpia: hubo marca.
 * Materializar 'absent' ahí ocultaría el fichaje y una escritura futura
 * produciría una ausencia engañosa.
 *
 * Cuando hay huérfanas se conserva SIEMPRE la hora del fichaje suelto como
 * evidencia, CUALQUIERA sea la clasificación del día vacío: si no, un OUT
 * huérfano en un feriado, un descanso configurado o un día sin config
 * desaparecería del resumen (los bounds quedarían en null y el writer no
 * persiste las anomalías). Se marca `calculation_mode` para que el dry-run lo
 * compare en vez de descartarlo como día vacío.
 *
 * Además, un día que iba a clasificarse como AUSENCIA o DESCONOCIDO pero que TUVO
 * actividad no es eso: la persona marcó algo. Se reinterpreta como 'present' con
 * cero minutos —igual que una jornada abierta—. Un feriado o descanso conserva
 * su clase (la marca queda registrada y señalada por la anomalía).
 */
function filaDiaSinJornada(date, expectation, cfg, isHoliday, huerfanas) {
  const status0 = statusEmptyDay(expectation, isHoliday);
  const fila = filaVacia(date, status0, expectation, cfg);
  if (!huerfanas.length) return fila;

  const codigos = huerfanas.map((h) => h.code);
  fila.anomalies = [...new Set([...(fila.anomalies || []), ...codigos])];

  // Horas del fichaje suelto — SIEMPRE, sin importar el estado del día.
  const ts = (h) => (h.src ? String(h.src.timestamp || h.src.ts || '') : '');
  const ins = huerfanas.filter((h) => h.src && h.src.type === 'in').map(ts).filter(Boolean).sort();
  const outs = huerfanas.filter((h) => h.src && h.src.type === 'out').map(ts).filter(Boolean).sort();
  fila.first_in = ins.length ? ins[0] : null;
  fila.last_out = outs.length ? outs[outs.length - 1] : null;
  fila.calculation_mode = engine.MODE_HISTORICAL_FALLBACK;
  fila.policy_version = engine.POLICY_VERSION;

  // Ausencia o desconocido CON actividad → presente (0 minutos). El feriado o el
  // descanso configurado conservan su clasificación.
  if (status0 === STATUS.ABSENT || status0 === STATUS.UNCONFIGURED) {
    fila.status = STATUS.PRESENT;
  }
  return fila;
}

/** Fila de un día sin jornada: ceros, el estado y la expectativa que corresponda. */
function filaVacia(date, status, expectation, cfg) {
  // Un día sin marcajes igual puede arrastrar un conflicto de turnera: hubo dos
  // turneras publicadas para esa fecha y el resolvedor eligió una (a veces un
  // `off` de menor id sobre un `work` de mayor id). Sin jornada no pasa por el
  // motor, así que la anomalía se propaga acá o se pierde justo en el caso en
  // que más importa —el descanso elegido puede estar tapando un turno de
  // trabajo que nadie fichó—.
  const anomalies = [];
  if (cfg && Array.isArray(cfg.conflict_shift_schedule_ids)
      && cfg.conflict_shift_schedule_ids.length > 1) {
    anomalies.push(engine.ANOMALY.TURNERA_CONFLICT);
  }
  return {
    date,
    first_in: null,
    last_out: null,
    worked_minutes: 0,
    presence_minutes: 0,
    net_worked_minutes: 0,
    break_minutes: 0,
    late_minutes: 0,
    overtime_minutes: 0,
    contract_excess_minutes: null,
    status,
    expected_workday: expectation ? expectation.expected : null,
    schedule_id: cfg && cfg.schedule_id != null ? cfg.schedule_id : null,
    calculation_mode: null,
    policy_version: null,
    anomalies,
    workday_count: 0,
    crosses_midnight: false,
  };
}

/**
 * Fechas civiles 'YYYY-MM-DD' de `from` a `to`, inclusive.
 *
 * Recorre en aritmética de pared (contador de días), sin zonas horarias, así
 * que no se salta ni repite un día en un cambio de horario.
 */
function fechasDelPeriodo(from, to) {
  const desde = engine.toWall(`${from} 00:00:00`);
  const hasta = engine.toWall(`${to} 00:00:00`);
  if (!desde || !hasta || desde.abs > hasta.abs) return [];
  const fechas = [];
  for (let dia = Math.floor(desde.abs / 86400); dia <= Math.floor(hasta.abs / 86400); dia++) {
    fechas.push(engine.absToDateISO(dia * 86400));
  }
  return fechas;
}

/**
 * Compara una fila guardada contra la que produciría el motor.
 *
 * @returns {{ iguales: boolean, difieren: Array<string> }}
 *
 * `null` en el lado guardado significa "el motor ve una jornada que
 * `daily_summary` no tiene", que es distinto de "los minutos no coinciden" y
 * por eso se informa aparte.
 */
function compararFila(guardada, calculada) {
  if (!guardada) return { iguales: false, difieren: ['sin_fila_guardada'] };
  if (!calculada) return { iguales: false, difieren: ['sin_jornada_calculada'] };

  const difieren = [];
  const num = (v) => (v == null ? null : Number(v));

  if (num(guardada.worked_minutes) !== num(calculada.worked_minutes)) difieren.push('worked_minutes');
  if (num(guardada.late_minutes) !== num(calculada.late_minutes)) difieren.push('late_minutes');
  if (num(guardada.break_minutes) !== num(calculada.break_minutes)) difieren.push('break_minutes');
  if (String(guardada.status || '') !== String(calculada.status || '')) difieren.push('status');

  // Las horas se comparan a nivel de minuto: `daily_summary` guarda DATETIME y
  // los segundos no aportan a la comparación, pero sí generarían ruido.
  const hhmm = (v) => (v == null ? null : String(v).slice(0, 16));
  if (hhmm(guardada.first_in) !== hhmm(calculada.first_in)) difieren.push('first_in');
  if (hhmm(guardada.last_out) !== hhmm(calculada.last_out)) difieren.push('last_out');

  return { iguales: difieren.length === 0, difieren };
}

module.exports = {
  buildDailySummaryRows,
  compararFila,
  statusDe,
  statusWorked,
  statusEmptyDay,
  resolveExpectation,
  aggregateWorkdays,
  STATUS,
  WORKED_PRESENCE,
  WORKED_NET,
};
