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
 * Correcciones clave respecto de la primera versión:
 *  1. REPLAY de la secuencia: un candidato AMBIGUOUS/UNKNOWN NO alimenta al
 *     siguiente con su current_type almacenado; alimenta como 'unknown'. Sólo el
 *     tipo explícito del raw o una resolución contextual REALMENTE determinista
 *     entran como evidencia para la marca siguiente.
 *  2. raw explícito ≠ current_type ⇒ nunca ALREADY_CORRECT (EXPLICIT_STORED_MISMATCH).
 *  3. El match del raw incluye device_id (employee|device|wall); no se elige otro
 *     dispositivo arbitrariamente.
 *  4. El extractor del tipo explícito del raw es el COMPARTIDO
 *     (punchTypeResolver.explicitTypeFromRawJson): no hay parser duplicado.
 *  5. Contexto de zkteco_direct sin raw explícito = 'unknown' (política de
 *     confianza compartida trustedContextType); no se usa el type histórico.
 *
 * Scope: source='zkteco_direct' AND timestamp >= cutover (default 2026-09-16).
 * El manifest (con SHA-256, sin nombres de empleados) reporta total_scoped_rows,
 * rows_audited y truncated para que un LIMIT no parezca auditoría completa.
 *
 * Uso: node scripts/audit-zkteco-inferred-types.js [--cutover=YYYY-MM-DD]
 *        [--limit=N] [--out=ruta.json]
 */

const crypto = require('crypto');
const engine = require('../src/services/workdayEngine');
const resolver = require('../src/services/punchTypeResolver');

const DEFAULT_CUTOVER = '2026-09-16';
const DEFAULT_SOURCE = 'zkteco_direct';

const CLASS = Object.freeze({
  ALREADY_CORRECT: 'ALREADY_CORRECT',
  DETERMINISTIC_CHANGE: 'DETERMINISTIC_CHANGE',
  EXPLICIT_CONFLICT: 'EXPLICIT_CONFLICT',
  EXPLICIT_STORED_MISMATCH: 'EXPLICIT_STORED_MISMATCH',
  AMBIGUOUS: 'AMBIGUOUS',
  UNKNOWN_NO_CONTEXT: 'UNKNOWN_NO_CONTEXT',
  RAW_NOT_FOUND: 'RAW_NOT_FOUND',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
});
// Nota: NO existe clasificación DUPLICATE para attendance_logs. El
// raw_device_punches.mapping_status='duplicate' sólo indica que la marca cruda
// fue RE-OBSERVADA en un polling posterior; el attendance_log enlazado sigue
// siendo real (imported_attendance_log_id apunta a él). Usar mapping_status para
// marcar el log como duplicado era incorrecto y se eliminó (corrección 6).

// Extractor compartido (no duplicar un parser distinto).
const explicitFromRawJson = resolver.explicitTypeFromRawJson;

/**
 * Clasificador PURO de un candidato. No accede a BD ni red.
 *
 * @param c {
 *   eligible, rawFound,
 *   currentType, rawExplicitType,
 *   contextualType, contextualProvenance ('contextual'|'unknown_no_context'),
 * }
 * @returns { classification, proposedType, reason }
 *
 * DETERMINISTIC_CHANGE sólo cuando: el original NO era explícito, el resolver es
 * determinista (in/out) y no hay ambigüedad, y difiere del actual. Un explícito
 * NUNCA se auto-corrige aquí (read-only) y NUNCA es DETERMINISTIC_CHANGE.
 */
function classifyCandidate(c) {
  const currentType = c.currentType;
  if (c.eligible === false) {
    return { classification: CLASS.NOT_ELIGIBLE, proposedType: currentType, reason: 'fuera de scope (source/cutover)' };
  }
  if (!c.rawFound) {
    return { classification: CLASS.RAW_NOT_FOUND, proposedType: currentType, reason: 'sin raw enlazado por imported_attendance_log_id único (0 o >1) para comparar evidencia' };
  }

  // Tipo explícito confiable en el crudo → NUNCA auto-cambio.
  if (c.rawExplicitType === 'in' || c.rawExplicitType === 'out') {
    if (c.rawExplicitType !== currentType) {
      // El type almacenado difiere de la evidencia de hardware: el almacenado
      // está mal, pero NO se corrige en este PR read-only. Se reporta.
      return {
        classification: CLASS.EXPLICIT_STORED_MISMATCH,
        proposedType: currentType,
        reason: `raw explícito=${c.rawExplicitType} != type almacenado=${currentType}; requiere revisión (no auto-corrige)`,
      };
    }
    const ctx = c.contextualType;
    if ((ctx === 'in' || ctx === 'out') && ctx !== c.rawExplicitType) {
      return {
        classification: CLASS.EXPLICIT_CONFLICT,
        proposedType: currentType,
        reason: `raw explícito=${c.rawExplicitType} coincide con almacenado pero contradice contexto=${ctx}; se conserva el explícito`,
      };
    }
    return { classification: CLASS.ALREADY_CORRECT, proposedType: currentType, reason: `raw explícito=${c.rawExplicitType} == almacenado, sin contradicción` };
  }

  // Sin tipo explícito: decide la inferencia contextual (con contexto CONFIABLE).
  if (c.contextualProvenance === 'contextual' && (c.contextualType === 'in' || c.contextualType === 'out')) {
    if (c.contextualType === currentType) {
      return { classification: CLASS.ALREADY_CORRECT, proposedType: currentType, reason: 'inferencia contextual determinista coincide con el actual' };
    }
    return {
      classification: CLASS.DETERMINISTIC_CHANGE,
      proposedType: c.contextualType,
      reason: `sin explícito; contexto determinista=${c.contextualType} difiere del actual=${currentType}`,
    };
  }

  // Contexto insuficiente/ambiguo → NO cambio.
  if (currentType === 'unknown') {
    return { classification: CLASS.UNKNOWN_NO_CONTEXT, proposedType: 'unknown', reason: 'sin explícito y sin contexto determinista; unknown es correcto' };
  }
  return {
    classification: CLASS.AMBIGUOUS,
    proposedType: currentType,
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
 * Construye el manifest. Puro; sin BD. Calcula counts, SHA-256 y campos de
 * cobertura (total_scoped_rows / rows_audited / truncated).
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
  const rowsAudited = rows.length;
  const totalScoped = meta.total_scoped_rows != null ? meta.total_scoped_rows : rowsAudited;
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
    coverage: {
      total_scoped_rows: totalScoped,
      rows_audited: rowsAudited,
      truncated: totalScoped > rowsAudited,
    },
    counts: {
      total: rowsAudited,
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

/** Guard de sólo lectura: rechaza SQL de escritura antes de tocar la BD. */
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
 * Sin N+1: consultas acotadas set-based por lote de empleados. Hace REPLAY de la
 * secuencia por empleado con política de contexto confiable.
 */
async function runAudit({ sequelize, cutover = DEFAULT_CUTOVER, source = DEFAULT_SOURCE, limit = 5000, baselineCommit = null, generatedAt = null } = {}) {
  const q = makeReadOnlyRunner(sequelize);
  const opts = resolver.resolverOptions();
  const spanMin = opts.historicalMaxWorkdaySpanMinutes;
  const cutoverTs = `${cutover} 00:00:00`;

  // 0) Total en scope (para reportar truncamiento honesto).
  const [[cnt]] = await q(
    `SELECT COUNT(*) AS n FROM attendance_logs WHERE source = ? AND \`timestamp\` >= ?`,
    { replacements: [source, cutoverTs] }
  );
  const totalScoped = Number(cnt ? cnt.n : 0);

  // 1) Candidatos del scope (acotado por LIMIT).
  const [cands] = await q(
    `SELECT id, employee_id AS empId, device_id AS deviceId,
            DATE_FORMAT(\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS wall, type
       FROM attendance_logs
      WHERE source = ? AND \`timestamp\` >= ?
      ORDER BY employee_id, \`timestamp\`, id
      LIMIT ?`,
    { replacements: [source, cutoverTs, limit] }
  );
  if (!cands || !cands.length) {
    return buildManifest([], { generated_at: generatedAt, baseline_commit: baselineCommit, cutover, source, limit, total_scoped_rows: totalScoped });
  }
  const candIdSet = new Set(cands.map(c => c.id));

  const empIds = [...new Set(cands.map(c => c.empId))];
  let minAbs = Infinity, maxAbs = -Infinity;
  for (const c of cands) { const w = engine.toWall(c.wall); if (w) { minAbs = Math.min(minAbs, w.abs); maxAbs = Math.max(maxAbs, w.abs); } }
  const fromWall = engine.absToDateTime(minAbs - spanMin * 60);
  const toWall = engine.absToDateTime(maxAbs + 1);

  // 2) Timeline COMPLETO (candidatos + contexto) de esos empleados en la ventana.
  //    SIN join a raw aquí (el vínculo se resuelve aparte por imported_attendance_log_id).
  const [tl] = await q(
    `SELECT al.id, al.employee_id AS empId, al.device_id AS deviceId,
            DATE_FORMAT(al.\`timestamp\`, '%Y-%m-%d %H:%i:%s') AS wall,
            al.type AS storedType, al.source AS source
       FROM attendance_logs al
      WHERE al.employee_id IN (${empIds.map(() => '?').join(',')})
        AND al.\`timestamp\` >= ? AND al.\`timestamp\` < ?
      ORDER BY al.employee_id, al.\`timestamp\`, al.id`,
    { replacements: [...empIds, fromWall, toWall] }
  );

  // 3) Vínculo EXACTO raw↔log por imported_attendance_log_id, agregando por log id.
  //    rawCount=1 → raw único confiable; 0 → no enlazado; >1 → ambiguo (no confiable).
  //    mapping_status NO interviene: un raw re-observado ('duplicate') sigue siendo
  //    evidencia válida del log al que importó.
  const alIds = (tl || []).map(r => r.id);
  const rawByAlId = new Map(); // alId → { c, anyRaw }
  const RCHUNK = 1000;
  for (let i = 0; i < alIds.length; i += RCHUNK) {
    const chunk = alIds.slice(i, i + RCHUNK);
    if (!chunk.length) break;
    const [rl] = await q(
      `SELECT imported_attendance_log_id AS alId, COUNT(*) AS c,
              MAX(CAST(raw_json AS CHAR)) AS anyRaw
         FROM raw_device_punches
        WHERE imported_attendance_log_id IN (${chunk.map(() => '?').join(',')})
        GROUP BY imported_attendance_log_id`,
      { replacements: chunk }
    );
    for (const row of rl || []) rawByAlId.set(row.alId, { c: Number(row.c), anyRaw: row.anyRaw });
  }

  const byEmp = new Map();
  for (const r of tl || []) {
    const w = engine.toWall(r.wall);
    if (!w) continue;
    if (!byEmp.has(r.empId)) byEmp.set(r.empId, []);
    byEmp.get(r.empId).push({ ...r, abs: w.abs });
  }
  for (const arr of byEmp.values()) arr.sort((a, b) => (a.abs - b.abs) || (a.id - b.id));

  const outRows = [];
  for (const [, rows] of byEmp.entries()) {
    const history = []; // [{abs,type}] con política de confianza / replay
    for (const r of rows) {
      const link = rawByAlId.get(r.id);
      const rawCount = link ? link.c : 0;
      // Sólo un raw ÚNICO enlazado es evidencia confiable; 0 o >1 → no confiable.
      const rawExplicitType = rawCount === 1 ? explicitFromRawJson(link.anyRaw) : null;
      const rawFound = rawCount === 1;
      const isCandidate = candIdSet.has(r.id);
      if (!isCandidate) {
        // Fila de contexto: se ancla sólo si es confiable.
        const t = resolver.trustedContextType({ source: r.source, storedType: r.storedType, rawExplicitType });
        history.push({ abs: r.abs, type: t });
        continue;
      }
      // Candidato: la expectativa se calcula ANTES de agregarlo al historial.
      const contextualType = resolver.inferContextualType(history, r.abs, opts);
      const contextualProvenance = (contextualType === 'in' || contextualType === 'out') ? 'contextual' : 'unknown_no_context';

      const verdict = classifyCandidate({
        eligible: true, rawFound,
        currentType: r.storedType, rawExplicitType,
        contextualType, contextualProvenance,
      });

      outRows.push({
        attendance_log_id: r.id,
        employee_id: r.empId,
        device_id: r.deviceId,
        wall_clock_timestamp: r.wall,
        current_type: r.storedType,
        raw_explicit_type: rawExplicitType,
        proposed_type: verdict.proposedType,
        classification: verdict.classification,
        reason: verdict.reason,
      });

      // REPLAY: el candidato alimenta al siguiente SÓLO con evidencia real:
      //  - explícito del raw → ese tipo;
      //  - resolución contextual determinista → ese tipo;
      //  - en cualquier otro caso → 'unknown' (NO el current_type almacenado).
      let feed = resolver.UNKNOWN;
      if (rawExplicitType === 'in' || rawExplicitType === 'out') feed = rawExplicitType;
      else if (contextualProvenance === 'contextual') feed = contextualType;
      history.push({ abs: r.abs, type: feed });
    }
  }

  // Orden de salida estable por (employee_id, wall, id) para SHA reproducible.
  outRows.sort((a, b) => (a.employee_id - b.employee_id)
    || (a.wall_clock_timestamp < b.wall_clock_timestamp ? -1 : a.wall_clock_timestamp > b.wall_clock_timestamp ? 1 : 0)
    || (a.attendance_log_id - b.attendance_log_id));

  return buildManifest(outRows, { generated_at: generatedAt, baseline_commit: baselineCommit, cutover, source, limit, total_scoped_rows: totalScoped });
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
  CLASS, INOUT_FIELDS: resolver.INOUT_FIELDS,
  explicitFromRawJson, classifyCandidate, buildManifest,
  canonicalJson, sha256Hex, makeReadOnlyRunner, runAudit,
};
