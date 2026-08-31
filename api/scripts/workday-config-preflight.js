#!/usr/bin/env node
/**
 * workday-config-preflight.js — FASE C / E preflight de SOLO LECTURA.
 *
 * Verifica si el esquema necesario para configuración histórica está listo
 * antes de exponer writers o activar flags. No ejecuta migraciones, no modifica
 * attendance_logs/daily_summary y no conoce ATT2000.
 *
 * Uso:
 *   node scripts/workday-config-preflight.js
 *   node scripts/workday-config-preflight.js --json
 *   node scripts/workday-config-preflight.js --env /ruta/api/.env
 *   node scripts/workday-config-preflight.js --no-env
 */

'use strict';

const fs = require('fs');
const path = require('path');

function cargarEnv(argv) {
  if (argv.includes('--no-env')) return { mode: 'shell', file: null };
  const i = argv.indexOf('--env');
  const file = (i >= 0 && argv[i + 1])
    ? path.resolve(argv[i + 1])
    : path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(file)) require('dotenv').config({ path: file, override: true });
  return { mode: fs.existsSync(file) ? 'file' : 'shell', file };
}

const argv = process.argv.slice(2);
const ENV = cargarEnv(argv);
const json = argv.includes('--json');

const { sequelize } = require('../src/config/database');

const REQUIRED_MIGRATIONS = [
  '072_employee_schedule_history.sql',
  '073_workday_profile_and_overlap_guard.sql',
  '074_daily_summary_status_unknown.sql',
  '075_workday_configuration_phase_c.sql',
];

const REQUIRED_HISTORY_COLUMNS = [
  'id', 'employee_id', 'schedule_id', 'valid_from', 'valid_to',
  'check_in', 'check_out', 'tolerance_in', 'tolerance_out',
  'break_mode', 'break_minutes', 'break_after_minutes',
  'weekly_target_minutes', 'daily_target_minutes', 'work_regime',
  'overtime_policy', 'rounding_policy', 'night_start', 'night_end', 'work_days',
  'schedule_name_snapshot', 'snapshot_version', 'snapshot_source',
  'change_reason', 'updated_by',
  'rounding_policy_version', 'rounding_policy_config',
  'overtime_policy_version', 'overtime_policy_config',
];

async function tableExists(name) {
  const [rows] = await sequelize.query(
    `SELECT 1 AS ok
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      LIMIT 1`,
    { replacements: [name] },
  );
  return Boolean(rows[0]);
}

async function columnsOf(name) {
  const [rows] = await sequelize.query(
    `SELECT COLUMN_NAME AS name
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    { replacements: [name] },
  );
  return new Set(rows.map((r) => r.name));
}

async function migrationStatus() {
  if (!(await tableExists('schema_migrations'))) {
    return REQUIRED_MIGRATIONS.map((filename) => ({ filename, recorded: false, reason: 'schema_migrations_missing' }));
  }
  const [rows] = await sequelize.query(
    `SELECT filename
       FROM schema_migrations
      WHERE filename IN (?,?,?,?)`,
    { replacements: REQUIRED_MIGRATIONS },
  );
  const set = new Set(rows.map((r) => r.filename));
  return REQUIRED_MIGRATIONS.map((filename) => ({ filename, recorded: set.has(filename) }));
}

async function main() {
  const historyExists = await tableExists('employee_schedule_history');
  const dailyExists = await tableExists('daily_summary');
  const migrations = await migrationStatus();

  let missingHistoryColumns = [...REQUIRED_HISTORY_COLUMNS];
  let historyRows = null;
  if (historyExists) {
    const cols = await columnsOf('employee_schedule_history');
    missingHistoryColumns = REQUIRED_HISTORY_COLUMNS.filter((c) => !cols.has(c));
    const [[count]] = await sequelize.query('SELECT COUNT(*) AS n FROM employee_schedule_history');
    historyRows = Number(count?.n || 0);
  }

  let dailyHas074 = false;
  if (dailyExists) {
    const [rows] = await sequelize.query(
      `SELECT COLUMN_TYPE AS type
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'daily_summary'
          AND COLUMN_NAME = 'status'
        LIMIT 1`,
    );
    const type = String(rows[0]?.type || '');
    dailyHas074 = type.includes("'non_working'") && type.includes("'unconfigured'");
  }

  const flags = {
    WORKDAY_CONFIG_WRITE_ENABLED:
      process.env.WORKDAY_CONFIG_WRITE_ENABLED === 'true',
    WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED:
      process.env.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED === 'true',
    WORKDAY_ENGINE_STATUS_074_ENABLED:
      process.env.WORKDAY_ENGINE_STATUS_074_ENABLED === 'true',
  };

  const schemaReady = historyExists
    && missingHistoryColumns.length === 0
    && dailyHas074
    && migrations.every((m) => m.recorded);

  const safeForDevelopment = !flags.WORKDAY_CONFIG_WRITE_ENABLED
    && !flags.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED
    && !flags.WORKDAY_ENGINE_STATUS_074_ENABLED;

  const report = {
    read_only: true,
    env_source: ENV.mode,
    history_table_exists: historyExists,
    history_rows: historyRows,
    missing_history_columns: missingHistoryColumns,
    daily_summary_status_has_074: dailyHas074,
    migrations,
    flags,
    schema_ready_for_phase_c: schemaReady,
    flags_safe_for_pre_rollout: safeForDevelopment,
  };

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('=== Workday Config Preflight (READ-ONLY) ===');
    console.log(`employee_schedule_history: ${historyExists ? 'presente' : 'AUSENTE'}`);
    if (historyRows != null) console.log(`filas historial: ${historyRows}`);
    console.log(`columnas faltantes: ${missingHistoryColumns.length ? missingHistoryColumns.join(', ') : 'ninguna'}`);
    console.log(`daily_summary ENUM 074: ${dailyHas074 ? 'sí' : 'no'}`);
    for (const m of migrations) console.log(`${m.recorded ? '✓' : '✗'} ${m.filename}`);
    console.log(`config writer flag: ${flags.WORKDAY_CONFIG_WRITE_ENABLED ? 'ON' : 'OFF'}`);
    console.log(`summary writer flag: ${flags.WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED ? 'ON' : 'OFF'}`);
    console.log(`status074 flag: ${flags.WORKDAY_ENGINE_STATUS_074_ENABLED ? 'ON' : 'OFF'}`);
    console.log(`flags seguros pre-rollout: ${safeForDevelopment ? 'SÍ' : 'NO'}`);
    console.log(`schema listo FASE C: ${schemaReady ? 'SÍ' : 'NO'}`);
  }

  // Un preflight incompleto debe poder usarse para diagnóstico sin aplicar nada,
  // por eso sólo sale 1 si alguien pidió explícitamente --require-ready.
  if (argv.includes('--require-ready') && !schemaReady) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Preflight falló:', err.message);
    process.exitCode = 2;
  })
  .finally(async () => {
    try { await sequelize.close(); } catch {}
  });
