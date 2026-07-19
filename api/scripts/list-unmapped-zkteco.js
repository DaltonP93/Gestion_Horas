#!/usr/bin/env node
/**
 * list-unmapped-zkteco.js — Lista marcas crudas SIN empleado (staging).
 *
 * READ-ONLY. Lee raw_device_punches con mapping_status='unmapped' y agrupa por
 * (reloj, device_user_id) para saber a quién falta mapear.
 *
 *   node scripts/list-unmapped-zkteco.js
 *   node scripts/list-unmapped-zkteco.js --from 2026-07-16 --to 2026-07-16
 *   node scripts/list-unmapped-zkteco.js --device-id 1
 *
 * Muestra por device_user_id: cantidad de marcas, primera/última, reloj, userSn,
 * candidato en employees por code/employee_number y si ya existe mapeo activo.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { buildEmployeeMatcher } = require('../src/services/zktecoReader');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

(async () => {
  const from = arg('from', null);
  const to = arg('to', null);
  const deviceId = arg('device-id', null);
  if ((from && !isDate(from)) || (to && !isDate(to))) { console.error('--from/--to deben ser YYYY-MM-DD'); process.exit(1); }

  const where = ["mapping_status = 'unmapped'"];
  const repl = [];
  if (from) { where.push('record_time_py >= ?'); repl.push(`${from} 00:00:00`); }
  if (to) { where.push('record_time_py <= ?'); repl.push(`${to} 23:59:59`); }
  if (deviceId) { where.push('device_id = ?'); repl.push(parseInt(deviceId, 10)); }

  const [rows] = await sequelize.query(
    `SELECT r.device_id, d.name AS device_name, r.device_user_id,
            MIN(r.user_sn) AS user_sn, COUNT(*) AS marcas,
            MIN(r.record_time_py) AS first_py, MAX(r.record_time_py) AS last_py
     FROM raw_device_punches r
     LEFT JOIN devices d ON d.id = r.device_id
     WHERE ${where.join(' AND ')}
     GROUP BY r.device_id, d.name, r.device_user_id
     ORDER BY marcas DESC`,
    { replacements: repl }
  );

  console.log(`Marcaciones SIN empleado (staging)${from || to ? ` · ${from || '…'} → ${to || '…'}` : ''}${deviceId ? ` · reloj #${deviceId}` : ''}`);
  console.log(`deviceUserId distintos sin mapear: ${rows.length}\n`);
  if (!rows.length) {
    const [any] = await sequelize.query('SELECT COUNT(*) AS n FROM raw_device_punches');
    console.log(any[0].n > 0 ? '✅ No hay marcas sin empleado en ese filtro.' : 'ℹ️  La tabla raw_device_punches está vacía (todavía no se importó nada tras la migración).');
    await sequelize.close(); process.exit(0);
  }

  const matcher = await buildEmployeeMatcher();
  console.log(`   deviceUserId | userSn | marcas | primera → última            | reloj | candidato employees`);
  for (const r of rows) {
    const alt = matcher.any.get(String(r.device_user_id));
    const cand = alt ? `emp#${alt.id} via '${alt.via}' (${alt.status})` : 'sin candidato';
    console.log(`   ${String(r.device_user_id).padEnd(12)} | ${String(r.user_sn ?? '').padStart(6)} | ${String(r.marcas).padStart(6)} | ${String(r.first_py).slice(0, 16)} → ${String(r.last_py).slice(0, 16)} | ${String(r.device_name || r.device_id).padEnd(8)} | ${cand}`);
  }

  console.log('');
  console.log('Para mapear: creá una fila en employee_device_map (device_id, device_user_id, employee_id)');
  console.log('o corregí employees.code/employee_number, y luego:');
  console.log('  node scripts/reprocess-unmapped-punches.js --from ' + (from || 'YYYY-MM-DD') + ' --to ' + (to || 'YYYY-MM-DD'));

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
