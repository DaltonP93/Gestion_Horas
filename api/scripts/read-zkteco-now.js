#!/usr/bin/env node
/**
 * read-zkteco-now.js — Lectura DIRECTA de relojes ZKTeco → SisHoras, por rango.
 *
 *   node scripts/read-zkteco-now.js --from 2026-07-14 --to 2026-07-16
 *   node scripts/read-zkteco-now.js --from 2026-07-14              # hasta hoy
 *   node scripts/read-zkteco-now.js                                # últimos 3 días
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
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

(async () => {
  const to = arg('to', new Date().toISOString().slice(0, 10));
  const from = arg('from', new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
  if (!isDate(from) || !isDate(to)) {
    console.error('Uso: node scripts/read-zkteco-now.js --from YYYY-MM-DD [--to YYYY-MM-DD]');
    process.exit(1);
  }

  console.log(`Lectura directa de relojes → SisHoras · rango ${from} … ${to} (hora Paraguay)\n`);
  // Timeout amplio por reloj: acá no hay Nginx cortando la request.
  const out = await backupAllDevices({ from, to, recalc: true, readTimeoutMs: 180000 });

  for (const r of out.results) {
    if (r.ok) {
      console.log(`✅ [#${r.device_id}] ${r.device} (${r.ip}) · leídos=${r.total_read} enRango=${r.in_range} importados=${r.imported} dup=${r.skipped} sinEmp=${r.notFound}${r.dates.length ? ` · fechas: ${r.dates.join(', ')}` : ''}`);
    } else {
      console.error(`❌ [#${r.device_id}] ${r.device} (${r.ip}) · ${r.error}`);
    }
  }
  console.log(`\n── Resumen ──`);
  console.log(`Relojes: ${out.devices} · Importados: ${out.totals.imported} · Duplicados: ${out.totals.skipped} · Sin empleado: ${out.totals.notFound}`);

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
