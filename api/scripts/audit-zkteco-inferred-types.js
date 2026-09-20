#!/usr/bin/env node
/**
 * audit-zkteco-inferred-types.js — Auditor DRY-RUN (ESTRICTAMENTE READ-ONLY)
 * de tipos in/out posiblemente mal inferidos por el ingreso zkteco_direct
 * ANTES del resolver contextual (bug de "día civil + paridad").
 *
 * Este PR entrega SÓLO el dry-run: NO existe --apply. NO ejecuta ningún
 * UPDATE/INSERT/DELETE, no recalcula daily_summary y no toca settings. Un guard
 * de sólo-lectura (makeReadOnlyRunner) hace fallar cualquier intento de SQL de
 * escritura, y hay un test que lo verifica.
 *
 * Scope obligatorio (filtros): source='zkteco_direct' AND timestamp >= cutover
 * (default 2026-09-16). Usa raw_device_punches/raw_json para distinguir el tipo
 * EXPLÍCITO original del inferido. Emite un manifest JSON (con SHA-256) que
 * clasifica cada candidato; NO incluye nombres de empleados (sólo IDs).
 *
 * Uso:
 *   node scripts/audit-zkteco-inferred-types.js [--cutover=YYYY-MM-DD]
 *        [--limit=N] [--out=ruta.json]
 */

const crypto = require('crypto');
const engine = require('../src/services/workdayEngine');
const resolver = require('../src/services/punchTypeResolver');

const DEFAULT_CUTOVER = '2026-09-16';
const DEFAULT_SOURCE = 'zkteco_direct';

// Clasificaciones posibles.
const CLASS = Object.freeze({
  ALREADY_CORRECT: 'ALREADY_CORRECT',
  DETERMINISTIC_CHANGE: 'DETERMINISTIC_CHANGE',
  EXPLICIT_CONFLICT: 'EXPLICIT_CONFLICT',
  AMBIGUOUS: 'AMBIGUOUS',
  UNKNOWN_NO_CONTEXT: 'UNKNOWN_NO_CONTEXT',
  DUPLICATE: 'DUPLICATE',
  RAW_NOT_FOUND: 'RAW_NOT_FOUND',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
});

// Campos crudos donde un dispositivo puede traer el in/out explícito.
const INOUT_FIELDS = ['inOutStatus', 'state', 'status', 'type', 'inout'];

/** Extrae el tipo explícito ('in'|'out'|null) de un raw_json (objeto o string). */
function explicitFromRawJson(rawJson) {
  let obj = rawJson;
  if (obj == null) return null;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (typeof obj !== 'object') return null;
  for (const f of INOUT_FIELDS) {
    if (obj[f] !== undefined && obj[f] !== null) {
      const t = resolver.classifyExplicit(obj[f]);
      if (t) return t;
    }
  }
  return null;
}

/**
 * Clasificador PURO de un candidato. No accede a BD ni red.
 *
 * @param c {
 *   eligible:bool, rawFound:bool, isDuplicate:bool,
 *   currentType:'in'|'out'|'unknown',
 *   rawExplicitType:'in'|'out'|null,
 *   contextualType:'in'|'out'|'unknown',        // expectativa del resolver
 *   contextualProvenance:'contextual'|'unknown_no_context',
 * }
 * @returns { classification, proposedType, reason }
 *
 * DETERMINISTIC_CHANGE sólo cuando: el tipo original NO era explícito, el
 * resolver es determinista (in/out) y no hay ambigüedad, y difiere del actual.
 * Un EXPLICIT_CONFLICT NUNCA entra en DETERMINISTIC_CHANGE.
 */
function classifyCandidate(c) {
  const currentType = c.currentType;
  if (c.eligible === false) {
    return { classification: CLASS.NOT_ELIGIBLE, proposedType: currentType, reason: 'fuera de scope (source/cutover)' };
  }
  if (c.isDuplicate) {
    return { classification: CLASS.DUPLICATE, proposedType: currentType, reason: 'marca duplicada (dedupe cross-source)' };
  }
  if (!c.rawFound) {
    return { classification: CLASS.RAW_NOT_FOUND, proposedType: currentType, reason: 'sin raw_device_punches para comparar evidencia' };
  }

  // Tipo explícito confiable en el crudo → NUNCA se cambia automáticamente.
  if (c.rawExplicitType === 'in' || c.rawExplicitType === 'out') {
    const ctx = c.contextualType;
    if ((ctx === 'in' || ctx === 'out') && ctx !== c.rawExplicitType) {
      return {
        classification: CLASS.EXPLICIT_CONFLICT,
        proposedType: currentType, // NO auto-cambio; requiere revisión humana
        reason: `raw explícito=${c.rawExplicitType} contradice contexto=${ctx}; se conserva el explícito`,
      };
    }
    return {
      classification: CLASS.ALREADY_CORRECT,
      proposedType: currentType,
      reason: `raw explícito=${c.rawExplicitType} sin contradicción de contexto`,
    };
  }

  // Sin tipo explícito: la inferencia contextual decide.
  if (c.contextualProvenance === 'contextual' && (c.contextualType === 'in' || c.contextualType === 'out')) {
    if (c.contextualType === currentType) {
      return { classification: CLASS.ALREADY_CORRECT, proposedType: currentType, reason: 'inferencia contextual coincide con el tipo actual' };
    }
    return {
      classification: CLASS.DETERMINISTIC_CHANGE,
      proposedType: c.contextualType,
      reason: `sin explícito; contexto determinista=${c.contextualType} difiere del actual=${currentType}`,
    };
  }

  // Contexto insuficiente/ambiguo.
  if (currentType === 'unknown') {
    return { classification: CLASS.UNKNOWN_NO_CONTEXT, proposedType: 'unknown', reason: 'sin explícito y sin contexto determinista; unknown es correcto' };
  }
  return {
    classification: CLASS.AMBIGUOUS,
    proposedType: currentType, // NO cambio: no hay evidencia determinista
    reason: `actual=${currentType} pero sin explícito y contexto no determinista (${c.contextualType})`,
  };
}

/** JSON canónico estable (claves ordenadas) para hashing reproducible. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Construye el manifest a partir de las filas candidatas ya clasificadas y la
 * metadata. Puro; sin BD. Calcula counts y SHA-256 del contenido.
 *
 * @param rows array de candidate rows:
 *   { attendance_log_id, employee_id, device_id, wall_clock_timestamp,
 *     current_type, raw_explicit_type, proposed_type, classification, reason }
 * @param meta { generated_at, baseline_commit, cutover, source, limit, note }
 */
function buildManifest(rows, meta = {}) {
  const byClassification = {};
  const byDevice = {};
  const byDate = {};
  for (const r of rows) {
    byClassification[r.classification] = (byClassification[r.classification] || 0) + 1;
    const dev = String(r.device_id == null ? 'null' : r.device_id);
    byDevice[dev] = (byDevice[dev] || 0) + 1;
    const date = String(r.wall_clock_timestamp || '').slice(0, 10) || 'null';
    byDate[date] = (byDate[date] || 0) + 1;
  }
  const manifest = {
    tool: 'audit-zkteco-inferred-types',
    mode: 'dry-run',
    apply: false,
    generated_at: meta.generated_at || new Date().toISOString(),
    baseline_commit: meta.baseline_commit || null,
    cutover: meta.cutover || DEFAULT_CUTOVER,
    filters: {
      source: meta.source || DEFAULT_SOURCE,
      timestamp_gte: meta.cutover || DEFAULT_CUTOVER,
      limit: meta.limit != null ? meta.limit : null,
    },
    counts: {
      total: rows.length,
      by_classification: byClassification,
      by_device: byDevice,
      by_date: byDate,
    },
    candidate_rows: rows,
    note: meta.note || 'READ-ONLY dry-run: cero UPDATE/INSERT/DELETE, cero recálculo daily_summary. Sin nombres de empleados.',
  };
  const sha256 = sha256Hex(canonicalJson(manifest));
  return { manifest, sha256 };
}

/**
 * Envuelve un sequelize.query en un runner de SÓLO LECTURA: cualquier SQL de
 * escritura (DML/DDL) es rechazado ANTES de tocar la BD. Blindaje de que el
 * auditor no muta nada.
 */
const WRITE_SQL_RE = /^\s*(?:\/\*.*?\*\/\s*)*(INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|RENAME|LOCK|UNLOCK|SET\s+GLOBAL|CALL|LOAD\s+DATA)\b/i;
function makeReadOnlyRunner(sequelize) {
  return async function readOnlyQuery(sql, options) {
    if (WRITE_SQL_RE.test(String(sql))) {
      throw new Error(`READONLY_VIOLATION: el auditor sólo puede leer; SQL rechazado: ${String(sql).slice(0, 60)}`);
    }
    return sequelize.query(sql, options);
  };
}

/**
 * Ejecuta la auditoría contra la BD (READ-ONLY). Devuelve { manifest, sha256 }.
 * Sin N+1: consultas acotadas y set-based por lote de empleados.
 */
async function runAudit({ sequelize, cutover = DEFAULT_CUTOVER, source = DEFAULT_SOURCE, limit = 5000, baselineCommit = null, generatedAt = null } = {}) {
  const q = makeReadOnlyRunner(sequelize);
  const opts = resolver.resolverOptions();
  const spanMin = opts.historicalMaxWorkdaySpanMinutes;

  // 1) Candidatos: attendance_logs del scope. Acotado por LIMIT.
  const [cands] = await q(
    `SELECT id, employee_id AS empId, device_id AS deviceId,
            DATE_FORMAT(\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS wall, type
       FROM attendance_logs
      WHERE source = ? AND \`timestamp\` >= ?
      ORDER BY employee_id, \`timestamp\`, id
      LIMIT ?`,
    { replacements: [source, `${cutover} 00:00:00`, limit] }
  );
  if (!cands || !cands.length) {
    return buildManifest([], { generated_at: generatedAt, baseline_commit: baselineCommit, cutover, source, limit });
  }

  const empIds = [...new Set(cands.map(c => c.empId))];
  let minAbs = Infinity, maxAbs = -Infinity;
  for (const c of cands) { const w = engine.toWall(c.wall); if (w) { minAbs = Math.min(minAbs, w.abs); maxAbs = Math.max(maxAbs, w.abs); } }
  const fromWall = engine.absToDateTime(minAbs - spanMin * 60);
  const toWall = engine.absToDateTime(maxAbs + 1);

  // 2) Contexto: TODAS las marcas (cualquier fuente) de esos empleados en la
  //    ventana [min - jornada, max], una sola consulta.
  const [ctxRows] = await q(
    `SELECT id, employee_id AS empId,
            DATE_FORMAT(\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS wall, type
       FROM attendance_logs
      WHERE employee_id IN (${empIds.map(() => '?').join(',')})
        AND \`timestamp\` >= ? AND \`timestamp\` < ?
      ORDER BY employee_id, \`timestamp\`, id`,
    { replacements: [...empIds, fromWall, toWall] }
  );

  // 3) raw_device_punches de esos empleados en la ventana, una sola consulta.
  //    Índice por (empId|record_time_py) para O(1) por candidato.
  const rawByKey = new Map();
  const [rawRows] = await q(
    `SELECT employee_id AS empId, record_time_py AS wall, mapping_status, raw_json
       FROM raw_device_punches
      WHERE employee_id IN (${empIds.map(() => '?').join(',')})
        AND record_time_py >= ? AND record_time_py < ?`,
    { replacements: [...empIds, fromWall, toWall] }
  );
  for (const r of rawRows || []) {
    rawByKey.set(`${r.empId}|${r.wall}`, r);
  }

  // Historial por empleado (contexto ordenado con tipos ALMACENADOS).
  const histByEmp = new Map();
  for (const r of ctxRows || []) {
    const w = engine.toWall(r.wall);
    if (!w) continue;
    if (!histByEmp.has(r.empId)) histByEmp.set(r.empId, []);
    histByEmp.get(r.empId).push({ id: r.id, abs: w.abs, type: r.type });
  }
  for (const arr of histByEmp.values()) arr.sort((a, b) => (a.abs - b.abs) || (a.id - b.id));

  const candById = new Map(cands.map(c => [c.id, c]));
  const outRows = [];
  for (const c of cands) {
    const w = engine.toWall(c.wall);
    const hist = histByEmp.get(c.empId) || [];
    // priorTyped = marcas estrictamente anteriores (abs,id) a este candidato.
    const priorTyped = [];
    for (const h of hist) {
      if (h.abs < w.abs || (h.abs === w.abs && h.id < c.id)) priorTyped.push({ abs: h.abs, type: h.type });
    }
    const contextualType = w ? resolver.inferContextualType(priorTyped, w.abs, opts) : 'unknown';
    const contextualProvenance = (contextualType === 'in' || contextualType === 'out') ? 'contextual' : 'unknown_no_context';

    const raw = rawByKey.get(`${c.empId}|${c.wall}`);
    const rawFound = !!raw;
    const isDuplicate = !!raw && raw.mapping_status === 'duplicate';
    const rawExplicitType = raw ? explicitFromRawJson(raw.raw_json) : null;

    const verdict = classifyCandidate({
      eligible: true, rawFound, isDuplicate,
      currentType: c.type, rawExplicitType,
      contextualType, contextualProvenance,
    });

    outRows.push({
      attendance_log_id: c.id,
      employee_id: c.empId,
      device_id: c.deviceId,
      wall_clock_timestamp: c.wall,
      current_type: c.type,
      raw_explicit_type: rawExplicitType,
      proposed_type: verdict.proposedType,
      classification: verdict.classification,
      reason: verdict.reason,
    });
  }
  void candById;

  return buildManifest(outRows, { generated_at: generatedAt, baseline_commit: baselineCommit, cutover, source, limit });
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a === '--apply') out.apply = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply) {
    console.error('ERROR: --apply NO está implementado en este PR (dry-run READ-ONLY únicamente).');
    process.exit(2);
  }
  const { sequelize } = require('../src/config/database');
  let baselineCommit = null;
  try { baselineCommit = require('child_process').execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(); } catch { /* opcional */ }
  try {
    const { manifest, sha256 } = await runAudit({
      sequelize,
      cutover: args.cutover || DEFAULT_CUTOVER,
      limit: args.limit ? parseInt(args.limit, 10) : 5000,
      baselineCommit,
    });
    const payload = JSON.stringify({ ...manifest, sha256 }, null, 2);
    if (args.out) { require('fs').writeFileSync(args.out, payload); console.error(`manifest → ${args.out} (sha256=${sha256})`); }
    else { process.stdout.write(payload + '\n'); }
  } finally {
    try { await sequelize.close(); } catch { /* ignore */ }
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  CLASS, INOUT_FIELDS,
  explicitFromRawJson, classifyCandidate, buildManifest,
  canonicalJson, sha256Hex, makeReadOnlyRunner, runAudit,
};
