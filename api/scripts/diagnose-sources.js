#!/usr/bin/env node
/**
 * diagnose-sources.js — Diagnóstico de orígenes de attendance_logs.
 *
 *   node scripts/diagnose-sources.js [horas]      # ventana de "reciente" (default 6h)
 *
 * NO borra nada. Reporta:
 *  - Conteo por source con rango de fecha de marca y de inserción.
 *  - Inserciones recientes por source (últimas N horas).
 *  - Duplicados EXACTOS cross-source (misma empleado+timestamp, distinta fuente).
 *  - Sugerencia de limpieza SÓLO si hay duplicados exactos (no la ejecuta).
 */
require('dotenv').config();
const { sequelize } = require('../src/config/database');

(async () => {
  const hours = parseInt(process.argv[2], 10) || 6;

  console.log('── Conteo por source ──');
  const [bySource] = await sequelize.query(`
    SELECT source, COUNT(*) AS total,
           DATE_FORMAT(MIN(\`timestamp\`), '%Y-%m-%d %H:%i') AS primera_marca,
           DATE_FORMAT(MAX(\`timestamp\`), '%Y-%m-%d %H:%i') AS ultima_marca,
           DATE_FORMAT(MIN(created_at), '%Y-%m-%d %H:%i') AS primer_insert,
           DATE_FORMAT(MAX(created_at), '%Y-%m-%d %H:%i') AS ultimo_insert
    FROM attendance_logs GROUP BY source ORDER BY total DESC`);
  for (const r of bySource) {
    console.log(`  ${String(r.source).padEnd(14)} total=${r.total}  marca[${r.primera_marca} … ${r.ultima_marca}]  insert[${r.primer_insert} … ${r.ultimo_insert}]`);
  }

  console.log(`\n── Inserciones últimas ${hours}h por source ──`);
  const [recent] = await sequelize.query(
    `SELECT source, COUNT(*) AS n,
            DATE_FORMAT(MIN(\`timestamp\`),'%Y-%m-%d') AS marca_min,
            DATE_FORMAT(MAX(\`timestamp\`),'%Y-%m-%d') AS marca_max
     FROM attendance_logs WHERE created_at >= NOW() - INTERVAL ? HOUR
     GROUP BY source ORDER BY n DESC`, { replacements: [hours] });
  if (!recent.length) console.log('  (sin inserciones recientes)');
  for (const r of recent) console.log(`  ${String(r.source).padEnd(14)} n=${r.n}  fechas de marca ${r.marca_min} … ${r.marca_max}`);

  console.log(`\n── Duplicados EXACTOS cross-source (empleado+timestamp, distinta fuente) ──`);
  const [[dup]] = await sequelize.query(`
    SELECT COUNT(*) AS pares
    FROM attendance_logs d
    JOIN attendance_logs x
      ON x.employee_id = d.employee_id AND x.\`timestamp\` = d.\`timestamp\`
     AND x.id < d.id AND x.source <> d.source`);
  console.log(`  Pares duplicados cross-source: ${dup.pares}`);
  if (dup.pares > 0) {
    const [sample] = await sequelize.query(`
      SELECT d.employee_id, DATE_FORMAT(d.\`timestamp\`,'%Y-%m-%d %H:%i:%s') AS ts,
             x.source AS src_a, d.source AS src_b
      FROM attendance_logs d
      JOIN attendance_logs x
        ON x.employee_id = d.employee_id AND x.\`timestamp\` = d.\`timestamp\`
       AND x.id < d.id AND x.source <> d.source
      LIMIT 10`);
    console.log('  Muestra:');
    for (const s of sample) console.log(`    emp ${s.employee_id} @ ${s.ts}: ${s.src_a} + ${s.src_b}`);
    console.log('\n  Sugerencia (NO ejecutada): conservar una fila por (employee_id, timestamp) priorizando');
    console.log('  zkteco_direct > att2000 > device, y borrar las otras. Revisar antes de aplicar.');
  } else {
    console.log('  Sin duplicados exactos cross-source. No se requiere limpieza.');
  }

  await sequelize.close();
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
