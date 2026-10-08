#!/usr/bin/env node
'use strict';

/**
 * zk-raw-state-pilot.js — piloto AISLADO de estados de UN reloj ZKTeco.
 *
 * Lee el buffer de marcaciones de un reloj y produce un JSON con CONTEOS del
 * estado crudo (bytes zkPunchState / zkVerify por formato), de la captura y de
 * la integridad de la lectura. No importa marcaciones, no escribe staging, no
 * recalcula horas, no actualiza el dispositivo y no interpreta ningún valor
 * como entrada o salida. Ver docs/design/piloto-estados-reloj.md.
 *
 *   node scripts/zk-raw-state-pilot.js --device-id N \
 *     --attempts 3 --attempt-timeout 600 --max-duration 1900 \
 *     [--cooldown 4] [--renew-seconds 5] [--cutoff "AAAA-MM-DD HH:MM:SS"] \
 *     [--env-file pilot.env] [--out salida.json]
 *
 * Configuración (variables de entorno o --env-file, que sólo toma estas):
 *   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD   MySQL; sesión READ ONLY, sólo SELECT
 *   REDIS_URL                                     el mismo Redis que usa el worker
 *   PILOT_CORTE_CLAVE                             64 hex: clave de la huella del corte común
 *                                                 (la misma en las dos corridas; nunca se publica).
 *                                                 Vacía = sin clave (sólo conteos).
 *
 * Códigos de salida: 0 ok · 2 entrada inválida · 3 captura no garantizada o
 * incompleta · 4 reloj ocupado / exclusión no garantizada · 5 Redis no
 * disponible · 6 sin lectura completa / límite total · 7 lock perdido ·
 * 8 reloj inexistente o base no disponible · 1 error interno o cierre no
 * confirmado · 128+n señal (130 SIGINT, 143 SIGTERM, 129 SIGHUP, 148 SIGTSTP:
 * Ctrl+Z interrumpe; el piloto nunca queda suspendido con el lock tomado).
 */
const fs = require('fs');
const path = require('path');
const { parseArgs, loadEnvFile } = require('../src/services/zkPilot/args');
const { CLAVE_RE } = require('../src/services/zkPilot/corte');
const { runPilot, skeletonFor, EXIT_CODES } = require('../src/services/zkPilot/runPilot');

/** Claves de conexión que en --env-file no pueden quedar vacías (DB_PASSWORD sí puede). */
const BLANK_NOT_ALLOWED = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'REDIS_URL'];

const ROOT = path.resolve(__dirname, '..', '..');

/** Escribe el JSON en `out` (nuevo, modo 0600) o en stdout. */
function emit(json, out) {
  const text = `${JSON.stringify(json, null, 2)}\n`;
  if (out) {
    try {
      fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
      return;
    } catch { /* no se pudo crear: se informa por stdout */ }
  }
  process.stdout.write(text);
}

function rejected(resultado, opts, out) {
  const json = skeletonFor(opts, ROOT);
  json.resultado = resultado;
  json.codigo_salida = EXIT_CODES[resultado];
  emit(json, out);
  return json.codigo_salida;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    const out = parsed.out && !fs.existsSync(parsed.out) ? parsed.out : null;
    return rejected(parsed.resultado, null, out);
  }
  const { opts } = parsed;
  if (opts.out && fs.existsSync(opts.out)) return rejected('salida_existente', opts, null);

  let env = { ...process.env };
  if (opts.envFile) {
    const loaded = loadEnvFile(opts.envFile);
    if (!loaded.ok) return rejected('configuracion_invalida', opts, opts.out);
    // Una clave de conexión VACÍA (línea de la plantilla sin completar) no cae en silencio en un valor
    // por omisión (p. ej. DB_USER → root): es configuración inválida.
    if (BLANK_NOT_ALLOWED.some((k) => loaded.env[k] !== undefined && !String(loaded.env[k]).trim())) {
      return rejected('configuracion_invalida', opts, opts.out);
    }
    env = { ...env, ...loaded.env };
  }
  // Vacía (p. ej. la línea de la plantilla sin completar) equivale a no tenerla: sólo conteos.
  if (env.PILOT_CORTE_CLAVE === '') delete env.PILOT_CORTE_CLAVE;
  if (env.PILOT_CORTE_CLAVE !== undefined && !CLAVE_RE.test(env.PILOT_CORTE_CLAVE)) {
    return rejected('configuracion_invalida', opts, opts.out);
  }

  const { json, exitCode } = await runPilot(opts, { env, rootDir: ROOT });
  emit(json, opts.out);
  process.stderr.write(`[piloto-estados] resultado=${json.resultado} intentos=${json.intentos_ejecutados} codigo=${exitCode}\n`);
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('[piloto-estados] resultado=error_interno\n');
    process.exit(1);
  },
);
