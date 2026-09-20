/**
 * punchTypeResolver.js — Resolución CONTEXTUAL única del tipo (in/out) de una
 * marca sin tipo explícito confiable.
 *
 * ÚNICA fuente de verdad para "¿esta marca es entrada o salida?". La usan tanto
 * el ingreso en tiempo real (attendanceController) como la importación masiva de
 * relojes ZKTeco (zktecoReader / deviceMapping) y cualquier fuente futura.
 *
 * REGLAS DE ORO (no negociables):
 *
 *   1. El valor CRUDO del dispositivo es evidencia y se conserva (raw_json /
 *      raw_device_punches). Este resolver NUNCA lo borra ni lo sustituye.
 *   2. Un tipo EXPLÍCITO y confiable recibido de la fuente NO se reescribe por
 *      contexto. Si el contexto lo contradice, se REPORTA como conflicto
 *      (typeConflict=true) pero jamás se convierte in→out ni out→in.
 *   3. La inferencia contextual SÓLO corre cuando la fuente no trae tipo, trae
 *      unknown, o el campo no es concluyente.
 *   4. Sin evidencia suficiente → 'unknown'. No se inventa in/out para facilitar
 *      daily_summary.
 *
 * La semántica contextual (ventana de jornada, no día civil; sesión abierta;
 * ráfaga/dedupe; sólo-unknown → unknown) es EXACTAMENTE la que ya validaba
 * attendanceController.resolveMarkType(); acá se extrae para reutilizarla sin
 * duplicar una segunda lógica. La resolución trabaja siempre sobre HORA DE PARED
 * (wall-clock) vía workdayEngine.toWall, de modo que el resultado NO depende de
 * la timezone del proceso.
 */

const engine = require('./workdayEngine');

const IN = 'in';
const OUT = 'out';
const UNKNOWN = 'unknown';

const PROV_EXPLICIT = 'explicit';           // tipo explícito confiable, conservado
const PROV_CONTEXTUAL = 'contextual';       // inferido in/out por contexto de jornada
const PROV_UNKNOWN = 'unknown_no_context';  // sin contexto suficiente / ambiguo

/**
 * Mapea un valor crudo de in/out del dispositivo a 'in'/'out', o null si no es
 * concluyente. Único punto que decide qué es un "tipo explícito confiable".
 */
function classifyExplicit(rawInout) {
  if (rawInout === 0 || rawInout === '0' || rawInout === IN) return IN;
  if (rawInout === 1 || rawInout === '1' || rawInout === OUT) return OUT;
  return null;
}

// Campos crudos donde un dispositivo puede traer el in/out explícito. Única
// lista compartida (no duplicar parsers por fuente).
const INOUT_FIELDS = Object.freeze(['inOutStatus', 'state', 'status', 'type', 'inout']);

/**
 * Extrae el tipo explícito ('in'|'out'|null) de un raw_json (objeto o string
 * JSON). Único extractor: lo usan el resolver, el auditor y el reproceso.
 */
function explicitTypeFromRawJson(rawJson) {
  let obj = rawJson;
  if (obj == null) return null;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (typeof obj !== 'object') return null;
  for (const f of INOUT_FIELDS) {
    if (obj[f] !== undefined && obj[f] !== null) {
      const t = classifyExplicit(obj[f]);
      if (t) return t;
    }
  }
  return null;
}

/**
 * POLÍTICA DE CONTEXTO CONFIABLE.
 *
 * Un `attendance_logs.type` almacenado sólo puede actuar como ancla in/out del
 * contexto si es evidencia confiable. Hecho de producción confirmado: los tipos
 * de `zkteco_direct` fueron INFERIDOS por la lógica vieja y su raw NO trae tipo
 * explícito → NO son confiables. Regla:
 *
 *   - source='zkteco_direct': confiable SÓLO si el raw enlazado trae tipo
 *     explícito; en ese caso el tipo confiable ES el del raw. Sin raw explícito
 *     → 'unknown' (no se usa el type histórico).
 *   - otras fuentes: se conserva el type almacenado (comportamiento previo).
 *
 * Fallback seguro = 'unknown': preservar incertidumbre es preferible a fabricar
 * certeza (WorkdayEngine ya segmenta por secuencia y tolera unknown).
 */
function trustedContextType({ source, storedType, rawExplicitType }) {
  if (source === 'zkteco_direct') {
    return (rawExplicitType === IN || rawExplicitType === OUT) ? rawExplicitType : UNKNOWN;
  }
  return (storedType === IN || storedType === OUT) ? storedType : UNKNOWN;
}

/** Opciones efectivas: parte de engine.DEFAULTS y permite override explícito. */
function resolverOptions(overrides = {}) {
  return {
    duplicateWindowSeconds: engine.DEFAULTS.duplicateWindowSeconds,
    historicalMaxWorkdaySpanMinutes: engine.DEFAULTS.historicalMaxWorkdaySpanMinutes,
    ...overrides,
  };
}

/**
 * Inferencia contextual pura para UNA marca sin tipo explícito.
 *
 * @param priorTyped array ordenado (asc) de marcas previas { abs, type }, donde
 *        type ∈ {'in','out','unknown'} y abs es el segundo de pared del engine.
 * @param markAbs    segundo de pared de la marca a resolver.
 * @param opts       resolverOptions().
 * @returns 'in' | 'out' | 'unknown'
 *
 * Espejo exacto de la lógica histórica de resolveMarkType:
 *   · ráfaga/duplicado: si la marca previa (in/out) cae dentro de la ventana de
 *     dedupe, esta marca CONSERVA ese tipo (no alterna);
 *   · última in/out conocida = IN y la sesión sigue abierta (hueco ≤ jornada) →
 *     OUT; IN demasiado vieja → unknown (ambiguo);
 *   · última conocida = OUT → IN;
 *   · sólo unknown previos, o sin previos → unknown.
 */
function inferContextualType(priorTyped, markAbs, opts = resolverOptions()) {
  if (!Array.isArray(priorTyped) || priorTyped.length === 0) return UNKNOWN;

  // Ráfaga / duplicado primero: la marca MÁS reciente (cualquiera) dentro de la
  // ventana de dedupe, si tiene tipo, se conserva.
  const prev = priorTyped[priorTyped.length - 1];
  if (prev && (prev.type === IN || prev.type === OUT) &&
      (markAbs - prev.abs) <= opts.duplicateWindowSeconds) {
    return prev.type;
  }

  // Última marca con tipo conocido (unknown/duplicados no cambian el estado).
  let last = null;
  for (const r of priorTyped) {
    if (r.type === IN || r.type === OUT) last = r;
  }
  if (!last) return UNKNOWN;

  if (last.type === IN) {
    const gapMin = (markAbs - last.abs) / 60;
    return gapMin <= opts.historicalMaxWorkdaySpanMinutes ? OUT : UNKNOWN;
  }
  return IN;
}

/**
 * Resuelve una SECUENCIA determinista de marcas en memoria.
 *
 * @param items array YA ORDENADO de:
 *   - contexto:  { kind:'context', abs, type }              (historial ya tipado)
 *   - punch:     { kind:'punch',   abs, explicitType|null, ref? }
 * @param opts resolverOptions()
 *
 * Anota CADA item 'punch' con:
 *   resolvedType, typeProvenance, typeConflict (bool),
 *   contextualExpectation ('in'|'out'|'unknown').
 * Los items 'context' no se tocan.
 *
 * Las marcas ya resueltas se incorporan al historial para las siguientes (una
 * unknown inferida como OUT actúa como OUT para la marca que le sigue, igual que
 * si se hubiera escrito en attendance_logs y una lectura posterior la viera).
 */
function resolveSequence(items, opts = resolverOptions()) {
  const history = []; // [{ abs, type }]
  for (const it of items) {
    if (it.kind === 'context') {
      history.push({ abs: it.abs, type: it.type });
      continue;
    }
    // punch
    const expectation = inferContextualType(history, it.abs, opts);
    it.contextualExpectation = expectation;
    if (it.explicitType === IN || it.explicitType === OUT) {
      // Regla de oro 2: el explícito manda y NO se reescribe.
      it.resolvedType = it.explicitType;
      it.typeProvenance = PROV_EXPLICIT;
      it.typeConflict = (expectation === IN || expectation === OUT) && expectation !== it.explicitType;
      history.push({ abs: it.abs, type: it.explicitType });
    } else if (expectation === IN || expectation === OUT) {
      it.resolvedType = expectation;
      it.typeProvenance = PROV_CONTEXTUAL;
      it.typeConflict = false;
      history.push({ abs: it.abs, type: expectation });
    } else {
      it.resolvedType = UNKNOWN;
      it.typeProvenance = PROV_UNKNOWN;
      it.typeConflict = false;
      history.push({ abs: it.abs, type: UNKNOWN });
    }
  }
  return items;
}

/**
 * Resolución contextual de UNA marca online contra un historial ya leído de la
 * BD (usado por attendanceController). `priorRows` son filas previas
 * { wall|timestamp, type }; se convierten a { abs, type } vía engine.toWall.
 */
function resolveSingle(priorRows, markWall, opts = resolverOptions()) {
  const at = engine.toWall(markWall);
  if (!at) return UNKNOWN; // sin hora legible: no hay evidencia
  const priorTyped = [];
  for (const r of priorRows || []) {
    const w = engine.toWall(r.wall != null ? r.wall : r.timestamp);
    if (!w) continue;
    priorTyped.push({ abs: w.abs, type: r.type });
  }
  priorTyped.sort((a, b) => a.abs - b.abs);
  return inferContextualType(priorTyped, at.abs, opts);
}

/**
 * Resolución CONTEXTUAL POR LOTE, eficiente (sin N+1), para importaciones
 * masivas. Carga UNA sola vez el contexto previo necesario de los empleados
 * involucrados, ordena determinísticamente y resuelve en memoria incorporando
 * las propias marcas del lote a medida que se resuelven.
 *
 * @param punches array de marcas del lote. Cada una debe permitir obtener:
 *        empId (getEmpId), hora de pared (getWall → 'YYYY-MM-DD HH:MM:SS') y su
 *        tipo explícito (getExplicitType → 'in'|'out'|null).
 * @param deps { sequelize, source='zkteco_direct', getEmpId, getWall,
 *              getExplicitType, contextSpanMinutes?, apply? }
 *
 * Por cada punch, ESCRIBE de vuelta (apply, default true):
 *   - punch.type          = resolvedType   (SÓLO si NO era explícito; el
 *                           explícito se conserva intacto)
 *   - punch.typeProvenance, punch.typeConflict, punch.contextualExpectation
 *
 * Devuelve { resolved: n, byProvenance:{...}, conflicts: n }.
 */
async function resolvePunchTypesBatch(punches, deps = {}) {
  const {
    sequelize,
    source = 'zkteco_direct',
    getEmpId = (p) => p.empId,
    getWall,
    getExplicitType = (p) => (p.explicit ? p.type : null),
    apply = true,
  } = deps;
  const opts = resolverOptions(deps.options);
  const spanMinutes = deps.contextSpanMinutes != null
    ? deps.contextSpanMinutes
    : opts.historicalMaxWorkdaySpanMinutes;

  const summary = { resolved: 0, conflicts: 0, byProvenance: { explicit: 0, contextual: 0, unknown_no_context: 0 } };
  if (!Array.isArray(punches) || punches.length === 0) return summary;
  if (typeof getWall !== 'function') throw new Error('resolvePunchTypesBatch: getWall requerido');

  // Preparar marcas por empleado con abs de pared; descartar (para la resolución)
  // las que no tienen empleado u hora legible — pero NO se pierde la marca cruda,
  // que el caller ya persiste aparte.
  const byEmp = new Map();
  const globalByEmp = new Map(); // empId → { minAbs, maxAbs }
  punches.forEach((p, index) => {
    const empId = getEmpId(p);
    if (empId == null) return;
    const wall = getWall(p);
    const at = engine.toWall(wall);
    if (!at) return;
    const explicitType = classifyExplicit(getExplicitType(p));
    const item = { kind: 'punch', abs: at.abs, explicitType, index, ref: p };
    if (!byEmp.has(empId)) byEmp.set(empId, []);
    byEmp.get(empId).push(item);
    const g = globalByEmp.get(empId) || { minAbs: at.abs, maxAbs: at.abs };
    g.minAbs = Math.min(g.minAbs, at.abs);
    g.maxAbs = Math.max(g.maxAbs, at.abs);
    globalByEmp.set(empId, g);
  });
  if (byEmp.size === 0) return summary;

  // Contexto de BD: una única consulta acotada por [min - span, max] para TODOS
  // los empleados. Ventana = una jornada hacia atrás (suficiente para la sesión
  // abierta) desde la primera marca del lote de cada empleado.
  const empIds = [...byEmp.keys()];
  let globalMin = Infinity, globalMax = -Infinity;
  for (const g of globalByEmp.values()) { globalMin = Math.min(globalMin, g.minAbs); globalMax = Math.max(globalMax, g.maxAbs); }
  const fromWall = engine.absToDateTime(globalMin - spanMinutes * 60);
  const toWallStr = engine.absToDateTime(globalMax + 1); // exclusivo, cubre la última marca

  const ctxByEmp = new Map();
  if (sequelize && empIds.length) {
    // Contexto en UNA consulta (sin N+1). El raw se enlaza por el VÍNCULO EXACTO
    // del pipeline: raw_device_punches.imported_attendance_log_id = attendance_logs.id
    // (no por aproximación emp+device+hora). Un raw con tipo explícito es evidencia
    // confiable AUNQUE su mapping_status sea 'duplicate' por una relectura posterior.
    // Ante 0 o >1 raws enlazados (rawCount != 1) no hay evidencia confiable, así que
    // un type de zkteco_direct sin explícito único queda como unknown.
    const ph = empIds.map(() => '?').join(',');
    const [rows] = await sequelize.query(
      `SELECT al.employee_id AS empId,
              DATE_FORMAT(al.\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS wall,
              al.type AS storedType, al.source AS source,
              rl.c AS rawCount, rl.anyRaw AS rawJson
         FROM attendance_logs al
         LEFT JOIN (
           SELECT imported_attendance_log_id AS alId, COUNT(*) AS c,
                  MAX(CAST(raw_json AS CHAR)) AS anyRaw
             FROM raw_device_punches
            WHERE imported_attendance_log_id IS NOT NULL
              AND employee_id IN (${ph})
            GROUP BY imported_attendance_log_id
         ) rl ON rl.alId = al.id
        WHERE al.employee_id IN (${ph})
          AND al.\`timestamp\` >= ? AND al.\`timestamp\` < ?
        ORDER BY al.employee_id, al.\`timestamp\`, al.id`,
      { replacements: [...empIds, ...empIds, fromWall, toWallStr] }
    );
    for (const r of rows || []) {
      const w = engine.toWall(r.wall);
      if (!w) continue;
      const rawExplicitType = Number(r.rawCount) === 1 ? explicitTypeFromRawJson(r.rawJson) : null;
      const ctxType = trustedContextType({ source: r.source, storedType: r.storedType, rawExplicitType });
      if (!ctxByEmp.has(r.empId)) ctxByEmp.set(r.empId, []);
      ctxByEmp.get(r.empId).push({ kind: 'context', abs: w.abs, type: ctxType });
    }
  }

  for (const [empId, punchItems] of byEmp.entries()) {
    const ctx = ctxByEmp.get(empId) || [];
    // Merge determinista: contexto y punches; a igual abs el contexto va primero
    // (historial ya conocido), y los punches por su índice de entrada (estable
    // aunque lleguen desordenados).
    const merged = [...ctx, ...punchItems].sort((a, b) => {
      if (a.abs !== b.abs) return a.abs - b.abs;
      const ka = a.kind === 'context' ? 0 : 1;
      const kb = b.kind === 'context' ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return (a.index || 0) - (b.index || 0);
    });
    resolveSequence(merged, opts);
    for (const it of punchItems) {
      summary.resolved++;
      summary.byProvenance[it.typeProvenance] = (summary.byProvenance[it.typeProvenance] || 0) + 1;
      if (it.typeConflict) summary.conflicts++;
      if (apply) {
        const p = it.ref;
        // El explícito se conserva; sólo se fija p.type cuando NO era explícito.
        if (it.typeProvenance !== PROV_EXPLICIT) p.type = it.resolvedType;
        p.typeProvenance = it.typeProvenance;
        p.typeConflict = it.typeConflict;
        p.contextualExpectation = it.contextualExpectation;
      }
    }
  }
  return summary;
}

module.exports = {
  IN, OUT, UNKNOWN,
  PROV_EXPLICIT, PROV_CONTEXTUAL, PROV_UNKNOWN,
  INOUT_FIELDS,
  classifyExplicit,
  explicitTypeFromRawJson,
  trustedContextType,
  resolverOptions,
  inferContextualType,
  resolveSequence,
  resolveSingle,
  resolvePunchTypesBatch,
};
