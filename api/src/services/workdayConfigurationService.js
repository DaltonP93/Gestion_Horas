'use strict';

/**
 * workdayConfigurationService.js — FASE C.
 *
 * Backend de configuración laboral efectiva e histórica.
 *
 * Invariante:
 *   una fila de employee_schedule_history es un SNAPSHOT. Una vez creada, los
 *   cálculos históricos leen únicamente sus valores congelados; editar la fila
 *   viva de schedules no puede reescribir el pasado.
 *
 * Este servicio NO toca attendance_logs ni daily_summary y no conoce ATT2000.
 */

const { sequelize } = require('../config/database');
const { withDeadlockRetry } = require('../utils/mysqlRetry');
const { loadWorkdayConfig, vigenteEn } = require('./workdayConfig');

const LOCK_TIMEOUT_S = 10;
const WORK_REGIMES = new Set(['day', 'night', 'mixed', 'special', 'custom']);
const BREAK_MODES = new Set(['none', 'punched', 'fixed_unpaid']);
const POLICY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function validDateISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizeTime(value, field) {
  if (value == null || value === '') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value));
  if (!m) throw httpError(400, 'INVALID_TIME', `${field} debe tener formato HH:mm[:ss]`);
  return `${m[1]}:${m[2]}:${m[3] || '00'}`;
}

function normalizeInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = true } = {}) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw httpError(400, 'INVALID_NUMBER', `${field} es requerido`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, 'INVALID_NUMBER', `${field} debe ser un entero entre ${min} y ${max}`);
  }
  return n;
}

function normalizeWorkDays(value) {
  if (value == null || value === '') return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const days = raw.map((v) => Number(String(v).trim()));
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw httpError(400, 'INVALID_WORK_DAYS', 'work_days debe contener exclusivamente valores 1..7 (1=Domingo, 7=Sábado)');
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function normalizePolicy(value, field) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!POLICY_RE.test(s)) {
    throw httpError(400, 'INVALID_POLICY', `${field} debe ser un código seguro de hasta 40 caracteres`);
  }
  return s;
}

function normalizeJson(value, field) {
  if (value == null || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch {
      throw httpError(400, 'INVALID_POLICY_CONFIG', `${field} debe ser JSON válido`);
    }
  }
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
    throw httpError(400, 'INVALID_POLICY_CONFIG', `${field} debe ser un objeto JSON`);
  }
  // Fuerza serializabilidad y elimina prototipos extraños.
  try { return JSON.parse(JSON.stringify(parsed)); } catch {
    throw httpError(400, 'INVALID_POLICY_CONFIG', `${field} no es serializable`);
  }
}

function normalizeRegime(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (!WORK_REGIMES.has(s)) {
    throw httpError(400, 'INVALID_WORK_REGIME', `work_regime inválido: ${s}`);
  }
  return s;
}

function validateValidity(validFrom, validTo) {
  if (!validDateISO(validFrom)) {
    throw httpError(400, 'INVALID_VALID_FROM', 'valid_from debe ser una fecha real YYYY-MM-DD');
  }
  if (validTo != null && validTo !== '' && !validDateISO(validTo)) {
    throw httpError(400, 'INVALID_VALID_TO', 'valid_to debe ser una fecha real YYYY-MM-DD');
  }
  if (validTo && validTo < validFrom) {
    throw httpError(400, 'INVALID_VALIDITY', 'valid_to no puede ser anterior a valid_from');
  }
}

/**
 * Convierte el payload + un snapshot base en una fila completa.
 * Nunca lee schedules implícitamente: el caller decide explícitamente cuándo
 * tomar una foto del horario vivo.
 */
function buildSnapshot(base, body, { source, version } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  const pick = (k) => has(k) ? body[k] : base?.[k];

  const snapshot = {
    schedule_id: pick('schedule_id') == null || pick('schedule_id') === '' ? null : Number(pick('schedule_id')),
    schedule_name_snapshot: base?.schedule_name_snapshot || null,
    check_in: normalizeTime(pick('check_in'), 'check_in'),
    check_out: normalizeTime(pick('check_out'), 'check_out'),
    tolerance_in: normalizeInt(pick('tolerance_in') ?? 0, 'tolerance_in', { min: 0, max: 1440, nullable: false }),
    tolerance_out: normalizeInt(pick('tolerance_out') ?? 0, 'tolerance_out', { min: 0, max: 1440, nullable: false }),
    work_days: normalizeWorkDays(pick('work_days')),
    break_mode: String(pick('break_mode') || 'none'),
    break_minutes: normalizeInt(pick('break_minutes') ?? 0, 'break_minutes', { min: 0, max: 1440, nullable: false }),
    break_after_minutes: normalizeInt(pick('break_after_minutes') ?? 0, 'break_after_minutes', { min: 0, max: 1440, nullable: false }),
    weekly_target_minutes: normalizeInt(pick('weekly_target_minutes'), 'weekly_target_minutes', { min: 0, max: 10080 }),
    daily_target_minutes: normalizeInt(pick('daily_target_minutes'), 'daily_target_minutes', { min: 0, max: 1440 }),
    work_regime: normalizeRegime(pick('work_regime')),
    night_start: normalizeTime(pick('night_start'), 'night_start'),
    night_end: normalizeTime(pick('night_end'), 'night_end'),
    rounding_policy: normalizePolicy(pick('rounding_policy'), 'rounding_policy'),
    rounding_policy_version: normalizeInt(pick('rounding_policy_version'), 'rounding_policy_version', { min: 1, max: 100000 }),
    rounding_policy_config: normalizeJson(pick('rounding_policy_config'), 'rounding_policy_config'),
    overtime_policy: normalizePolicy(pick('overtime_policy'), 'overtime_policy'),
    overtime_policy_version: normalizeInt(pick('overtime_policy_version'), 'overtime_policy_version', { min: 1, max: 100000 }),
    overtime_policy_config: normalizeJson(pick('overtime_policy_config'), 'overtime_policy_config'),
    notes: pick('notes') == null || pick('notes') === '' ? null : String(pick('notes')).slice(0, 255),
    snapshot_source: source || base?.snapshot_source || 'manual',
    snapshot_version: version || Number(base?.snapshot_version || 1),
  };

  if (!BREAK_MODES.has(snapshot.break_mode)) {
    throw httpError(400, 'INVALID_BREAK_MODE', 'break_mode debe ser none, punched o fixed_unpaid');
  }
  if ((snapshot.night_start == null) !== (snapshot.night_end == null)) {
    throw httpError(400, 'INVALID_NIGHT_RANGE', 'night_start y night_end deben configurarse juntos');
  }

  // Un tramo configurable necesita una foto suficiente del horario. Si RR.HH.
  // no conoce el horario histórico, la opción correcta es NO crear el tramo y
  // dejar que historical_fallback describa únicamente lo observado.
  if (!snapshot.check_in || !snapshot.check_out || !snapshot.work_days?.length) {
    throw httpError(
      400,
      'INCOMPLETE_SNAPSHOT',
      'El snapshot requiere check_in, check_out y work_days; no se permite caer al schedule vivo',
    );
  }

  return snapshot;
}

function snapshotFromSchedule(schedule, body = {}) {
  if (!schedule) throw httpError(404, 'SCHEDULE_NOT_FOUND', 'Horario no encontrado');
  const scheduleBreak = Number(schedule.break_minutes || 0);
  const base = {
    schedule_id: Number(schedule.id),
    schedule_name_snapshot: schedule.name || null,
    check_in: schedule.check_in,
    check_out: schedule.check_out,
    tolerance_in: schedule.tolerance_in ?? 0,
    tolerance_out: schedule.tolerance_out ?? 0,
    work_days: schedule.work_days,
    break_mode: scheduleBreak > 0 ? 'fixed_unpaid' : 'none',
    break_minutes: scheduleBreak,
    break_after_minutes: 0,
    weekly_target_minutes: null,
    daily_target_minutes: null,
    work_regime: null,
    night_start: null,
    night_end: null,
    rounding_policy: null,
    rounding_policy_version: null,
    rounding_policy_config: null,
    overtime_policy: null,
    overtime_policy_version: null,
    overtime_policy_config: null,
    notes: null,
  };
  return buildSnapshot(base, { ...body, schedule_id: schedule.id }, {
    source: 'schedule_snapshot',
    version: 1,
  });
}

function rowToPublic(row) {
  if (!row) return null;
  const json = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  };
  const days = row.work_days == null
    ? null
    : String(row.work_days).split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return {
    ...row,
    employee_id: Number(row.employee_id),
    schedule_id: row.schedule_id == null ? null : Number(row.schedule_id),
    snapshot_version: Number(row.snapshot_version || 1),
    work_days: days,
    rounding_policy_config: json(row.rounding_policy_config),
    overtime_policy_config: json(row.overtime_policy_config),
    snapshot_complete: Boolean(row.check_in && row.check_out && days?.length),
  };
}

async function loadSchedule(scheduleId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT id, name, check_in, check_out, tolerance_in, tolerance_out,
            break_minutes, work_days, active
       FROM schedules
      WHERE id = ?
      LIMIT 1`,
    { replacements: [scheduleId], transaction },
  );
  return rows[0] || null;
}

async function ensureEmployee(employeeId, transaction) {
  const [rows] = await sequelize.query(
    'SELECT id FROM employees WHERE id = ? LIMIT 1',
    { replacements: [employeeId], transaction },
  );
  if (!rows[0]) throw httpError(404, 'EMPLOYEE_NOT_FOUND', 'Empleado no encontrado');
}

async function getHistory(employeeId) {
  const [rows] = await sequelize.query(`
    SELECT h.*,
           DATE_FORMAT(h.valid_from, '%Y-%m-%d') AS valid_from,
           DATE_FORMAT(h.valid_to, '%Y-%m-%d') AS valid_to,
           u.full_name AS created_by_name,
           uu.full_name AS updated_by_name
      FROM employee_schedule_history h
      LEFT JOIN users u  ON u.id = h.created_by
      LEFT JOIN users uu ON uu.id = h.updated_by
     WHERE h.employee_id = ?
     ORDER BY h.valid_from DESC, h.id DESC
  `, { replacements: [employeeId] });
  return rows.map(rowToPublic);
}

async function readHistoryRow(id, transaction, forUpdate = false) {
  const [rows] = await sequelize.query(
    `SELECT * FROM employee_schedule_history WHERE id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    { replacements: [id], transaction },
  );
  return rows[0] || null;
}

async function assertNoOverlap(employeeId, validFrom, validTo, excludeId, transaction) {
  const [rows] = await sequelize.query(`
    SELECT id, valid_from, valid_to
      FROM employee_schedule_history
     WHERE employee_id = ?
       AND (? IS NULL OR id <> ?)
       AND ? <= IFNULL(valid_to, '9999-12-31')
       AND valid_from <= IFNULL(?, '9999-12-31')
     LIMIT 1
     FOR UPDATE
  `, {
    replacements: [employeeId, excludeId ?? null, excludeId ?? null, validFrom, validTo || null],
    transaction,
  });
  if (rows[0]) {
    throw httpError(
      409,
      'WORKDAY_CONFIG_OVERLAP',
      `La vigencia se solapa con el tramo #${rows[0].id}`,
    );
  }
}

async function withEmployeeConfigLock(employeeId, fn) {
  const key = `sishoras:workcfg:${employeeId}`;
  const { result } = await withDeadlockRetry(() => sequelize.transaction(async (t) => {
    const [rows] = await sequelize.query(
      'SELECT GET_LOCK(?, ?) AS ok',
      { replacements: [key, LOCK_TIMEOUT_S], transaction: t },
    );
    const ok = Array.isArray(rows) && rows[0] ? rows[0].ok : null;
    if (ok !== 1) {
      const err = httpError(409, 'WORKDAY_CONFIG_LOCK_TIMEOUT', 'La configuración del empleado está siendo modificada por otro proceso');
      err.errno = 1205;
      err.code = 'ER_LOCK_WAIT_TIMEOUT';
      throw err;
    }
    try {
      return await fn(t);
    } finally {
      await sequelize.query(
        'SELECT RELEASE_LOCK(?)',
        { replacements: [key], transaction: t },
      ).catch(() => {});
    }
  }), { label: `workday-config:${employeeId}` });
  return result;
}

function valuesForInsert(employeeId, validFrom, validTo, snapshot, actorId, reason) {
  return [
    employeeId,
    snapshot.schedule_id,
    snapshot.schedule_name_snapshot,
    validFrom,
    validTo || null,
    snapshot.check_in,
    snapshot.check_out,
    snapshot.tolerance_in,
    snapshot.tolerance_out,
    snapshot.break_mode,
    snapshot.break_minutes,
    snapshot.break_after_minutes,
    snapshot.weekly_target_minutes,
    snapshot.daily_target_minutes,
    snapshot.work_regime,
    snapshot.overtime_policy,
    snapshot.overtime_policy_version,
    snapshot.overtime_policy_config == null ? null : JSON.stringify(snapshot.overtime_policy_config),
    snapshot.rounding_policy,
    snapshot.rounding_policy_version,
    snapshot.rounding_policy_config == null ? null : JSON.stringify(snapshot.rounding_policy_config),
    snapshot.night_start,
    snapshot.night_end,
    snapshot.work_days.join(','),
    snapshot.snapshot_version,
    snapshot.snapshot_source,
    reason || null,
    snapshot.notes,
    actorId || null,
    actorId || null,
  ];
}

async function createHistory(employeeId, body, actorId) {
  const validFrom = body?.valid_from;
  const validTo = body?.valid_to || null;
  validateValidity(validFrom, validTo);

  return withEmployeeConfigLock(employeeId, async (t) => {
    await ensureEmployee(employeeId, t);
    await assertNoOverlap(employeeId, validFrom, validTo, null, t);

    let snapshot;
    if (body?.schedule_id != null && body.schedule_id !== '') {
      const schedule = await loadSchedule(Number(body.schedule_id), t);
      snapshot = snapshotFromSchedule(schedule, body);
    } else {
      snapshot = buildSnapshot({}, body || {}, { source: 'manual', version: 1 });
    }

    const reason = body?.reason || body?.change_reason || null;
    const [result] = await sequelize.query(`
      INSERT INTO employee_schedule_history (
        employee_id,
        schedule_id,
        schedule_name_snapshot,
        valid_from,
        valid_to,
        check_in,
        check_out,
        tolerance_in,
        tolerance_out,
        break_mode,
        break_minutes,
        break_after_minutes,
        weekly_target_minutes,
        daily_target_minutes,
        work_regime,
        overtime_policy,
        overtime_policy_version,
        overtime_policy_config,
        rounding_policy,
        rounding_policy_version,
        rounding_policy_config,
        night_start,
        night_end,
        work_days,
        snapshot_version,
        snapshot_source,
        change_reason,
        notes,
        created_by,
        updated_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, {
      replacements: valuesForInsert(employeeId, validFrom, validTo, snapshot, actorId, reason),
      transaction: t,
    });
    return rowToPublic(await readHistoryRow(result.insertId, t));
  });
}

function composeScheduleWithProfile(scheduleSnapshot, existing) {
  if (!existing) return scheduleSnapshot;
  return {
    ...scheduleSnapshot,
    // El nuevo horario define CUÁNDO y su descanso operativo.
    // El perfil existente define CUÁNTO/régimen/policies y no se borra por
    // cambiar de horario salvo que el payload lo sobrescriba explícitamente.
    weekly_target_minutes: existing.weekly_target_minutes ?? null,
    daily_target_minutes: existing.daily_target_minutes ?? null,
    work_regime: existing.work_regime ?? null,
    night_start: existing.night_start ?? null,
    night_end: existing.night_end ?? null,
    rounding_policy: existing.rounding_policy ?? null,
    rounding_policy_version: existing.rounding_policy_version ?? null,
    rounding_policy_config: existing.rounding_policy_config ?? null,
    overtime_policy: existing.overtime_policy ?? null,
    overtime_policy_version: existing.overtime_policy_version ?? null,
    overtime_policy_config: existing.overtime_policy_config ?? null,
    notes: existing.notes ?? null,
  };
}

function existingAsBase(existing) {
  return rowToPublic(existing);
}

async function updateHistory(id, body, actorId) {
  const [probe] = await sequelize.query(
    'SELECT id, employee_id FROM employee_schedule_history WHERE id = ? LIMIT 1',
    { replacements: [id] },
  );
  if (!probe[0]) throw httpError(404, 'WORKDAY_CONFIG_NOT_FOUND', 'Vigencia no encontrada');
  const employeeId = Number(probe[0].employee_id);

  return withEmployeeConfigLock(employeeId, async (t) => {
    const existingRaw = await readHistoryRow(id, t, true);
    if (!existingRaw) throw httpError(404, 'WORKDAY_CONFIG_NOT_FOUND', 'Vigencia no encontrada');
    const existing = existingAsBase(existingRaw);

    const validFrom = Object.prototype.hasOwnProperty.call(body || {}, 'valid_from')
      ? body.valid_from
      : String(existing.valid_from).slice(0, 10);
    const validTo = Object.prototype.hasOwnProperty.call(body || {}, 'valid_to')
      ? (body.valid_to || null)
      : (existing.valid_to ? String(existing.valid_to).slice(0, 10) : null);
    validateValidity(validFrom, validTo);
    await assertNoOverlap(employeeId, validFrom, validTo, id, t);

    let snapshotBase = existing;
    let source = 'correction';
    if (Object.prototype.hasOwnProperty.call(body || {}, 'schedule_id')) {
      if (body.schedule_id == null || body.schedule_id === '') {
        snapshotBase = { ...existing, schedule_id: null, schedule_name_snapshot: null };
        source = 'manual';
      } else {
        const schedule = await loadSchedule(Number(body.schedule_id), t);
        snapshotBase = composeScheduleWithProfile(snapshotFromSchedule(schedule, {}), existing);
        source = 'schedule_snapshot';
      }
    } else if (body?.resnapshot_schedule === true) {
      if (!existing.schedule_id) {
        throw httpError(400, 'NO_SCHEDULE_TO_RESNAPSHOT', 'El tramo no tiene schedule_id para volver a tomar snapshot');
      }
      const schedule = await loadSchedule(Number(existing.schedule_id), t);
      snapshotBase = composeScheduleWithProfile(snapshotFromSchedule(schedule, {}), existing);
      source = 'schedule_resnapshot';
    }

    const snapshot = buildSnapshot(snapshotBase, body || {}, {
      source,
      version: Number(existing.snapshot_version || 1) + 1,
    });
    if (snapshotBase.schedule_name_snapshot) snapshot.schedule_name_snapshot = snapshotBase.schedule_name_snapshot;

    const reason = body?.reason || body?.change_reason || existing.change_reason || null;
    await sequelize.query(`
      UPDATE employee_schedule_history SET
        schedule_id = ?,
        schedule_name_snapshot = ?,
        valid_from = ?,
        valid_to = ?,
        check_in = ?,
        check_out = ?,
        tolerance_in = ?,
        tolerance_out = ?,
        break_mode = ?,
        break_minutes = ?,
        break_after_minutes = ?,
        weekly_target_minutes = ?,
        daily_target_minutes = ?,
        work_regime = ?,
        overtime_policy = ?,
        overtime_policy_version = ?,
        overtime_policy_config = ?,
        rounding_policy = ?,
        rounding_policy_version = ?,
        rounding_policy_config = ?,
        night_start = ?,
        night_end = ?,
        work_days = ?,
        snapshot_version = ?,
        snapshot_source = ?,
        change_reason = ?,
        notes = ?,
        updated_by = ?
      WHERE id = ?
    `, {
      replacements: [
        snapshot.schedule_id,
        snapshot.schedule_name_snapshot,
        validFrom,
        validTo,
        snapshot.check_in,
        snapshot.check_out,
        snapshot.tolerance_in,
        snapshot.tolerance_out,
        snapshot.break_mode,
        snapshot.break_minutes,
        snapshot.break_after_minutes,
        snapshot.weekly_target_minutes,
        snapshot.daily_target_minutes,
        snapshot.work_regime,
        snapshot.overtime_policy,
        snapshot.overtime_policy_version,
        snapshot.overtime_policy_config == null ? null : JSON.stringify(snapshot.overtime_policy_config),
        snapshot.rounding_policy,
        snapshot.rounding_policy_version,
        snapshot.rounding_policy_config == null ? null : JSON.stringify(snapshot.rounding_policy_config),
        snapshot.night_start,
        snapshot.night_end,
        snapshot.work_days.join(','),
        snapshot.snapshot_version,
        snapshot.snapshot_source,
        reason,
        snapshot.notes,
        actorId || null,
        id,
      ],
      transaction: t,
    });

    return {
      before: existing,
      after: rowToPublic(await readHistoryRow(id, t)),
    };
  });
}

async function closeHistory(id, validTo, actorId, reason) {
  if (!validDateISO(validTo)) throw httpError(400, 'INVALID_VALID_TO', 'valid_to debe ser YYYY-MM-DD');
  return updateHistory(id, { valid_to: validTo, reason: reason || 'Cierre de vigencia' }, actorId);
}

function mysqlDayOfWeek(dateISO) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1;
}

async function loadCalendarException(employeeId, date) {
  const [[permission]] = await sequelize.query(`
    SELECT id, type, status, approval_state,
           DATE_FORMAT(date_from, '%Y-%m-%d') AS date_from,
           DATE_FORMAT(date_to, '%Y-%m-%d') AS date_to,
           reason
      FROM permissions
     WHERE employee_id = ?
       AND date_from <= ?
       AND date_to >= ?
       AND (status = 'approved' OR approval_state = 'approved')
     ORDER BY id DESC
     LIMIT 1
  `, { replacements: [employeeId, date, date] });

  const [[holiday]] = await sequelize.query(
    `SELECT id, name, type, DATE_FORMAT(date, '%Y-%m-%d') AS date
       FROM holidays
      WHERE active = 1 AND date = ?
      LIMIT 1`,
    { replacements: [date] },
  );

  return {
    permission: permission || null,
    holiday: holiday || null,
  };
}

function profileFromConfig(cfg) {
  if (!cfg) return null;
  return {
    weekly_target_minutes: cfg.weekly_target_minutes ?? null,
    daily_target_minutes: cfg.daily_target_minutes ?? null,
    work_regime: cfg.work_regime ?? null,
    break_mode: cfg.break_mode ?? null,
    break_minutes: cfg.break_minutes ?? null,
    break_after_minutes: cfg.break_after_minutes ?? null,
    night_start: cfg.night_start ?? null,
    night_end: cfg.night_end ?? null,
    rounding_policy: cfg.rounding_policy ?? null,
    rounding_policy_version: cfg.rounding_policy_version ?? null,
    rounding_policy_config: cfg.rounding_policy_config ?? null,
    overtime_policy: cfg.overtime_policy ?? null,
    overtime_policy_version: cfg.overtime_policy_version ?? null,
    overtime_policy_config: cfg.overtime_policy_config ?? null,
  };
}

function profileInputForEffective(cfg, historicalRow) {
  if (!cfg) return historicalRow || null;
  if (!historicalRow?.snapshot_complete) return cfg;

  if (cfg.source !== 'shift_assignment') {
    // Para horario habitual, la fila completa de 075 es autoritativa sobre la
    // proyección mínima del resolver.
    return { ...cfg, ...historicalRow };
  }

  // Turnera = CUÁNDO trabaja ese día; snapshot histórico = perfil/policies.
  // Conservamos del plan diario sus segmentos, descanso y target diario, pero
  // las políticas/versiones y la carga semanal individual vienen del snapshot.
  return {
    ...cfg,
    weekly_target_minutes: historicalRow.weekly_target_minutes
      ?? cfg.weekly_target_minutes
      ?? null,
    work_regime: historicalRow.work_regime ?? cfg.work_regime ?? null,
    night_start: historicalRow.night_start ?? cfg.night_start ?? null,
    night_end: historicalRow.night_end ?? cfg.night_end ?? null,
    rounding_policy: historicalRow.rounding_policy ?? cfg.rounding_policy ?? null,
    rounding_policy_version: historicalRow.rounding_policy_version ?? null,
    rounding_policy_config: historicalRow.rounding_policy_config ?? null,
    overtime_policy: historicalRow.overtime_policy ?? cfg.overtime_policy ?? null,
    overtime_policy_version: historicalRow.overtime_policy_version ?? null,
    overtime_policy_config: historicalRow.overtime_policy_config ?? null,
    // El descanso y objetivo DIARIO pertenecen a la asignación concreta.
    break_mode: cfg.break_mode ?? historicalRow.break_mode ?? null,
    break_minutes: cfg.break_minutes ?? historicalRow.break_minutes ?? null,
    break_after_minutes: cfg.break_after_minutes ?? historicalRow.break_after_minutes ?? null,
    daily_target_minutes: cfg.daily_target_minutes
      ?? historicalRow.daily_target_minutes
      ?? null,
  };
}

async function getEffectiveConfiguration(employeeId, date) {
  if (!validDateISO(date)) throw httpError(400, 'INVALID_DATE', 'date debe ser una fecha real YYYY-MM-DD');
  await ensureEmployee(employeeId);

  const [resolver, exception, fullHistory] = await Promise.all([
    loadWorkdayConfig([employeeId], { from: date, to: date }),
    loadCalendarException(employeeId, date),
    getHistory(employeeId),
  ]);

  const cfg = resolver.forDate(employeeId, date);
  // Para la API de FASE C se usa la fila COMPLETA (incluye metadata/policies de
  // la 075), no sólo la proyección mínima que consume WorkdayEngine.
  const historicalRow = vigenteEn(fullHistory, date);
  const turneraConflict = Array.isArray(cfg?.conflict_shift_schedule_ids)
    && cfg.conflict_shift_schedule_ids.length > 1;

  let expectedWorkday = null;
  let kind = null;
  if (exception.permission) {
    expectedWorkday = false;
    kind = exception.permission.type === 'vacation' ? 'vacation' : 'permission';
  } else if (exception.holiday) {
    expectedWorkday = false;
    kind = 'holiday';
  } else if (turneraConflict) {
    expectedWorkday = null;
    kind = 'configuration_conflict';
  } else if (cfg?.non_working) {
    expectedWorkday = false;
    kind = cfg.kind || 'off';
  } else if (cfg?.source === 'shift_assignment') {
    expectedWorkday = true;
    kind = 'work';
  } else if (Array.isArray(cfg?.work_days)) {
    expectedWorkday = cfg.work_days.includes(mysqlDayOfWeek(date));
    kind = expectedWorkday ? 'work' : 'off';
  }

  const approvedLeaveConflictsWithShift = Boolean(
    exception.permission && cfg?.source === 'shift_assignment' && !cfg?.non_working,
  );

  return {
    employee_id: Number(employeeId),
    date,
    calculation_mode_candidate: cfg && !turneraConflict ? 'configured' : 'historical_fallback',
    source: cfg?.source || 'historical_fallback',
    configuration_conflict: turneraConflict,
    calendar_conflict: approvedLeaveConflictsWithShift,
    conflict_shift_schedule_ids: cfg?.conflict_shift_schedule_ids || null,
    expected_workday: expectedWorkday,
    kind,
    schedule_snapshot: historicalRow || null,
    profile: profileFromConfig(profileInputForEffective(cfg, historicalRow)),
    turnera: cfg?.source === 'shift_assignment' ? {
      shift_schedule_id: cfg.shift_schedule_id,
      check_in: cfg.check_in || null,
      check_out: cfg.check_out || null,
      segments: cfg.segments || 0,
      weekly_target_minutes: cfg.weekly_target_minutes ?? null,
      shift_weekly_target_minutes: cfg.shift_weekly_target_minutes ?? null,
      daily_target_minutes: cfg.daily_target_minutes ?? null,
      kind: cfg.kind || 'work',
    } : null,
    permission: exception.permission,
    holiday: exception.holiday,
    config_incomplete: Boolean(historicalRow && !historicalRow.snapshot_complete),
    contract_id: cfg?.contract_id ?? null,
  };
}

module.exports = {
  WORK_REGIMES,
  BREAK_MODES,
  validDateISO,
  normalizeWorkDays,
  buildSnapshot,
  snapshotFromSchedule,
  composeScheduleWithProfile,
  rowToPublic,
  withEmployeeConfigLock,
  getHistory,
  createHistory,
  updateHistory,
  closeHistory,
  getEffectiveConfiguration,
  mysqlDayOfWeek,
};
