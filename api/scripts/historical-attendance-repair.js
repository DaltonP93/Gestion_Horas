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
const { sequelize } = require('../src/config/database');
const repair = require('../src/services/historicalRepair');

// ─── Argumentos ───────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    apply: false, manifest: null, out: './reparacion-historica',
    from: null, to: null, source: 'device', employee: null, limit: null,
    batchSize: 500,
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
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  return args;
}

function uso() {
  console.log(`
Reparación histórica de attendance_logs (dry-run por defecto).

  --from YYYY-MM-DD     desde (inclusive)
  --to   YYYY-MM-DD     hasta (inclusive)
  --source NOMBRE       origen a reparar (default: device)
  --employee CODIGO     acotar a un empleado, para pruebas
  --limit N             tope de registros a analizar
  --out DIR             carpeta de salida del manifest (default: ./reparacion-historica)

  --apply               APLICA los cambios. Requiere --manifest
  --manifest ARCHIVO    manifest generado previamente por un dry-run
  --batch-size N        filas por transacción al aplicar (default: 500)

Sin --apply no se escribe absolutamente nada en attendance_logs.
`);
}

// ─── Salida ───────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
function fallar(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exitCode = 1;
}

function tabla(titulo, obj) {
  log(`\n${titulo}`);
  const claves = Object.keys(obj).sort();
  if (!claves.length) { log('  (sin datos)'); return; }
  for (const k of claves) {
    const fila = obj[k];
    const partes = Object.entries(fila).filter(([, v]) => v > 0).map(([s, v]) => `${s}=${v}`);
    log(`  ${k.padEnd(14)} ${partes.join('  ') || '—'}`);
  }
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

  const where = ['al.source = ?'];
  const params = [args.source];
  if (args.from)     { where.push('al.timestamp >= ?'); params.push(`${args.from} 00:00:00`); }
  if (args.to)       { where.push('al.timestamp <  ?'); params.push(`${args.to} 23:59:59`); }
  if (args.employee) { where.push('e.code = ?');        params.push(args.employee); }

  log(`\n▶ Dry-run — source='${args.source}'${args.from ? ` desde ${args.from}` : ''}${args.to ? ` hasta ${args.to}` : ''}`);

  // DATE_FORMAT devuelve la hora de pared COMO STRING. Traer la columna
  // cruda la entregaría como Date, y el driver la interpreta con el offset
  // fijo de la config: '02:42:29' llegaría como el instante 05:42:29Z y toda
  // la comparación contra ATT2000 quedaría corrida 180 minutos.
  const [logs] = await sequelize.query(`
    SELECT al.id, al.employee_id, e.code AS employee_code, al.device_id,
           al.source, DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp, al.type
    FROM attendance_logs al
    JOIN employees e ON e.id = al.employee_id
    WHERE ${where.join(' AND ')}
    ORDER BY al.timestamp ASC
    ${args.limit ? `LIMIT ${Number(args.limit)}` : ''}
  `, { replacements: params });

  log(`  ${logs.length} registro(s) a analizar`);
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

  // Candidatos de ATT2000 por código de empleado.
  const codigos = [...new Set(logs.map(l => String(l.employee_code)))];
  const candidatesByCode = new Map();
  let leidos = 0;
  for (const code of codigos) {
    try {
      const filas = await queryAtt2000(
        // CONVERT(..., 120) fija el formato 'YYYY-MM-DD HH:mm:ss' del lado
        // del servidor: el driver de SQL Server también devolvería Date.
        `SELECT USERID,
                CONVERT(varchar(19), CHECKTIME, 120) AS CHECKTIME,
                CHECKTYPE
           FROM CHECKINOUT WHERE USERID = @userid`,
        { userid: code }
      );
      candidatesByCode.set(code, (filas || []).map(r => ({ checktime: r.CHECKTIME, checktype: r.CHECKTYPE })));
      leidos += (filas || []).length;
    } catch (err) {
      fallar(`ATT2000 inaccesible al consultar el código ${code}: ${err.message}\n`
        + '  Sin la fuente de verdad no se puede proponer ninguna corrección. Se aborta sin escribir nada.');
      return;
    }
  }
  log(`  ${leidos} marcaje(s) leídos de ATT2000 para ${codigos.length} empleado(s)`);

  const filas = repair.buildManifest({ logs, candidatesByCode, existingKeys });
  const resumen = repair.summarize(filas);
  const recalc = repair.recalcTargets(filas);

  // ── Informe ──
  log(`\n═══ RESUMEN ═══`);
  log(`  total ${args.source}      ${resumen.total_registros}`);
  for (const [estado, n] of Object.entries(resumen.por_estado)) {
    log(`  ${estado.padEnd(16)} ${n}`);
  }
  log(`  ${'APLICABLES'.padEnd(16)} ${resumen.aplicables}`);
  log(`  ${'cambian de día'.padEnd(16)} ${resumen.cambian_de_dia}  → requieren recalcular dos resúmenes`);

  tabla('Por mes:', resumen.por_mes);
  tabla('Por dispositivo:', resumen.por_device);
  tabla('Por origen:', resumen.por_source);

  log(`\n  ${recalc.length} par(es) empleado/fecha quedarían pendientes de recálculo.`);

  // ── Archivos ──
  fs.mkdirSync(args.out, { recursive: true });
  const manifest = {
    generado: new Date().toISOString(),
    parametros: { source: args.source, from: args.from, to: args.to, employee: args.employee },
    resumen,
    filas,
  };
  const fManifest = path.join(args.out, 'manifest.json');
  const fCsv      = path.join(args.out, 'manifest.csv');
  const fRecalc   = path.join(args.out, 'recalcular.json');

  fs.writeFileSync(fManifest, JSON.stringify(manifest, null, 2));

  const cols = ['attendance_log_id','employee_id','employee_code','device_id','source',
                'old_timestamp','proposed_timestamp','delta_minutes','status','date_changes','reason'];
  const esc = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  fs.writeFileSync(fCsv, [cols.join(';'), ...filas.map(f => cols.map(c => esc(f[c])).join(';'))].join('\r\n'));

  fs.writeFileSync(fRecalc, JSON.stringify(recalc, null, 2));

  log(`\n  Manifest  → ${fManifest}`);
  log(`  CSV       → ${fCsv}`);
  log(`  Recálculo → ${fRecalc}`);
  log(`\n  DRY-RUN: no se modificó ningún registro.`);
  log(`  Para aplicar, revisá el manifest y ejecutá:`);
  log(`    node scripts/historical-attendance-repair.js --apply --manifest ${fManifest}\n`);
}

// ─── APPLY ────────────────────────────────────────────────────────
async function apply(args) {
  if (!args.manifest) {
    fallar('--apply requiere --manifest con el archivo generado por un dry-run previo.');
    return;
  }
  if (!fs.existsSync(args.manifest)) {
    fallar(`No existe el manifest: ${args.manifest}`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  } catch (err) {
    fallar(`Manifest ilegible: ${err.message}`);
    return;
  }
  if (!manifest || !Array.isArray(manifest.filas)) {
    fallar('Manifest sin el arreglo `filas`: no se aplica nada.');
    return;
  }

  const aplicables = manifest.filas.filter(repair.isApplicable);
  log(`\n▶ Aplicar — ${aplicables.length} de ${manifest.filas.length} fila(s) del manifest son aplicables`);
  if (!aplicables.length) { log('  Nada que aplicar.'); return; }

  let actualizados = 0;
  let rechazados   = 0;
  const rechazos   = [];

  for (let i = 0; i < aplicables.length; i += args.batchSize) {
    const lote = aplicables.slice(i, i + args.batchSize);
    const t = await sequelize.transaction();
    try {
      for (const f of lote) {
        // Revalidación del UNIQUE DENTRO de la transacción. El conjunto de
        // claves del dry-run refleja el momento en que se generó el manifest:
        // si una ingesta posterior insertó esa hora, el UPDATE chocaría con
        // el índice y voltearía el lote entero. Se detecta antes y se rechaza
        // sólo esa fila.
        const [[choque]] = await sequelize.query(`
          SELECT id FROM attendance_logs
          WHERE employee_id = ?
            AND timestamp = ?
            AND IFNULL(device_id, 0) = ?
            AND id <> ?
          LIMIT 1
        `, {
          replacements: [
            f.employee_id, f.proposed_timestamp,
            f.device_id == null ? 0 : f.device_id, f.attendance_log_id,
          ],
          transaction: t,
        });
        if (choque) {
          rechazados++;
          rechazos.push({ id: f.attendance_log_id, motivo: `colisión sobrevenida con el registro ${choque.id}` });
          continue;
        }

        // Guard optimista sobre TODOS los campos que intervinieron en la
        // decisión, no sólo el timestamp. Si entre el dry-run y ahora
        // cambiaron el empleado, el dispositivo o el tipo, la propuesta ya no
        // corresponde: una reasignación de empleado aplicaría una hora
        // deducida del USERID anterior.
        //
        // El valor se escribe como STRING de hora de pared. Pasar un Date
        // haría que el driver lo convierta otra vez y reintroduciría el mismo
        // defecto que se está reparando.
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
            replacements: [
              f.proposed_timestamp, f.attendance_log_id, f.old_timestamp, f.source,
              f.employee_id, f.device_id == null ? 0 : f.device_id, f.type,
            ],
            transaction: t,
          }));
        } catch (err) {
          // Carrera perdida contra otra inserción: se aísla por fila en vez
          // de tumbar el lote.
          if (/duplicate/i.test(err.message) || err?.parent?.code === 'ER_DUP_ENTRY') {
            rechazados++;
            rechazos.push({ id: f.attendance_log_id, motivo: 'colisión UNIQUE al escribir' });
            continue;
          }
          throw err;
        }

        // `affectedRows` cuenta las filas que MATCHEARON el WHERE; changedRows
        // sólo las que cambiaron de valor. Acá interesa el primero: una fila
        // que matcheó pero cuyo valor ya era el propuesto no es un rechazo.
        const n = (meta && meta.affectedRows) ?? 0;
        if (n === 1) actualizados++;
        else { rechazados++; rechazos.push({ id: f.attendance_log_id, motivo: 'el registro cambió desde el dry-run' }); }
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      // Fail loud: se aborta y se informa. Lo ya confirmado queda aplicado y
      // el manifest permite reanudar; volver a correrlo es idempotente porque
      // el guard exige el old_timestamp original.
      fallar(`Error aplicando el lote ${i}–${i + lote.length}: ${err.message}\n`
        + `  Ese lote se revirtió completo. Confirmados hasta ahora: ${actualizados}.`);
      return;
    }
    log(`  lote ${i + 1}–${i + lote.length}: ok`);
  }

  log(`\n═══ RESULTADO ═══`);
  log(`  actualizados  ${actualizados}`);
  log(`  rechazados    ${rechazados}   (guard optimista: cambiaron desde el dry-run)`);
  if (rechazos.length) {
    log(`  ids rechazados: ${rechazos.slice(0, 20).map(r => r.id).join(', ')}${rechazos.length > 20 ? ' …' : ''}`);
  }
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

module.exports = { parseArgs, dryRun, apply };
