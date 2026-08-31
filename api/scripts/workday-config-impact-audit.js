#!/usr/bin/env node
/**
 * workday-config-impact-audit.js
 *
 * SÓLO LECTURA.
 *
 * Compara el mismo rango dos veces:
 *   A) historical_fallback puro (sin ninguna configuración)
 *   B) resolución real de FASE C (Turnera + snapshot vigente)
 *
 * Sirve para demostrar que empleados aún no configurados NO cambian y para
 * identificar exactamente qué jornadas cambiarían al cargar configuración.
 *
 * Uso:
 *   node scripts/workday-config-impact-audit.js --from 2025-01-01 --to 2025-12-31
 *   node scripts/workday-config-impact-audit.js --from 2025-01-01 --to 2025-01-31 --json
 *   node scripts/workday-config-impact-audit.js --from 2025-01-01 --to 2025-12-31 --require-no-impact
 *
 * No contiene operaciones SQL de escritura y no importa ningún módulo ATT2000.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function cargarEnv(argv) {
  if (argv.includes('--no-env')) return;
  const i = argv.indexOf('--env');
  const file = i >= 0 && argv[i + 1]
    ? path.resolve(argv[i + 1])
    : path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(file)) require('dotenv').config({ path: file, override: true });
}

const argv = process.argv.slice(2);
cargarEnv(argv);

const { sequelize } = require('../src/config/database');
const engine = require('../src/services/workdayEngine');
const { loadWorkdayConfig } = require('../src/services/workdayConfig');

function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const from = arg('--from');
const to = arg('--to');
const employeeId = arg('--employee-id') ? Number(arg('--employee-id')) : null;
const employeeCode = arg('--employee') || arg('--employee-code');
const deptId = arg('--dept') ? Number(arg('--dept')) : null;
const asJson = argv.includes('--json');
const requireNoImpact = argv.includes('--require-no-impact');
const chunk = Math.max(1, Math.min(200, Number(arg('--chunk') || 50)));

function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
    && engine.toWall(`${s} 00:00:00`) !== null;
}

function signature(j) {
  return JSON.stringify({
    work_date: j.work_date,
    segment_minutes: j.segment_minutes,
    segments: (j.segments || []).map((s) => ({
      in: s.in_ts,
      out: s.out_ts,
    })),
  });
}

function rowsBySignature(rows) {
  const m = new Map();
  for (const j of rows) {
    const key = signature(j);
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

function sameRows(a, b) {
  const aa = rowsBySignature(a);
  const bb = rowsBySignature(b);
  if (aa.size !== bb.size) return false;
  for (const [k, n] of aa) if (bb.get(k) !== n) return false;
  return true;
}

async function main() {
  if (!validDate(from) || !validDate(to) || from > to) {
    throw new Error('--from/--to deben ser fechas válidas YYYY-MM-DD y from <= to');
  }

  let where = 'WHERE e.status = "active"';
  const params = [];
  if (employeeId) { where += ' AND e.id = ?'; params.push(employeeId); }
  if (employeeCode) { where += ' AND e.code = ?'; params.push(String(employeeCode)); }
  if (deptId) { where += ' AND e.department_id = ?'; params.push(deptId); }

  const [employees] = await sequelize.query(`
    SELECT e.id AS employee_id, e.code,
           CONCAT(e.first_name,' ',e.last_name) AS employee_name
    FROM employees e
    ${where}
    ORDER BY e.id
  `, { replacements: params });

  const window = engine.punchWindow({ from, to });
  const report = {
    read_only: true,
    period: { from, to },
    employees: employees.length,
    employees_with_punches: 0,
    workdays_fallback: 0,
    workdays_resolved: 0,
    resolved_modes: { historical_fallback: 0, configured: 0, other: 0 },
    changed_by_configuration: 0,
    unchanged_by_configuration: 0,
    configured_workdays: 0,
    details: [],
  };

  for (let i = 0; i < employees.length; i += chunk) {
    const batch = employees.slice(i, i + chunk);
    const ids = batch.map((e) => e.employee_id);

    const [logs] = await sequelize.query(`
      SELECT al.id, al.employee_id,
             DATE_FORMAT(al.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
             al.type
      FROM attendance_logs al
      WHERE al.employee_id IN (${ids.map(() => '?').join(',')})
        AND al.timestamp >= ? AND al.timestamp < ?
      ORDER BY al.employee_id, al.timestamp, al.id
    `, { replacements: [...ids, window.from, window.to] });

    const byEmployee = new Map();
    for (const p of logs) {
      const list = byEmployee.get(p.employee_id) || [];
      list.push(p);
      byEmployee.set(p.employee_id, list);
    }

    const resolver = await loadWorkdayConfig(ids, { from, to });

    for (const emp of batch) {
      const punches = byEmployee.get(emp.employee_id) || [];
      if (!punches.length) continue;
      report.employees_with_punches++;

      const fallback = engine.clipToPeriod(
        engine.buildWorkdays(punches).workdays,
        { from, to },
      );
      const resolved = engine.clipToPeriod(
        engine.buildWorkdays(punches, {
          resolveConfig: (date) => resolver.forDate(emp.employee_id, date),
        }).workdays,
        { from, to },
      );

      report.workdays_fallback += fallback.length;
      report.workdays_resolved += resolved.length;

      for (const j of resolved) {
        const mode = j.calculation_mode || 'other';
        if (mode === 'historical_fallback') report.resolved_modes.historical_fallback++;
        else if (mode === 'configured') {
          report.resolved_modes.configured++;
          report.configured_workdays++;
        } else report.resolved_modes.other++;
      }

      if (sameRows(fallback, resolved)) {
        report.unchanged_by_configuration++;
        continue;
      }

      report.changed_by_configuration++;
      if (report.details.length < 500) {
        report.details.push({
          employee_id: emp.employee_id,
          code: emp.code,
          employee_name: emp.employee_name,
          fallback: fallback.map((j) => ({
            work_date: j.work_date,
            total: j.segment_minutes,
            pairs: j.segments.map((s) => [s.in_hhmm, s.out_hhmm]),
            mode: j.calculation_mode,
          })),
          resolved: resolved.map((j) => ({
            work_date: j.work_date,
            total: j.segment_minutes,
            pairs: j.segments.map((s) => [s.in_hhmm, s.out_hhmm]),
            mode: j.calculation_mode,
            source: j.calculation_source,
            schedule_id: j.schedule_id,
            shift_schedule_id: j.shift_schedule_id,
            anomalies: (j.anomalies || []).map((a) => a.code),
          })),
        });
      }
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('=== Workday Config Impact Audit (READ-ONLY) ===');
    console.log(`Período                    : ${from} .. ${to}`);
    console.log(`Empleados                  : ${report.employees}`);
    console.log(`Con marcajes               : ${report.employees_with_punches}`);
    console.log(`Jornadas fallback          : ${report.workdays_fallback}`);
    console.log(`Jornadas resolved          : ${report.workdays_resolved}`);
    console.log(`  historical_fallback      : ${report.resolved_modes.historical_fallback}`);
    console.log(`  configured               : ${report.resolved_modes.configured}`);
    console.log(`Sin cambio por config      : ${report.unchanged_by_configuration}`);
    console.log(`CAMBIAN por configuración  : ${report.changed_by_configuration}`);
    if (report.details.length) {
      console.log('');
      console.log('ATENCIÓN: hay empleados cuyo resultado cambia; usar --json para detalle.');
    }
  }

  if (requireNoImpact && report.changed_by_configuration > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Audit falló:', err.message);
    process.exitCode = 2;
  })
  .finally(async () => {
    try { await sequelize.close(); } catch {}
  });
