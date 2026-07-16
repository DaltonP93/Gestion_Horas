#!/usr/bin/env node
/**
 * inspect-zkteco-logs.js — Diagnóstico READ-ONLY de relojes ZKTeco.
 *
 * NO inserta nada, NO recalcula, NO toca devices.last_sync ni att2000.
 * Sólo se conecta a cada reloj y reporta si sigue registrando marcas.
 *
 *   node scripts/inspect-zkteco-logs.js                    # todos los relojes
 *   node scripts/inspect-zkteco-logs.js --device-id 2      # sólo Lavadero
 *   node scripts/inspect-zkteco-logs.js --timeout 600      # 10 min por reloj
 *   node scripts/inspect-zkteco-logs.js --days 20          # histograma 20 días
 *
 * Flags:
 *   --device-id N[,M]  limita a esos relojes (útil si uno es lento).
 *   --timeout SEG      timeout de lectura por reloj en segundos (default 60).
 *   --days N           cuántos días mostrar en el histograma (default 12).
 *   --sample N         cuántas marcas recientes listar (default 20).
 *
 * Por cada reloj muestra: conexión OK/fallo, cantidad leída, primera/última
 * marca cruda, últimas N marcas, conteo por día de las marcas recientes,
 * hora del reloj (si la librería lo permite) y duración de la lectura.
 *
 * OBJETIVO: verificar si los relojes dejaron de guardar marcas (p.ej. después
 * del 13/07). Si la última marca cruda es vieja, el problema es del reloj/red,
 * NO de SisHoras.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { readDeviceRaw } = require('../src/services/zktecoReader');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

(async () => {
  const timeoutSec = parseInt(arg('timeout', '60'), 10);
  const timeoutMs = (isNaN(timeoutSec) ? 60 : timeoutSec) * 1000;
  const recentDays = parseInt(arg('days', '12'), 10) || 12;
  const recentSample = parseInt(arg('sample', '20'), 10) || 20;
  const deviceIdArg = arg('device-id', null);
  const deviceIds = deviceIdArg
    ? deviceIdArg.split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n))
    : null;

  let sql = "SELECT * FROM devices WHERE ip_address IS NOT NULL AND TRIM(ip_address) <> ''";
  const replacements = [];
  if (deviceIds && deviceIds.length) {
    sql += ` AND id IN (${deviceIds.map(() => '?').join(',')})`;
    replacements.push(...deviceIds);
  }
  sql += ' ORDER BY id';
  const [devices] = await sequelize.query(sql, { replacements });

  console.log(`Diagnóstico READ-ONLY de relojes ZKTeco (no escribe nada)`);
  console.log(`Relojes: ${devices.length} · Timeout por reloj: ${timeoutMs / 1000}s${deviceIds ? ` · Filtro: [${deviceIds.join(', ')}]` : ''}\n`);

  for (const device of devices) {
    const r = await readDeviceRaw(device, { timeoutMs, recentDays, recentSample });
    const dur = `${(r.duration_ms / 1000).toFixed(1)}s`;
    console.log('─'.repeat(72));
    console.log(`[#${r.device_id}] ${r.device}  (${r.ip}:${r.port} · ${r.connection_mode})`);

    if (!r.connected) {
      console.error(`  ❌ SIN CONEXIÓN tras ${dur}: ${r.error}`);
      console.log('');
      continue;
    }

    console.log(`  ✅ Conectado · leídas=${r.total_read} · lectura ${dur}`);
    if (r.device_time) console.log(`  🕒 Hora del reloj: ${r.device_time}`);
    if (r.first_mark) console.log(`  ⏮  Primera marca: ${r.first_mark.ts_py}  (user ${r.first_mark.user_id})`);
    if (r.last_mark)  console.log(`  ⏭  Última marca : ${r.last_mark.ts_py}  (user ${r.last_mark.user_id})`);

    if (r.per_day.length) {
      console.log(`  📅 Marcas por día (más recientes):`);
      for (const d of r.per_day) console.log(`       ${d.date}: ${d.count}`);
    }

    if (r.recent.length) {
      console.log(`  🔎 Últimas ${r.recent.length} marcas crudas:`);
      for (const m of r.recent) console.log(`       ${m.ts_py}  user ${m.user_id}  io=${m.in_out}`);
    } else {
      console.log(`  ⚠️  El reloj no devolvió ninguna marca.`);
    }
    console.log('');
  }

  console.log('─'.repeat(72));
  console.log('Nota: si la "Última marca" es vieja (p.ej. 2026-07-13), el reloj');
  console.log('dejó de registrar marcas — el problema es del reloj/red, no de SisHoras.');

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
