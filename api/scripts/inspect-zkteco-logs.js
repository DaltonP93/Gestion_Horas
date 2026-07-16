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
 * Por cada reloj muestra: conexión OK/fallo, cantidad leída, VOLCADO CRUDO
 * (tipo/keys del resultado, campos detectados, primer y últimos registros sin
 * normalizar), primera/última marca normalizada, últimas N marcas, conteo por
 * día, info del reloj y duración. Si la lectura falla, prueba conexión TCP/UDP
 * por separado y da una recomendación operativa.
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
      console.error(`  ❌ FALLO DE LECTURA tras ${dur}: ${r.error}`);
      if (r.probes) {
        console.log(`  🔌 Prueba de conexión por modo:`);
        for (const p of r.probes) console.log(`       ${p.mode.toUpperCase()}: ${p.ok ? 'OK (socket abre)' : `FALLA — ${p.error}`}`);
      }
      if (r.recommendation) console.log(`  💡 ${r.recommendation}`);
      console.log('');
      continue;
    }

    console.log(`  ✅ Conectado · leídas=${r.total_read} · lectura ${dur}`);
    if (r.device_info) console.log(`  ℹ️  Info del reloj: ${JSON.stringify(r.device_info)}`);

    // (A) Volcado CRUDO — lo que realmente devuelve la librería.
    if (r.raw) {
      console.log(`  🧪 RAW getAttendances(): type=${r.raw.result_type} keys=${r.raw.result_keys ? r.raw.result_keys.join(',') : '(array)'} · data.isArray=${r.raw.data_is_array} · data.length=${r.raw.data_length}`);
      console.log(`     campos detectados: ${r.raw.detected_fields.length ? r.raw.detected_fields.join(', ') : '(ninguno conocido)'}`);
      if (r.raw.first) console.log(`     primer registro RAW: ${r.raw.first}`);
      if (r.raw.last && r.raw.last.length) {
        console.log(`     últimos ${r.raw.last.length} registros RAW:`);
        for (const s of r.raw.last) console.log(`       ${s}`);
      }
    }

    if (r.first_mark) console.log(`  ⏮  Primera marca (normalizada): ${r.first_mark.ts_py}  (user ${r.first_mark.user_id})`);
    if (r.last_mark)  console.log(`  ⏭  Última marca  (normalizada): ${r.last_mark.ts_py}  (user ${r.last_mark.user_id})`);

    if (r.per_day.length) {
      console.log(`  📅 Marcas por día (más recientes):`);
      for (const d of r.per_day) console.log(`       ${d.date}: ${d.count}`);
    }

    if (r.recent.length) {
      console.log(`  🔎 Últimas ${r.recent.length} marcas normalizadas:`);
      for (const m of r.recent) console.log(`       ${m.ts_py}  user ${m.user_id}  io=${m.in_out}`);
    } else if (r.total_read > 0) {
      console.log(`  ⚠️  Se leyeron ${r.total_read} registros pero ninguno tenía timestamp reconocible.`);
      console.log(`      Revisá el "primer registro RAW" de arriba para ver los nombres de campo reales.`);
    } else {
      console.log(`  ⚠️  El reloj no devolvió ninguna marca.`);
    }
    console.log('');
  }

  console.log('─'.repeat(72));
  console.log('Notas:');
  console.log(' · Si la "Última marca (normalizada)" es vieja (p.ej. 2026-07-13), el reloj');
  console.log('   dejó de registrar — el problema es del reloj/red, no de SisHoras.');
  console.log(' · Si hay leídas>0 pero 0 normalizadas, el bug es de parseo: mirá el RAW.');
  console.log(' · TIMEOUT_ON_WRITING con socket que abre = el reloj está tomado por otro');
  console.log('   software (p.ej. Attendance Management) o saturado; liberalo y reintentá.');

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
