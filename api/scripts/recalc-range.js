#!/usr/bin/env node
/**
 * recalc-range.js — Recalcula daily_summary para un rango de fechas.
 *
 *   node scripts/recalc-range.js <desde> [hasta]
 *   node scripts/recalc-range.js 2026-07-13 2026-07-16
 *   node scripts/recalc-range.js 2026-07-16            # un solo día
 *
 * Por cada día: corre bulkRecalcDailySummary (marcajes → resumen) y
 * materializeAbsents (ausentes según horario), y muestra el conteo por estado.
 *
 * Sirve de validación del fix de "Column 'status' is ambiguous": si el rango
 * recalcula sin error, el bug quedó resuelto. Es idempotente (se puede
 * reprocesar el mismo rango sin duplicar; daily_summary tiene PK
 * (employee_id, date)).
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { bulkRecalcDailySummary, materializeAbsents } = require('../src/services/scheduler');

function eachDay(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (isNaN(d) || isNaN(end)) return out;
  while (d <= end) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

(async () => {
  const from = process.argv[2];
  const to = process.argv[3] || from;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error('Uso: node scripts/recalc-range.js <YYYY-MM-DD> [YYYY-MM-DD]');
    process.exit(1);
  }
  const days = eachDay(from, to);
  if (!days.length) { console.error('Rango de fechas inválido'); process.exit(1); }

  console.log(`Recalculando daily_summary para ${days.length} día(s): ${days[0]} → ${days[days.length - 1]}\n`);
  let ok = 0, fail = 0;
  for (const date of days) {
    try {
      await bulkRecalcDailySummary(date);
      const absent = await materializeAbsents(date);
      const [[r]] = await sequelize.query(
        `SELECT
           COUNT(*) AS total,
           SUM(status = 'present') AS present,
           SUM(status = 'late')    AS late,
           SUM(status = 'absent')  AS absent,
           SUM(status IN ('holiday','weekend','permission')) AS otros
         FROM daily_summary WHERE date = ?`,
        { replacements: [date] }
      );
      console.log(`✅ ${date} · total=${r.total} present=${r.present || 0} late=${r.late || 0} absent=${r.absent || 0} otros=${r.otros || 0} (materializados: ${absent})`);
      ok++;
    } catch (e) {
      console.error(`❌ ${date} · ERROR: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nListo. ${ok} día(s) OK, ${fail} con error.`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
