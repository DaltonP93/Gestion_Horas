#!/usr/bin/env node
/**
 * historical-attendance-repair.js — Reparación histórica de attendance_logs.
 *
 * El flujo histórico `source='device'` guardó el instante UTC en una columna
 * que el resto del sistema trata como hora de pared. Este script propone la
 * corrección contrastando contra att2000.CHECKINOUT, que es la fuente de
 * verdad, y sólo escribe lo que quedó respaldado por un único candidato
 * inequívoco.
 *
 * MODO POR DEFECTO: DRY-RUN. No escribe nada en attendance_logs.
 *
 *   # 1. Diagnóstico y manifest (no toca datos)
 *   node scripts/historical-attendance-repair.js \
 *        --from 2024-01-01 --to 2026-07-31 --out ./reparacion
 *
 *   # 2. Revisar el resumen y el manifest a mano. Recién entonces:
 *   node scripts/historical-attendance-repair.js \
 *        --apply --manifest ./reparacion/manifest.json
 *
 * Ver docs/reparacion-historica.md para el procedimiento completo y el
 * rollback.
 */

const fs = require('fs');
const path = require('path');

// ─── Entorno ──────────────────────────────────────────────────────
// CRÍTICO: esto va ANTES de requerir config/database y config/att2000, que
// leen process.env al cargarse. Si el shell tiene un DB_PASSWORD distinto al
// de api/.env —caso verificado en producción—, sin `override` gana el del
// shell y la conexión falla con un error de autenticación desconcertante.
//
// Se resuelve acá y no dentro de las funciones porque en CommonJS los
// `require` de abajo se ejecutan al cargar el módulo.
function cargarEnv(argv) {
  if (argv.includes('--no-env')) return { modo: 'shell', archivo: null };

  const i = argv.indexOf('--env');
  const archivo = (i >= 0 && argv[i + 1])
    ? path.resolve(argv[i + 1])
    : path.resolve(__dirname, '..', '.env');

  if (!fs.existsSync(archivo)) return { modo: 'shell', archivo, faltante: true };

  // `override: true` es el punto de todo esto: los valores del archivo pisan
  // los del shell.
  require('dotenv').config({ path: archivo, override: true });
  return { modo: 'archivo', archivo };
}

const ENV = cargarEnv(process.argv.slice(2));

const { sequelize } = require('../src/config/database');
const repair = require('../src/services/historicalRepair');

// ─── Argumentos ───────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    apply: false, manifest: null, out: './reparacion-historica',
    from: null, to: null, source: repair.APPLICABLE_SOURCE,
    employee: null, limit: null, batchSize: 500,
    diagnostic: false, env: null, noEnv: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--apply') args.apply = true;
    else if (a === '--manifest') args.manifest = next();
    else if (a === '--out') args.out = next();
    else if (a === '--from') args.from = next();
    else if (a === '--to') args.to = next();
    else if (a === '--source') args.source = next();
    else if (a === '--employee') args.employee = next();
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--batch-size') args.batchSize = Number(next());
    else if (a === '--diagnostic') args.diagnostic = true;
    else if (a === '--env') args.env = next();
    else if (a === '--no-env') args.noEnv = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }

  // Un origen distinto de `device` sólo se admite en dry-run diagnóstico. La
  // reparación se autorizó únicamente para el flujo histórico device.
  if (args.source !== repair.APPLICABLE_SOURCE) {
    if (args.apply) {
      throw new Error(
        `--apply sólo está autorizado para source='${repair.APPLICABLE_SOURCE}' (se pidió '${args.source}')`);
    }
    if (!args.diagnostic) {
      throw new Error(
        `--source='${args.source}' requiere --diagnostic, y en ese modo NO se puede aplicar`);
    }
  }
  return args;
}

function uso() {
  console.log(`
Reparación histórica de attendance_logs (dry-run por defecto).

  --from YYYY-MM-DD     desde, INCLUSIVE
  --to   YYYY-MM-DD     hasta, INCLUSIVE (incluye el día completo)
  --employee CODIGO     acotar a un empleado, para pruebas
  --limit N             tope de registros a analizar
  --out DIR             carpeta de salida (default: ./reparacion-historica)

  --apply               APLICA los cambios. Requiere --manifest
  --manifest ARCHIVO    manifest generado previamente por un dry-run
  --batch-size N        filas por transacción al aplicar (default: 500)

  --source NOMBRE       origen a analizar (default: ${repair.APPLICABLE_SOURCE})
  --diagnostic          permite --source distinto de ${repair.APPLICABLE_SOURCE}, SÓLO en dry-run

  --env ARCHIVO         .env a cargar con override (default: api/.env)
  --no-env              no cargar ningún .env; usar el entorno del shell

Sin --apply no se escribe absolutamente nada en attendance_logs.
Sólo se puede aplicar sobre source='${repair.APPLICABLE_SOURCE}'.
`);
}

// ─── Salida ───────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
function fallar(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exitCode = 1;
}

// Nombres que LEE de verdad cada conector. Los de ATT2000 son `ATT_*`, no
// `ATT2000_*`: config/att2000.js lee ATT_HOST/PORT/USER/PASSWORD/DATABASE.
// Listar los nombres equivocados hacía que un entorno bien configurado
// apareciera como "sin variables de ATT", que es justo lo contrario de lo que
// este diagnóstico tiene que decir.
const VARS_DB  = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const VARS_ATT = ['ATT_HOST', 'ATT_PORT', 'ATT_USER', 'ATT_PASSWORD', 'ATT_DATABASE'];

function informarEnv() {
  // Sólo NOMBRES de variables, nunca valores: este script se corre en
  // producción y su salida termina pegada en tickets.
  const definidas = ks => ks.filter(k => process.env[k] != null && process.env[k] !== '');
  log(`  entorno: ${ENV.modo === 'archivo' ? `${ENV.archivo} (override)` : 'shell'}`);
  if (ENV.faltante) log(`           ⚠ no existe ${ENV.archivo}; se usa el entorno del shell`);
  log(`  MySQL   definidas: ${definidas(VARS_DB).join(', ') || '(ninguna)'}`);
  log(`  ATT2000 definidas: ${definidas(VARS_ATT).join(', ') || '(ninguna)'}`);

  // Trampa real: CLAUDE.md documenta ATT2000_*, pero el conector lee ATT_*.
  // Quien siga la documentación configura variables que nadie mira.
  const conPrefijoViejo = definidas(VARS_ATT.map(k => k.replace(/^ATT_/, 'ATT2000_')));
  if (conPrefijoViejo.length && !definidas(VARS_ATT).length) {
    log(`           ⚠ hay ${conPrefijoViejo.join(', ')} definidas, pero el conector lee ATT_*`);
  }
}

function tabla(titulo, obj) {
  log(`\n${titulo}`);
  const claves = Object.keys(obj).sort();
  if (!claves.length) { log('  (sin datos)'); return; }
  for (const k of claves) {
    const partes = Object.entries(obj[k]).filter(([, v]) => v > 0).map(([s, v]) => `${s}=${v}`);
    log(`  ${k.padEnd(14)} ${partes.join('  ') || '—'}`);
  }
}

/** Candidatos de ATT2000 por código de empleado. Lanza si la fuente no responde. */
async function cargarCandidatos(codigos, queryAtt2000) {
  const porCodigo = new Map();
  let leidos = 0;
  for (const code of codigos) {
    // CONVERT(..., 120) fija el formato 'YYYY-MM-DD HH:mm:ss' del lado del
    // servidor: el driver de SQL Server también devolvería Date.
    const filas = await queryAtt2000(
      `SELECT USERID,
              CONVERT(varchar(19), CHECKTIME, 120) AS CHECKTIME,
              CHECKTYPE
         FROM CHECKINOUT WHERE USERID = @userid`,
      { userid: code }
    );
    porCodigo.set(String(code), (filas || []).map(r => ({ checktime: r.CHECKTIME, checktype: r.CHECKTYPE })));
    leidos += (filas || []).length;
  }
  return { porCodigo, leidos };
}

// ─── DRY RUN ──────────────────────────────────────────────────────
async function dryRun(args) {
  let queryAtt2000;
  try {
    ({ queryAtt2000 } = require('../src/config/att2000'));
  } catch (err) {
    fallar(`No se pudo cargar el conector de ATT2000: ${err.message}`);
    return;
  }

  // Intervalo SEMIABIERTO: [from 00:00:00, díaSiguiente(to) 00:00:00).
  // El `< 'to 23:59:59'` anterior excluía exactamente los marcajes de
  // 23:59:59, que en un reloj biométrico existen.
  const where = ['al.source = ?'];
  const params = [args.source];
  if (args.from) {
    // Validación estricta: una fecha inexistente como 2025-02-29 se
    // normalizaría en silencio y correría el rango.
    if (!repair.isCivilDate(args.from)) { fallar(`--from no es una fecha válida: ${args.from}`); return; }
    where.push('al.timestamp >= ?'); params.push(`${args.from} 00:00:00`);
  }
  if (args.to) {
    const finExclusivo = repair.nextDayISO(args.to);
    if (!finExclusivo) { fallar(`--to no es una fecha válida: ${args.to}`); return; }
    where.push('al.timestamp < ?'); params.push(`${finExclusivo} 00:00:00`);
  }
  if (args.from && args.to && args.from > args.to) {
    fallar(`el rango está invertido: --from ${args.from} es posterior a --to ${args.to}`); return;
  }
  if (args.employee) { where.push('e.code = ?'); params.push(args.employee); }

  log(`\n▶ Dry-run — source='${args.source}'${args.diagnostic ? ' [DIAGNÓSTICO: no aplicable]' : ''}`);
  log(`  rango: ${args.from || 'inicio'} … ${args.to || 'fin'} (ambos inclusive)`);
  informarEnv();

  // DATE_FORMAT devuelve la hora de pared COMO STRING. Traer la columna cruda
  // la entregaría como Date, y el driver la interpreta con el offset fijo de
  // la config: '02:42:29' llegaría como el instante 05:42:29Z y toda la
  // comparación contra ATT2000 quedaría corrida 180 minutos.
  const [logs] = await sequelize.query(`
    SELECT al.id, al.employee_id, e.code AS employee_code, al.device_id,
           al.source, DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp, al.type
    FROM attendance_logs al
    JOIN employees e ON e.id = al.employee_id
    WHERE ${where.join(' AND ')}
    ORDER BY al.timestamp ASC
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ''}
  `, { replacements: params });

  log(`\n  ${logs.length} registro(s) a analizar`);
  if (!logs.length) { log('  Nada que hacer.'); return; }

  // Claves UNIQUE ya existentes: se traen TODAS las de los empleados
  // involucrados, no sólo las del rango, porque la hora corregida puede caer
  // fuera de la ventana analizada.
  const empIds = [...new Set(logs.map(l => l.employee_id))];
  const [existentes] = await sequelize.query(`
    SELECT employee_id, DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp, device_id
    FROM attendance_logs
    WHERE employee_id IN (${empIds.map(() => '?').join(',')})
  `, { replacements: empIds });

  const existingKeys = new Set(
    existentes.map(r => repair.uniqueKey(r.employee_id, repair.toWall(r.timestamp), r.device_id))
  );
  log(`  ${existingKeys.size} clave(s) únicas existentes cargadas`);

  const codigos = [...new Set(logs.map(l => String(l.employee_code)))];
  let candidatesByCode, leidos;
  try {
    ({ porCodigo: candidatesByCode, leidos } = await cargarCandidatos(codigos, queryAtt2000));
  } catch (err) {
    fallar(`ATT2000 inaccesible: ${err.message}\n`
      + '  Sin la fuente de verdad no se puede proponer ninguna corrección. Se aborta sin escribir nada.');
    return;
  }
  log(`  ${leidos} marcaje(s) leídos de ATT2000 para ${codigos.length} empleado(s)`);

  const filas = repair.buildManifest({ logs, candidatesByCode, existingKeys });
  const resumen = repair.summarize(filas);
  const recalc = repair.recalcTargets(filas);

  // ── Informe ──
  log(`\n═══ RESUMEN ═══`);
  log(`  total ${args.source}      ${resumen.total_registros}`);
  for (const [estado, n] of Object.entries(resumen.por_estado)) log(`  ${estado.padEnd(16)} ${n}`);
  log(`  ${'APLICABLES'.padEnd(16)} ${resumen.aplicables}`);
  log(`  ${'cambian de día'.padEnd(16)} ${resumen.cambian_de_dia}  → requieren recalcular dos resúmenes`);

  tabla('Por mes:', resumen.por_mes);
  tabla('Por dispositivo:', resumen.por_device);
  tabla('Por origen:', resumen.por_source);

  log(`\n  ${recalc.length} par(es) empleado/fecha quedarían pendientes de recálculo.`);

  // ── Archivos ──
  fs.mkdirSync(args.out, { recursive: true });
  const manifest = {
    manifest_version: repair.MANIFEST_VERSION,
    repair_algorithm_version: repair.REPAIR_ALGORITHM_VERSION,
    generado: new Date().toISOString(),
    // Un manifest diagnóstico queda marcado como NO aplicable en el archivo.
    aplicable: !args.diagnostic && args.source === repair.APPLICABLE_SOURCE,
    parametros: { source: args.source, from: args.from, to: args.to, employee: args.employee },
    resumen,
    digest: repair.manifestDigest(filas),
    filas,
  };

  const fManifest = path.join(args.out, 'manifest.json');
  const fCsv      = path.join(args.out, 'manifest.csv');
  const fRecalc   = path.join(args.out, 'recalcular.json');

  fs.writeFileSync(fManifest, JSON.stringify(manifest, null, 2));

  const cols = ['attendance_log_id','employee_id','employee_code','device_id','source','type',
                'old_timestamp','proposed_timestamp','delta_minutes','status','date_changes','reason'];
  const esc = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  fs.writeFileSync(fCsv, [cols.join(';'), ...filas.map(f => cols.map(c => esc(f[c])).join(';'))].join('\r\n'));
  fs.writeFileSync(fRecalc, JSON.stringify(recalc, null, 2));

  log(`\n  Manifest  → ${fManifest}   (algoritmo v${repair.REPAIR_ALGORITHM_VERSION})`);
  log(`  CSV       → ${fCsv}`);
  log(`  Recálculo → ${fRecalc}`);
  log(`\n  DRY-RUN: no se modificó ningún registro.`);
  if (manifest.aplicable) {
    log(`  Para aplicar, revisá el manifest y ejecutá:`);
    log(`    node scripts/historical-attendance-repair.js --apply --manifest ${fManifest}\n`);
  } else {
    log(`  Manifest DIAGNÓSTICO: no se puede aplicar.\n`);
  }
}

// ─── APPLY ────────────────────────────────────────────────────────
async function apply(args) {
  if (!args.manifest) { fallar('--apply requiere --manifest con el archivo generado por un dry-run previo.'); return; }
  if (!fs.existsSync(args.manifest)) { fallar(`No existe el manifest: ${args.manifest}`); return; }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8')); }
  catch (err) { fallar(`Manifest ilegible: ${err.message}`); return; }

  if (!manifest || !Array.isArray(manifest.filas)) {
    fallar('Manifest sin el arreglo `filas`: no se aplica nada.'); return;
  }

  // ── Versiones ──
  // La regla de clasificación cambió durante el desarrollo: un manifest
  // generado con el criterio anterior propondría correcciones que el criterio
  // vigente rechazaría. No debe poder consumirse por accidente.
  if (manifest.repair_algorithm_version !== repair.REPAIR_ALGORITHM_VERSION) {
    fallar(`Manifest generado con el algoritmo v${manifest.repair_algorithm_version ?? '(sin versión)'}, `
      + `y el vigente es v${repair.REPAIR_ALGORITHM_VERSION}.\n`
      + '  Volvé a correr el dry-run para regenerarlo: el criterio de clasificación cambió.');
    return;
  }
  if (manifest.manifest_version !== repair.MANIFEST_VERSION) {
    fallar(`Formato de manifest v${manifest.manifest_version ?? '(sin versión)'}; el esperado es `
      + `v${repair.MANIFEST_VERSION}.`);
    return;
  }
  if (manifest.aplicable === false) {
    fallar('El manifest está marcado como diagnóstico (`aplicable: false`) y no puede aplicarse.'); return;
  }
  if (manifest.parametros && manifest.parametros.source !== repair.APPLICABLE_SOURCE) {
    fallar(`El manifest se generó para source='${manifest.parametros.source}'. `
      + `Sólo se puede aplicar sobre '${repair.APPLICABLE_SOURCE}'.`);
    return;
  }

  // ── Integridad del archivo ──
  // La huella global es OBLIGATORIA. Tratarla como opcional dejaba la puerta
  // abierta a borrarla y saltear la verificación por completo: con eso se
  // podían agregar, quitar o duplicar filas que ya tuvieran una huella
  // individual válida —copiadas de otro manifest, por ejemplo— sin que el
  // cambio de estructura se detectara.
  if (!manifest.digest) {
    fallar('El manifest no tiene huella global (`digest`).\n'
      + '  Sin ella no se puede verificar que no se agregaron ni quitaron filas. Regeneralo.');
    return;
  }
  if (manifest.digest !== repair.manifestDigest(manifest.filas)) {
    fallar('La huella del manifest no coincide con su contenido: el archivo fue modificado.\n'
      + '  Regeneralo con un dry-run en vez de editarlo a mano.');
    return;
  }

  let queryAtt2000;
  try { ({ queryAtt2000 } = require('../src/config/att2000')); }
  catch (err) { fallar(`No se pudo cargar el conector de ATT2000: ${err.message}`); return; }

  const aplicables = manifest.filas.filter(repair.isApplicable);
  log(`\n▶ Aplicar — ${aplicables.length} de ${manifest.filas.length} fila(s) del manifest son aplicables`);
  log(`  algoritmo v${repair.REPAIR_ALGORITHM_VERSION}, formato v${repair.MANIFEST_VERSION}`);
  informarEnv();
  if (!aplicables.length) { log('  Nada que aplicar.'); return; }

  // ── Revalidación contra la fuente de verdad ──
  // Ésta es la defensa real contra un manifest fabricado: el apply NO cree el
  // `status` del archivo. Vuelve a clasificar cada fila contra ATT2000 con el
  // algoritmo vigente y exige el mismo veredicto y la misma hora propuesta.
  // Editar a mano un AMBIGUOUS a MATCH_240 no alcanza para que se escriba.
  let candidatos;
  try {
    ({ porCodigo: candidatos } = await cargarCandidatos(
      [...new Set(aplicables.map(f => String(f.employee_code)))], queryAtt2000));
  } catch (err) {
    fallar(`ATT2000 inaccesible: ${err.message}\n`
      + '  Sin la fuente de verdad no se revalida ninguna propuesta. Se aborta sin escribir nada.');
    return;
  }

  let actualizados = 0;
  let rechazados   = 0;
  const rechazos   = [];
  const rechazar = (f, motivo) => { rechazados++; rechazos.push({ id: f.attendance_log_id, motivo }); };

  for (let i = 0; i < aplicables.length; i += args.batchSize) {
    const lote = aplicables.slice(i, i + args.batchSize);
    const t = await sequelize.transaction();
    try {
      for (const f of lote) {
        // Origen, fila por fila: el chequeo de parámetro no alcanza si el
        // archivo mezcla orígenes.
        if (f.source !== repair.APPLICABLE_SOURCE) {
          rechazar(f, `origen no autorizado: ${f.source}`); continue;
        }
        // Huella de la fila: ataja ediciones manuales del archivo.
        if (!repair.rowDigestOk(f)) {
          rechazar(f, 'huella inválida: la fila fue modificada'); continue;
        }
        // Revalidación con el algoritmo vigente.
        const re = repair.classify(
          { timestamp: f.old_timestamp, type: f.type },
          candidatos.get(String(f.employee_code)) || []
        );
        if (re.status !== f.status || re.proposed !== f.proposed_timestamp) {
          rechazar(f, `revalidación distinta: ahora ${re.status}${re.proposed ? ` → ${re.proposed}` : ''}`);
          continue;
        }

        // Revalidación del UNIQUE DENTRO de la transacción: si una ingesta
        // posterior insertó esa hora, el UPDATE chocaría con el índice y
        // voltearía el lote entero.
        const [[choque]] = await sequelize.query(`
          SELECT id FROM attendance_logs
          WHERE employee_id = ? AND timestamp = ? AND IFNULL(device_id, 0) = ? AND id <> ?
          LIMIT 1
        `, {
          replacements: [f.employee_id, f.proposed_timestamp,
                         f.device_id == null ? 0 : f.device_id, f.attendance_log_id],
          transaction: t,
        });
        if (choque) { rechazar(f, `colisión sobrevenida con el registro ${choque.id}`); continue; }

        // Guard optimista sobre TODOS los campos que intervinieron en la
        // decisión. El valor se escribe como STRING de hora de pared: pasar un
        // Date haría que el driver lo convierta y reintroduciría el defecto.
        let meta;
        try {
          ([, meta] = await sequelize.query(`
            UPDATE attendance_logs
            SET timestamp = ?
            WHERE id = ?
              AND timestamp = ?
              AND source = ?
              AND employee_id = ?
              AND IFNULL(device_id, 0) = ?
              AND type = ?
          `, {
            replacements: [f.proposed_timestamp, f.attendance_log_id, f.old_timestamp, f.source,
                           f.employee_id, f.device_id == null ? 0 : f.device_id, f.type],
            transaction: t,
          }));
        } catch (err) {
          if (/duplicate/i.test(err.message) || err?.parent?.code === 'ER_DUP_ENTRY') {
            rechazar(f, 'colisión UNIQUE al escribir'); continue;
          }
          throw err;
        }

        // `affectedRows` cuenta las filas que MATCHEARON el WHERE.
        const n = (meta && meta.affectedRows) ?? 0;
        if (n === 1) actualizados++;
        else rechazar(f, 'el registro cambió desde el dry-run');
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      fallar(`Error aplicando el lote ${i}–${i + lote.length}: ${err.message}\n`
        + `  Ese lote se revirtió completo. Confirmados hasta ahora: ${actualizados}.`);
      return;
    }
    log(`  lote ${i + 1}–${i + lote.length}: ok`);
  }

  log(`\n═══ RESULTADO ═══`);
  log(`  actualizados  ${actualizados}`);
  log(`  rechazados    ${rechazados}`);
  for (const r of rechazos.slice(0, 20)) log(`    #${r.id}: ${r.motivo}`);
  if (rechazos.length > 20) log(`    … y ${rechazos.length - 20} más`);
  log(`\n  NO se recalcularon resúmenes. La lista está en recalcular.json,`);
  log(`  junto al manifest, para ejecutarla como paso aparte.\n`);
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { fallar(err.message); uso(); return; }

  if (args.help) { uso(); return; }

  try {
    if (args.apply) await apply(args);
    else await dryRun(args);
  } finally {
    await sequelize.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(err => {
    fallar(`Error inesperado: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, dryRun, apply, cargarEnv };
