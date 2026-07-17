#!/usr/bin/env node
/**
 * reprocess-unmapped-punches.js — Reprocesa marcas crudas sin empleado.
 *
 * Toma raw_device_punches con mapping_status IN ('unmapped') (opcionalmente por
 * rango), reintenta el mapeo (employee_device_map → code → employee_number),
 * crea attendance_logs para las que ahora sí mapean, enlaza el staging y
 * recalcula daily_summary de las fechas afectadas.
 *
 *   node scripts/reprocess-unmapped-punches.js --from 2026-07-14 --to 2026-07-17
 *   node scripts/reprocess-unmapped-punches.js               # todas las unmapped
 *   node scripts/reprocess-unmapped-punches.js --dry-run     # sin escribir
 *
 * Reporta: mapped, still_unmapped, duplicate, errors.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { buildEmployeeMatcher, resolveTypes, pyDateStr, pyDateTimeStr } = require('../src/services/zktecoReader');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

(async () => {
  const from = arg('from', null);
  const to = arg('to', null);
  const dryRun = flag('dry-run');
  if ((from && !isDate(from)) || (to && !isDate(to))) { console.error('--from/--to deben ser YYYY-MM-DD'); process.exit(1); }

  const where = ["mapping_status = 'unmapped'"];
  const repl = [];
  if (from) { where.push('record_time_py >= ?'); repl.push(`${from} 00:00:00`); }
  if (to) { where.push('record_time_py <= ?'); repl.push(`${to} 23:59:59`); }

  const [rows] = await sequelize.query(
    `SELECT id, device_id, device_user_id, record_time FROM raw_device_punches
     WHERE ${where.join(' AND ')} ORDER BY record_time`,
    { replacements: repl }
  );
  console.log(`Reprocesar marcas sin empleado${dryRun ? '  [DRY-RUN]' : ''} — candidatas: ${rows.length}\n`);
  if (!rows.length) { console.log('Nada para reprocesar.'); await sequelize.close(); process.exit(0); }

  const matcher = await buildEmployeeMatcher();
  const result = { mapped: 0, still_unmapped: 0, duplicate: 0, errors: 0 };
  const affectedDates = new Set();

  // Resolver empleado y agrupar por (device_id) para dedup/inferencia por día.
  const nowMappable = [];
  for (const r of rows) {
    const empId = matcher.resolve(r.device_id, r.device_user_id);
    if (!empId) { result.still_unmapped++; continue; }
    nowMappable.push({ rawId: r.id, empId, device_id: r.device_id, ts: new Date(r.record_time) });
  }

  if (!nowMappable.length) {
    console.log(`mapped=0 · still_unmapped=${result.still_unmapped} · duplicate=0 · errors=0`);
    console.log('Ningún deviceUserId sin mapear tiene empleado todavía. Cargá employee_device_map o corregí employees.code/employee_number.');
    await sequelize.close(); process.exit(0);
  }

  // Inferir in/out por (empleado, día).
  resolveTypes(nowMappable);

  for (const p of nowMappable) {
    try {
      const tsStr = pyDateTimeStr(p.ts);
      affectedDates.add(pyDateStr(p.ts));
      if (dryRun) { result.mapped++; continue; }

      // ¿Ya existe la marca en attendance_logs? (dedup cross-source)
      const [dup] = await sequelize.query(
        `SELECT id FROM attendance_logs
         WHERE employee_id = ? AND DATE_FORMAT(\`timestamp\`, '%Y-%m-%d %H:%i:%s') = ? LIMIT 1`,
        { replacements: [p.empId, tsStr] }
      );
      let logId;
      if (dup.length) {
        logId = dup[0].id;
        result.duplicate++;
      } else {
        const [ins] = await sequelize.query(
          `INSERT IGNORE INTO attendance_logs (employee_id, device_id, \`timestamp\`, type, source)
           VALUES (?,?,?,?, 'zkteco_direct')`,
          { replacements: [p.empId, p.device_id, p.ts, p.type] }
        );
        if (ins?.insertId) { logId = ins.insertId; result.mapped++; }
        else { result.duplicate++; }
      }
      await sequelize.query(
        `UPDATE raw_device_punches SET mapping_status='mapped', employee_id=?, imported_attendance_log_id=? WHERE id=?`,
        { replacements: [p.empId, logId || null, p.rawId] }
      );
    } catch (e) { result.errors++; }
  }

  // Recalcular daily_summary de las fechas afectadas.
  if (!dryRun && affectedDates.size) {
    const { bulkRecalcDailySummary, materializeAbsents } = require('../src/services/scheduler');
    for (const d of [...affectedDates].sort()) {
      try { await bulkRecalcDailySummary(d); await materializeAbsents(d); } catch { /* seguir */ }
    }
  }

  console.log(`── Resultado ──`);
  console.log(`mapped=${result.mapped} · still_unmapped=${result.still_unmapped} · duplicate=${result.duplicate} · errors=${result.errors}`);
  if (affectedDates.size) console.log(`fechas recalculadas: ${[...affectedDates].sort().join(', ')}`);

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
