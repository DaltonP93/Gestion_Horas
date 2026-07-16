#!/usr/bin/env node
/**
 * migrate-att2000-history.js — Migración histórica COMPLETA att2000 → SisHoras.
 *
 *   node scripts/migrate-att2000-history.js [desde] [hasta] [--no-recalc]
 *   node scripts/migrate-att2000-history.js                      # todo el histórico
 *   node scripts/migrate-att2000-history.js 2025-01-01 2026-07-13
 *
 * Importa att2000.CHECKINOUT → asistencia.attendance_logs paginando DÍA A DÍA
 * (evita el tope de TOP(@limit) de fetchCheckInOut) y recalcula daily_summary
 * de cada día con datos.
 *
 * - Idempotente: INSERT IGNORE sobre la clave única de attendance_logs; se puede
 *   reprocesar el mismo rango sin duplicar.
 * - No usa un limit fijo que impida completar: el rango se recorre por fecha.
 * - Reporta imported/skipped/notFound/total, origen vs destino por día, y los
 *   USERID sin mapeo a employees.code.
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const { queryAtt2000 } = require('../src/config/att2000');
const { syncAttendance } = require('../src/config/zkAdapter');
const { bulkRecalcDailySummary, materializeAbsents } = require('../src/services/scheduler');

const args = process.argv.slice(2).filter(a => a !== '--no-recalc');
const noRecalc = process.argv.includes('--no-recalc');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

(async () => {
  // 1) Rango: argumentos o MIN/MAX de att2000.
  let from = args[0], to = args[1];
  if (!isDate(from) || !isDate(to)) {
    const [r] = await queryAtt2000(
      "SELECT CONVERT(varchar(10), MIN(CHECKTIME), 120) AS mn, CONVERT(varchar(10), MAX(CHECKTIME), 120) AS mx FROM CHECKINOUT"
    );
    from = isDate(from) ? from : r.mn;
    to   = isDate(to)   ? to   : r.mx;
  }
  if (!isDate(from) || !isDate(to)) {
    console.error('No se pudo determinar el rango. Uso: node scripts/migrate-att2000-history.js [YYYY-MM-DD] [YYYY-MM-DD]');
    process.exit(1);
  }

  console.log(`Migración histórica att2000 → SisHoras`);
  console.log(`Rango: ${from} … ${to}${noRecalc ? '  (sin recálculo)' : ''}\n`);

  // 2) Histograma de origen (una sola consulta) — sólo importamos días con datos.
  const originRows = await queryAtt2000(
    `SELECT CONVERT(varchar(10), CHECKTIME, 120) AS d, COUNT(*) AS n
     FROM CHECKINOUT WHERE CHECKTIME >= @from AND CHECKTIME < DATEADD(day, 1, CONVERT(datetime, @to))
     GROUP BY CONVERT(varchar(10), CHECKTIME, 120) ORDER BY d`,
    { from: `${from} 00:00:00`, to: `${to} 00:00:00` }
  );
  const days = originRows.filter(r => Number(r.n) > 0);
  const originTotal = days.reduce((s, r) => s + Number(r.n), 0);
  console.log(`att2000: ${days.length} día(s) con datos, ${originTotal} marcaciones en el rango.\n`);

  // 3) Importar día a día + recalcular.
  const tot = { imported: 0, skipped: 0, notFound: 0, total: 0 };
  let processed = 0;
  for (const { d, n } of days) {
    try {
      const r = await syncAttendance({ dateFrom: `${d} 00:00:00`, dateTo: `${d} 23:59:59`, limit: 200000 });
      tot.imported += r.imported; tot.skipped += r.skipped; tot.notFound += r.notFound; tot.total += r.total;

      const [[dest]] = await sequelize.query(
        "SELECT COUNT(*) AS n FROM attendance_logs WHERE DATE(timestamp) = ?", { replacements: [d] }
      );
      if (!noRecalc) { await bulkRecalcDailySummary(d); await materializeAbsents(d); }

      processed++;
      console.log(`✅ ${d} · origen=${n} importados=${r.imported} dup=${r.skipped} sinEmp=${r.notFound} → destino=${dest.n}`);
    } catch (e) {
      console.error(`❌ ${d} · ERROR: ${e.message}`);
    }
  }

  // 4) USERIDs sin mapeo.
  let unmapped = [];
  try {
    const uids = await queryAtt2000('SELECT DISTINCT USERID FROM CHECKINOUT');
    const [emps] = await sequelize.query('SELECT code FROM employees');
    const codes = new Set(emps.map(e => String(e.code)));
    unmapped = uids.map(u => String(u.USERID)).filter(id => !codes.has(id));
  } catch (e) { /* att2000 pudo cerrarse */ }

  console.log(`\n── Resumen ──`);
  console.log(`Días procesados: ${processed}/${days.length}`);
  console.log(`Origen (att2000 en rango): ${originTotal}`);
  console.log(`Importados: ${tot.imported} · Duplicados (ya existían): ${tot.skipped} · Sin empleado: ${tot.notFound} · Leídos: ${tot.total}`);
  const [[destTotal]] = await sequelize.query('SELECT COUNT(*) AS n FROM attendance_logs');
  console.log(`attendance_logs total ahora: ${destTotal.n}`);
  if (unmapped.length) {
    console.log(`\n⚠️  ${unmapped.length} USERID sin empleado (employees.code). Primeros 30: ${unmapped.slice(0, 30).join(', ')}`);
    console.log(`   → Sincronizá empleados (POST /api/sync/employees) y volvé a correr este script para importarlos.`);
  } else {
    console.log(`\nTodos los USERID de att2000 tienen empleado mapeado.`);
  }

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
