#!/usr/bin/env node
/**
 * read-zkteco-now.js — Lectura DIRECTA de relojes ZKTeco → SisHoras, por rango.
 *
 *   node scripts/read-zkteco-now.js --from 2026-07-14 --to 2026-07-16
 *   node scripts/read-zkteco-now.js --from 2026-07-14                 # hasta hoy
 *   node scripts/read-zkteco-now.js                                   # últimos 3 días
 *   node scripts/read-zkteco-now.js --from 2026-07-14 --dry-run       # sin insertar
 *   node scripts/read-zkteco-now.js --device-id 2 --timeout 600       # sólo un reloj, 10 min
 *
 * Flags:
 *   --from YYYY-MM-DD   inicio del rango (hora Paraguay). Default: hace 3 días.
 *   --to   YYYY-MM-DD   fin del rango INCLUSIVO (todo el día, 00:00 → 23:59:59).
 *   --dry-run           NO inserta ni recalcula; muestra qué importaría.
 *   --debug-raw         vuelca registros crudos (primeros 5 / últimos 20),
 *                       campos detectados y últimos 20 normalizados; imprime
 *                       contadores (conFecha/sinFecha/conUser/enRango/fueraRango)
 *                       y el rango de fechas válidas presentes en el reloj.
 *   --show-unmapped     lista los deviceUserId sin empleado (top 30) con conteo
 *                       y pista si existen en employees por otra columna/estado.
 *   --attempts N        lee N veces y usa la MEJOR lectura por (en-rango, fecha
 *                       válida más reciente, más válidos). Default 3. Mitiga
 *                       lecturas inestables/truncadas del reloj.
 *   --mode auto|tcp|udp fuerza el protocolo SÓLO en esta corrida (no persiste).
 *                       Útil para GT200/Granding que a veces requieren UDP para
 *                       descargar marcaciones aunque TCP responda al diagnóstico.
 *   --device-id N[,M]   limita a esos relojes (evita que uno lento bloquee).
 *   --timeout SEG       timeout de lectura por reloj en segundos (default 180).
 *
 * Corre en el SERVIDOR, sin pasar por Nginx (evita el 504 de una request web
 * larga). Lee sólo relojes válidos (con IP), filtra el buffer del reloj al
 * rango pedido, guarda source='zkteco_direct', deduplica cross-source y
 * recalcula daily_summary de las fechas afectadas.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { backupAllDevices } = require('../src/services/zktecoReader');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// Offset UTC de America/Asuncion (minutos) para un instante dado.
function pyUtcOffsetMin(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Asuncion', timeZoneName: 'longOffset',
  }).formatToParts(d);
  const tzn = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-03:00';
  const m = tzn.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return -180;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2] || '0', 10) * 60 + parseInt(m[3] || '0', 10));
}
// Convierte una hora de pared de Paraguay (YYYY-MM-DD HH:MM:SS) a instante UTC.
function pyWallToUTC(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s] = timeStr.split(':').map(Number);
  const asIfUTC = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = pyUtcOffsetMin(new Date(asIfUTC));
  return new Date(asIfUTC - off * 60000);
}

(async () => {
  const to = arg('to', new Date().toISOString().slice(0, 10));
  const from = arg('from', new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
  const dryRun = flag('dry-run');
  const debugRaw = flag('debug-raw');
  const showUnmapped = flag('show-unmapped');
  const attempts = Math.max(1, parseInt(arg('attempts', '3'), 10) || 3);
  const modeArg = (arg('mode', '') || '').toLowerCase();
  const mode = ['auto', 'tcp', 'udp'].includes(modeArg) ? modeArg : null;
  const timeoutSec = parseInt(arg('timeout', '180'), 10);
  const readTimeoutMs = (isNaN(timeoutSec) ? 180 : timeoutSec) * 1000;
  const deviceIdArg = arg('device-id', null);
  const deviceIds = deviceIdArg
    ? deviceIdArg.split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n))
    : null;

  if (!isDate(from) || !isDate(to)) {
    console.error('Uso: node scripts/read-zkteco-now.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--debug-raw] [--show-unmapped] [--device-id N] [--timeout SEG] [--attempts N]');
    process.exit(1);
  }

  // Límites REALES del rango (hora de pared PY → UTC), para verificar que el
  // día final se incluye completo (00:00:00 → 23:59:59).
  const fromLocal = `${from} 00:00:00`;
  const toLocal = `${to} 23:59:59`;
  const fromUTC = pyWallToUTC(from, '00:00:00');
  const toUTC = pyWallToUTC(to, '23:59:59');

  console.log(`Lectura directa de relojes → SisHoras${dryRun ? '  [DRY-RUN — no inserta]' : ''}`);
  console.log(`Rango (hora Paraguay): ${fromLocal}  …  ${toLocal}`);
  console.log(`Rango (UTC)         : ${fromUTC.toISOString()}  …  ${toUTC.toISOString()}`);
  console.log(`Timeout por reloj   : ${readTimeoutMs / 1000}s${deviceIds ? `  ·  Relojes: [${deviceIds.join(', ')}]` : ''}\n`);

  if (mode) console.log(`Forzando connection_mode = ${mode} (sólo esta corrida)\n`);
  const out = await backupAllDevices({
    from, to, recalc: !dryRun, dryRun, debugRaw, showUnmapped, attempts, readTimeoutMs, deviceIds, mode,
  });

  for (const r of out.results) {
    if (!r.ok) {
      console.error(`❌ [#${r.device_id}] ${r.device} (${r.ip}) · ${r.error}`);
      continue;
    }
    const dur = r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : '';
    const icon = dryRun ? '🔎' : '✅';
    const imp = dryRun ? `importaría=${r.would_import}` : `importados=${r.imported}`;
    console.log(`${icon} [#${r.device_id}] ${r.device} (${r.ip}) · leídos=${r.total_read} basura=${r.junk} válidos=${r.valid} conFecha=${r.with_date} enRango=${r.in_range} fueraRango=${r.out_of_range} ${imp} dup=${r.skipped} sinEmp=${r.notFound}${dur}`);
    if (r.first_valid || r.last_valid) {
      console.log(`     rango de fechas VÁLIDAS (sin basura): ${r.first_valid || '—'}  →  ${r.last_valid || '—'}`);
    }
    if (r.match_columns && r.match_columns.length) {
      console.log(`     columnas de mapeo empleado: ${r.match_columns.join(', ')}`);
    }
    if (r.read_unstable) {
      const ra = r.read_attempts;
      console.log(`     ⚠️  LECTURA INESTABLE entre intentos${ra ? ` (válidos: ${ra.valids.join(', ')})` : ''}. Se usó la de mayor cantidad válida. Probá --attempts 3.`);
    }
    if (r.total_read > 0 && r.valid === 0) {
      console.log(`     ⚠️  Se leyeron ${r.total_read} registros pero TODOS eran basura (relleno userSn=0 / fecha 2000).`);
      console.log(`         Corré:  node scripts/inspect-zkteco-raw.js --device-id ${r.device_id} --limit 20`);
    } else if (r.valid > 0 && r.in_range === 0) {
      console.log(`     ⚠️  ${r.valid} registros válidos, pero 0 en el rango pedido.`);
      console.log(`         Si first_valid/last_valid muestran un año raro, el reloj tiene la FECHA mal configurada.`);
    }
    if (r.warn_unmapped) {
      console.log(`     🚨 La MAYORÍA de las marcas en rango (${r.notFound}/${r.in_range}) NO se importó por falta de mapeo deviceUserId→empleado.`);
      console.log(`        Revisá el mapeo con:  node scripts/diagnose-device-mapping.js --device-id ${r.device_id} --from ${from} --to ${to}`);
    }
    if (r.dates && r.dates.length) console.log(`     fechas afectadas: ${r.dates.join(', ')}`);
    if (dryRun && r.sample && r.sample.length) {
      for (const s of r.sample) console.log(`     · ${s.ts_py}  emp#${s.employee_id}  ${s.type}`);
    }

    // Top de deviceUserId sin empleado (con pista si existe por otra columna/estado).
    if (showUnmapped && r.unmapped_top && r.unmapped_top.length) {
      console.log(`     ── deviceUserId SIN empleado (top ${r.unmapped_top.length} de ${r.unmapped_distinct}) ──`);
      for (const u of r.unmapped_top) {
        const hint = u.employee
          ? `→ existe emp#${u.employee.id} por '${u.employee.via}' (status=${u.employee.status})`
          : '→ no existe en employees por ninguna columna';
        console.log(`        ${u.device_user_id}  (x${u.count})  ${hint}`);
      }
    }

    // Volcado de depuración detallado.
    if (debugRaw && r.debug) {
      console.log(`     ── DEBUG RAW ──`);
      console.log(`     campos detectados: ${r.debug.detected_fields.length ? r.debug.detected_fields.join(', ') : '(ninguno conocido)'}`);
      console.log(`     primeros ${r.debug.raw_first5.length} registros RAW:`);
      for (const s of r.debug.raw_first5) console.log(`       ${s}`);
      console.log(`     últimos ${r.debug.raw_last20.length} registros RAW:`);
      for (const s of r.debug.raw_last20) console.log(`       ${s}`);
      console.log(`     últimos ${r.debug.normalized_last20.length} normalizados:`);
      for (const n of r.debug.normalized_last20) console.log(`       ${n.ts_py}  user ${n.user}  io=${n.inout}`);
    }
  }

  console.log(`\n── Resumen ──`);
  const impT = dryRun ? `Importaría: ${out.totals.would_import}` : `Importados: ${out.totals.imported}`;
  console.log(`Relojes: ${out.devices} · En rango: ${out.totals.in_range} · ${impT} · Duplicados: ${out.totals.skipped} · Sin empleado: ${out.totals.notFound} · Basura: ${out.totals.junk}`);
  if (out.totals.in_range > 0 && out.totals.notFound / out.totals.in_range > 0.5) {
    console.log(`🚨 ATENCIÓN: la mayoría de las marcas en rango NO se importó por falta de mapeo empleado. Corré diagnose-device-mapping.js.`);
  }

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
