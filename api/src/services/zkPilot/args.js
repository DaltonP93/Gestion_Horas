'use strict';

/**
 * args.js — entrada del piloto de estados: argumentos, configuración mínima e
 * identificación de la release. Sin E/S de red.
 *
 *   --device-id N          reloj (entero positivo canónico; utils/strictId)
 *   --attempts N           1..5            (obligatorio)
 *   --attempt-timeout S    1..900 s        (obligatorio) por intento
 *   --max-duration S       1..3600 s       (obligatorio) total, ≥ timeout
 *   --cooldown S           0..60 s         (por defecto 4) entre intentos
 *   --renew-seconds S      1..30 s         (por defecto 5) renovación del lock
 *   --out ARCHIVO          JSON de salida (no se sobrescribe; modo 0600)
 *   --env-file ARCHIVO     sólo DB_* y REDIS_URL; modo sin permisos de grupo/otros
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parsePositiveId } = require('../../utils/strictId');

const LIMITS = Object.freeze({
  attempts: [1, 5],
  attemptTimeoutS: [1, 900],
  maxDurationS: [1, 3600],
  cooldownS: [0, 60],
  renewS: [1, 30],
});
const DEFAULTS = Object.freeze({ cooldownS: 4, renewS: 5 });
const FLAGS = Object.freeze({
  '--device-id': 'deviceId',
  '--attempts': 'attempts',
  '--attempt-timeout': 'attemptTimeoutS',
  '--max-duration': 'maxDurationS',
  '--cooldown': 'cooldownS',
  '--renew-seconds': 'renewS',
  '--out': 'out',
  '--env-file': 'envFile',
});
const REQUIRED = ['deviceId', 'attempts', 'attemptTimeoutS', 'maxDurationS'];
const ENV_ALLOWED = Object.freeze(['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'REDIS_URL']);
const NON_NEGATIVE = /^(0|[1-9][0-9]*)$/;

function inRange(name, raw) {
  const [min, max] = LIMITS[name];
  const n = min === 0 && NON_NEGATIVE.test(raw) ? Number(raw) : parsePositiveId(raw);
  return n !== null && n >= min && n <= max ? n : null;
}

/**
 * @returns {{ ok:true, opts:object } | { ok:false, resultado:'id_invalido'|'argumentos_invalidos', out?:string }}
 */
function parseArgs(argv) {
  const raw = {};
  let structural = false;
  for (let i = 0; i < argv.length; i += 1) {
    const name = FLAGS[argv[i]];
    if (!name || i + 1 >= argv.length || raw[name] !== undefined) { structural = true; break; }
    raw[name] = argv[i + 1];
    i += 1;
  }
  const fail = (resultado) => ({ ok: false, resultado, ...(typeof raw.out === 'string' && raw.out ? { out: raw.out } : {}) });

  if (raw.deviceId !== undefined && parsePositiveId(raw.deviceId) === null) return fail('id_invalido');
  if (structural || REQUIRED.some((k) => raw[k] === undefined)) return fail('argumentos_invalidos');

  const opts = {
    deviceId: parsePositiveId(raw.deviceId),
    attempts: inRange('attempts', raw.attempts),
    attemptTimeoutS: inRange('attemptTimeoutS', raw.attemptTimeoutS),
    maxDurationS: inRange('maxDurationS', raw.maxDurationS),
    cooldownS: raw.cooldownS === undefined ? DEFAULTS.cooldownS : inRange('cooldownS', raw.cooldownS),
    renewS: raw.renewS === undefined ? DEFAULTS.renewS : inRange('renewS', raw.renewS),
    out: raw.out === undefined ? null : raw.out,
    envFile: raw.envFile === undefined ? null : raw.envFile,
  };
  if ([opts.attempts, opts.attemptTimeoutS, opts.maxDurationS, opts.cooldownS, opts.renewS].some((v) => v === null)) return fail('argumentos_invalidos');
  if (opts.maxDurationS < opts.attemptTimeoutS) return fail('argumentos_invalidos');
  if (opts.out === '' || opts.envFile === '') return fail('argumentos_invalidos');
  return { ok: true, opts };
}

/**
 * Lee un archivo de configuración mínimo. Sólo toma DB_* y REDIS_URL (el resto
 * se ignora y sólo se cuenta). Exige archivo regular, no enlace, y sin permisos
 * para grupo u otros.
 */
function loadEnvFile(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return { ok: false, motivo: 'no_existe' }; }
  if (!st.isFile()) return { ok: false, motivo: 'no_es_archivo' };
  if ((st.mode & 0o077) !== 0) return { ok: false, motivo: 'permisos' };
  const parsed = require('dotenv').parse(fs.readFileSync(file));
  const env = {};
  let ignoradas = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (ENV_ALLOWED.includes(k)) env[k] = v; else ignoradas += 1;
  }
  return { ok: true, env, ignoradas };
}

/**
 * Commit de la herramienta. En una release preparada con `git archive` no hay
 * `.git`: manda `.release-commit` (40 hex). Si existe pero no es válido, NO se
 * busca otra fuente.
 */
function releaseCommit(rootDir) {
  const file = path.join(rootDir, '.release-commit');
  if (fs.existsSync(file)) {
    const sha = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(sha) ? { commit: sha, origen: 'release-commit' } : { commit: null, origen: 'release-commit-invalido' };
  }
  if (fs.existsSync(path.join(rootDir, '.git'))) {
    try {
      const sha = execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return { commit: sha, origen: 'git' };
    } catch { /* sin git disponible */ }
  }
  return { commit: null, origen: 'desconocido' };
}

module.exports = { parseArgs, loadEnvFile, releaseCommit, LIMITS, DEFAULTS, ENV_ALLOWED };
