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
  const timeoutSec = parseInt(arg('timeout', '180'), 10);
  const readTimeoutMs = (isNaN(timeoutSec) ? 180 : timeoutSec) * 1000;
  const deviceIdArg = arg('device-id', null);
  const deviceIds = deviceIdArg
    ? deviceIdArg.split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n))
    : null;

  if (!isDate(from) || !isDate(to)) {
    console.error('Uso: node scripts/read-zkteco-now.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--device-id N] [--timeout SEG]');
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

  const out = await backupAllDevices({
    from, to, recalc: !dryRun, dryRun, readTimeoutMs, deviceIds,
  });

  for (const r of out.results) {
    if (!r.ok) {
      console.error(`❌ [#${r.device_id}] ${r.device} (${r.ip}) · ${r.error}`);
      continue;
    }
    const dur = r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : '';
    if (dryRun) {
      console.log(`🔎 [#${r.device_id}] ${r.device} (${r.ip}) · leídos=${r.total_read} enRango=${r.in_range} importaría=${r.would_import} dup=${r.skipped} sinEmp=${r.notFound}${r.dates.length ? ` · fechas: ${r.dates.join(', ')}` : ''}${dur}`);
      if (r.sample && r.sample.length) {
        for (const s of r.sample) console.log(`     · ${s.ts_py}  emp#${s.employee_id}  ${s.type}`);
      }
    } else {
      console.log(`✅ [#${r.device_id}] ${r.device} (${r.ip}) · leídos=${r.total_read} enRango=${r.in_range} importados=${r.imported} dup=${r.skipped} sinEmp=${r.notFound}${r.dates.length ? ` · fechas: ${r.dates.join(', ')}` : ''}${dur}`);
    }
  }

  console.log(`\n── Resumen ──`);
  if (dryRun) {
    console.log(`Relojes: ${out.devices} · Importaría: ${out.totals.would_import} · Duplicados: ${out.totals.skipped} · Sin empleado: ${out.totals.notFound}`);
  } else {
    console.log(`Relojes: ${out.devices} · Importados: ${out.totals.imported} · Duplicados: ${out.totals.skipped} · Sin empleado: ${out.totals.notFound}`);
  }

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
