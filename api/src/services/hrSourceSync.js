/**
 * hrSourceSync.js
 * Sincronización de empleados desde fuentes HR externas (SAP, Bejerman, Meta4,
 * Workday, Odoo, CSV remoto, etc.) hacia la tabla employees de SisHoras.
 *
 * Cada fuente se configura en la tabla `external_hr_sources` con:
 *   - url, method, headers/body, auth
 *   - json_root_path:   ruta al array de empleados dentro de la respuesta
 *                       (ej: "data.employees" si la API devuelve {data:{employees:[...]}})
 *   - field_mapping:    objeto {code:"userId", first_name:"givenName", ...}
 *                       mapea campos del JSON externo → campos de employees
 *   - schedule_cron:    opcional; si está seteado, se ejecuta periódicamente
 */

const cron = require('node-cron');
const { cronCallback } = require('../utils/cronRunner');
const { serializeError, safeErrorCode } = require('../utils/errorInfo');
const { isMissingTableError, missingTableName } = require('../utils/schemaState');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

const _jobs = new Map(); // sourceId → cron task

// Obtener valor anidado por path: "data.employees[0].name"
function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    const m = key.match(/^([^\[]+)(?:\[(\d+)\])?$/);
    if (!m) return acc[key];
    const [, k, idx] = m;
    const v = acc[k];
    return idx !== undefined ? (Array.isArray(v) ? v[+idx] : undefined) : v;
  }, obj);
}

function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const [, d, mo, y] = m;
    const yyyy = y.length === 2 ? '20' + y : y;
    return `${yyyy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function normStatus(v) {
  if (v === undefined || v === null || v === '') return 'active';
  const s = String(v).toLowerCase().trim();
  if (['inactive', 'inactivo', 'baja', 'disabled', 'no', 'false', '0'].includes(s)) return 'inactive';
  if (['suspended', 'suspendido'].includes(s)) return 'suspended';
  return 'active';
}

// Parsear CSV simple (usado cuando source.type === 'http_csv')
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  // Detectar separador
  const sep = [',', ';', '\t', '|'].sort(
    (a, b) => lines[0].split(b).length - lines[0].split(a).length
  )[0];
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^["']|["']$/g, ''));
  return lines.slice(1).map(line => {
    const cols = line.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] || ''; });
    return obj;
  });
}

// Ejecutar sync de una fuente — devuelve {created, updated, skipped, errors, total}
async function runSync(sourceId) {
  const [[src]] = await sequelize.query(
    'SELECT * FROM external_hr_sources WHERE id = ?',
    { replacements: [sourceId] }
  );
  if (!src) throw new Error(`Source ${sourceId} no encontrada`);

  logger.info(`🔄 Ejecutando sync HR externo: "${src.name}" (${src.url})`);

  // Marcar running
  await sequelize.query(
    'UPDATE external_hr_sources SET last_status=\'running\', last_run_at=NOW() WHERE id=?',
    { replacements: [sourceId] }
  );

  try {
    // 1. Construir request
    const headers = { 'Accept': 'application/json', ...(src.headers_json || {}) };
    if (src.auth_type === 'bearer' && src.auth_token) {
      headers.Authorization = `Bearer ${src.auth_token}`;
    } else if (src.auth_type === 'basic' && src.auth_token) {
      headers.Authorization = `Basic ${Buffer.from(src.auth_token).toString('base64')}`;
    } else if (src.auth_type === 'api_key' && src.auth_token) {
      headers['X-API-Key'] = src.auth_token;
    }

    const fetchOpts = { method: src.method || 'GET', headers };
    if (src.method === 'POST' && src.body_json) {
      fetchOpts.body = JSON.stringify(src.body_json);
      headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(src.url, fetchOpts);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }

    // 2. Parsear respuesta según tipo
    let records;
    if (src.type === 'http_csv') {
      const text = await resp.text();
      records = parseCSV(text);
    } else {
      const json = await resp.json();
      const arr = getByPath(json, src.json_root_path) ?? json;
      records = Array.isArray(arr) ? arr : [];
    }

    if (!records.length) {
      const result = { created: 0, updated: 0, skipped: 0, errors: [], total: 0, note: 'Sin registros' };
      await sequelize.query(
        'UPDATE external_hr_sources SET last_status=\'success\', last_result=? WHERE id=?',
        { replacements: [JSON.stringify(result), sourceId] }
      );
      return result;
    }

    // 3. Mapear y upsert
    const mapping = src.field_mapping || {};
    let created = 0, updated = 0, skipped = 0;
    const errors = [];

    for (const raw of records) {
      const mapped = {};
      for (const [target, sourcePath] of Object.entries(mapping)) {
        mapped[target] = getByPath(raw, sourcePath);
      }

      const code = String(mapped.code || '').trim();
      const firstName = String(mapped.first_name || '').trim();
      const lastName = String(mapped.last_name || '').trim();

      if (!code) { skipped++; continue; }

      try {
        // Resolver department_id desde nombre (auto-crea si no existe)
        let deptId = null;
        if (mapped.department) {
          const deptName = String(mapped.department).trim();
          const [[dept]] = await sequelize.query(
            'SELECT id FROM departments WHERE name=? OR code=? LIMIT 1',
            { replacements: [deptName, deptName] }
          );
          if (dept) deptId = dept.id;
          else if (deptName) {
            const [ins] = await sequelize.query(
              'INSERT INTO departments (name, active) VALUES (?, 1)',
              { replacements: [deptName] }
            );
            deptId = ins;
          }
        }

        const [[existing]] = await sequelize.query(
          'SELECT id FROM employees WHERE code=?', { replacements: [code] }
        );

        const empNumber = mapped.employee_number ? String(mapped.employee_number).trim() : null;
        const email     = mapped.email ? String(mapped.email).trim() : null;
        const phone     = mapped.phone ? String(mapped.phone).trim() : null;
        const position  = mapped.position ? String(mapped.position).trim() : null;
        const hireDate  = normDate(mapped.hire_date);
        const status    = normStatus(mapped.status);

        if (existing) {
          await sequelize.query(`
            UPDATE employees SET
              first_name      = COALESCE(NULLIF(?,''), first_name),
              last_name       = COALESCE(NULLIF(?,''), last_name),
              employee_number = COALESCE(NULLIF(?,''), employee_number),
              email           = COALESCE(NULLIF(?,''), email),
              phone           = COALESCE(NULLIF(?,''), phone),
              position        = COALESCE(NULLIF(?,''), position),
              department_id   = COALESCE(?, department_id),
              hire_date       = COALESCE(?, hire_date),
              status          = COALESCE(NULLIF(?,''), status)
            WHERE code = ?`,
            { replacements: [firstName, lastName, empNumber, email, phone, position, deptId, hireDate, status, code] }
          );
          updated++;
        } else {
          if (!firstName) { skipped++; continue; }
          await sequelize.query(`
            INSERT INTO employees
              (code, employee_number, first_name, last_name, email, phone, position, department_id, hire_date, status)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
            { replacements: [code, empNumber, firstName, lastName, email, phone, position, deptId, hireDate, status] }
          );
          created++;
        }
      } catch (e) {
        errors.push({ code, error: e.message.slice(0, 200) });
      }
    }

    const result = {
      created, updated, skipped,
      errors: errors.slice(0, 20),
      total: records.length,
      finishedAt: new Date().toISOString(),
    };

    await sequelize.query(
      'UPDATE external_hr_sources SET last_status=\'success\', last_result=? WHERE id=?',
      { replacements: [JSON.stringify(result), sourceId] }
    );
    logger.info(`✅ Sync HR "${src.name}": ${created} creados, ${updated} actualizados, ${errors.length} errores`);
    return result;

  } catch (err) {
    const result = { error: err.message, finishedAt: new Date().toISOString() };
    await sequelize.query(
      'UPDATE external_hr_sources SET last_status=\'error\', last_result=? WHERE id=?',
      { replacements: [JSON.stringify(result), sourceId] }
    );
    logger.error(`❌ Sync HR "${src.name}" falló: ${err.message}`);
    throw err;
  }
}

/**
 * Cargar schedules desde BD al iniciar la API.
 *
 * El módulo de fuentes HR externas es OPCIONAL: la instalación base no lo usa,
 * y toda su configuración vive en `external_hr_sources`. De ahí se sigue algo
 * que decide el manejo de errores de acá: **si la tabla no existe, no puede
 * haber ninguna integración activa**. No hay nada que ocultar, porque no hay
 * nada configurado.
 *
 * Por eso la tabla ausente se registra como `skipped` y no como error, pero
 * SÓLO ese caso: cualquier otro fallo de base (permisos, conexión caída,
 * deadlock) sigue siendo un error. Tratarlos a todos igual escondería una
 * caída real detrás de un mensaje tranquilizador.
 */
async function loadHrSchedules() {
  try {
    const [rows] = await sequelize.query(
      'SELECT id, name, schedule_cron FROM external_hr_sources WHERE enabled=1 AND schedule_cron IS NOT NULL'
    );
    if (!rows.length) {
      logger.info('Fuentes HR externas: ninguna programada', {
        job: 'hr_schedules_load', result: 'skipped', reason: 'no_active_sources', scheduled: 0,
      });
      return { state: 'no_active_sources', scheduled: 0 };
    }
    for (const row of rows) {
      if (!cron.validate(row.schedule_cron)) {
        logger.warn(`Cron inválido para fuente "${row.name}": ${row.schedule_cron}`);
        continue;
      }
      const task = cron.schedule(row.schedule_cron, cronCallback(
        `hr_sync_${row.id}`,
        () => runSync(row.id),
        { meta: { source_id: row.id, cron: row.schedule_cron } }
      ));
      _jobs.set(row.id, task);
      logger.info(`📅 Sync HR "${row.name}" programado: ${row.schedule_cron}`);
    }
    return { state: 'loaded', scheduled: _jobs.size };
  } catch (err) {
    // Tabla ausente = módulo no instalado = ninguna integración configurada.
    // Es un estado, no una falla: la API no depende de esto para funcionar.
    if (isMissingTableError(err)) {
      logger.warn('Fuentes HR externas: módulo no instalado, no se programa nada', {
        job: 'hr_schedules_load',
        result: 'skipped',
        reason: 'table_missing',
        missing_table: missingTableName(err) || 'external_hr_sources',
        // Pista accionable: el error viene de una migración que quedó
        // registrada como aplicada sin haberse ejecutado.
        hint: 'aplicar migraciones: npm run migrate (ver docs/hr-sources-schema.md)',
      });
      return { state: 'table_missing', scheduled: 0 };
    }

    logger.error('Error cargando schedules HR', {
      job: 'hr_schedules_load',
      result: 'error',
      error_code: safeErrorCode(err),
      error: serializeError(err, { stage: 'load_schedules' }),
    });
    return { state: 'error', scheduled: 0 };
  }
}

function stopSchedule(sourceId) {
  const t = _jobs.get(sourceId);
  if (t) { t.stop(); _jobs.delete(sourceId); }
}

async function reloadSchedule(sourceId) {
  stopSchedule(sourceId);
  const [[row]] = await sequelize.query(
    'SELECT id, name, schedule_cron, enabled FROM external_hr_sources WHERE id=?',
    { replacements: [sourceId] }
  );
  if (!row || !row.enabled || !row.schedule_cron) return;
  if (!cron.validate(row.schedule_cron)) return;
  const task = cron.schedule(row.schedule_cron, cronCallback(
    `hr_sync_${row.id}`,
    () => runSync(row.id),
    { meta: { source_id: row.id, cron: row.schedule_cron } }
  ));
  _jobs.set(row.id, task);
}

module.exports = { runSync, loadHrSchedules, reloadSchedule, stopSchedule };
