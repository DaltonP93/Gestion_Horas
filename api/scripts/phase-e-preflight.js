#!/usr/bin/env node
/**
 * phase-e-preflight.js — orquestador GO/NO-GO de SOLO LECTURA para FASE E.
 *
 * Encadena, en orden, los lectores read-only del rollout y emite UN veredicto
 * único, para reducir el error de operador (orden equivocado, olvidar un gate).
 * NO aplica migraciones, NO activa flags/writers, NO toca datos: sólo compone
 * scripts que ya son read-only y falla-cerrado si cualquiera sale ≠0.
 *
 *   1. workday-config-preflight --require-safe   (gate de esquema: NO_GO_PARTIAL → 1)
 *   2. migrate --status                          (estado de migraciones, read-only)
 *   3. check-schema-drift                        (deriva de esquema)
 *   4. workday-config-impact-audit --require-no-impact --from --to
 *                                                (0 impacto sobre daily_summary)
 *
 * Uso:
 *   node scripts/phase-e-preflight.js --from 2025-01-01 --to 2025-12-31
 *   node scripts/phase-e-preflight.js --json
 *   npm run phase-e:preflight -- --from 2025-01-01 --to 2025-12-31
 *
 * Sin --from/--to el gate de impacto se OMITE y el veredicto es INCOMPLETE
 * (nunca GO): el impacto es un gate obligatorio del rollout.
 *
 * Exit code: 0 sólo con veredicto GO; 1 con NO_GO o INCOMPLETE (fail-closed).
 */

'use strict';

const path = require('path');

/**
 * Deriva el veredicto a partir de los resultados de los pasos. PURA (sin
 * procesos ni DB) para poder testearla. Un paso "gate" que no pasó ⇒ NO_GO;
 * si todos los gates pasan pero se omitió el impacto ⇒ INCOMPLETE; si no ⇒ GO.
 */
function computeVerdict(steps, impactSkipped) {
  const failed = steps.filter((s) => s.gate && !s.passed);
  if (failed.length) return 'NO_GO';
  if (impactSkipped) return 'INCOMPLETE';
  return 'GO';
}

function argVal(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function main() {
  const { spawnSync } = require('child_process');
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const from = argVal(argv, '--from');
  const to = argVal(argv, '--to');

  // Flags de entorno que entienden preflight e impact-audit.
  const envArgs = [];
  if (argv.includes('--no-env')) envArgs.push('--no-env');
  const envFile = argVal(argv, '--env');
  if (envFile) envArgs.push('--env', envFile);

  const NODE = process.execPath;
  const S = (f) => path.join(__dirname, f);
  const stdio = json ? 'ignore' : 'inherit';

  function run(label, script, args, gate = true) {
    const r = spawnSync(NODE, [S(script), ...args], { stdio });
    const code = r.status == null ? 2 : r.status;
    return { label, code, gate, passed: code === 0 };
  }

  const steps = [];
  steps.push(run('preflight --require-safe', 'workday-config-preflight.js', ['--require-safe', ...envArgs]));
  steps.push(run('migrate --status', 'migrate.js', ['--status']));
  steps.push(run('schema:drift', 'check-schema-drift.js', []));

  let impactSkipped = false;
  if (from && to) {
    steps.push(run('impact-audit --require-no-impact', 'workday-config-impact-audit.js',
      ['--from', from, '--to', to, '--require-no-impact', ...envArgs]));
  } else {
    impactSkipped = true;
  }

  const verdict = computeVerdict(steps, impactSkipped);

  if (json) {
    process.stdout.write(JSON.stringify({
      read_only: true,
      verdict,
      impact_skipped: impactSkipped,
      steps: steps.map((s) => ({ label: s.label, exit: s.code, passed: s.passed })),
    }, null, 2) + '\n');
  } else {
    console.log('\n=== FASE E preflight (READ-ONLY · GO/NO-GO) ===');
    for (const s of steps) console.log(`${s.passed ? '✓' : '✗'} ${s.label} (exit ${s.code})`);
    if (impactSkipped) console.log('• impact-audit OMITIDO: pasá --from y --to para el gate de impacto obligatorio');
    console.log(`VERDICT: ${verdict}`);
  }

  process.exitCode = verdict === 'GO' ? 0 : 1;
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error('phase-e-preflight falló:', err.message); process.exitCode = 2; }
}

module.exports = { computeVerdict };
