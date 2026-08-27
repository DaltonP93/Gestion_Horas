/**
 * workdayConfig.js — Resolución de la configuración de jornada desde la base.
 *
 * Separa la LECTURA de la configuración del CÁLCULO de la jornada.
 * `workdayEngine` es puro y no toca la base; este módulo le arma la entrada.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PRECEDENCIA
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   1. `shift_assignments` de una turnera PUBLICADA para esa fecha exacta.
 *      Es la excepción del día: si RRHH programó un turno concreto para el
 *      martes, ese turno manda sobre el horario habitual.
 *
 *   2. `employee_schedule_history` vigente para esa fecha. Es el horario
 *      habitual CON vigencia, que es lo que permite calcular el pasado.
 *
 *   3. `employee_contracts` vigente. Hoy sólo aporta la IDENTIDAD del contrato
 *      (contract_id), no carga horaria ni horas de entrada/salida: la tabla
 *      todavía no tiene esos campos. Por sí solo NO habilita el cálculo de
 *      atraso; se adjunta para trazabilidad y para la FASE C posterior.
 *
 *   4. Nada → `historical_fallback`, y el motor describe lo que dicen los
 *      marcajes sin inventar un horario.
 *
 * `employees.schedule_id` NO participa. Guarda el horario de HOY y no tiene
 * fecha: usarlo para el pasado es exactamente lo que fabrica atrasos
 * retroactivos. Si a alguien se le cambió el turno de 08:00 a 07:00 en 2026,
 * aplicar el actual haría que todo 2024 aparezca llegando una hora tarde.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SIN N+1
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Todo se lee en TRES consultas por lote de empleados, acotadas al rango del
 * reporte, y después se resuelve en memoria. Consultar la configuración por
 * empleado y día sería una consulta por celda: 500 empleados por 30 días son
 * 15.000 viajes a la base para un solo reporte.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DEGRADACIÓN DELIBERADA
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `employee_schedule_history` la crean las migraciones 072/073, que NO están
 * aplicadas en producción. Que falten no puede tumbar un reporte: si la tabla
 * no existe se devuelve historial vacío y las jornadas caen en
 * `historical_fallback`, que es el comportamiento correcto mientras la
 * vigencia no esté cargada.
 *
 * La distinción importa: se degrada ante "la tabla no existe" (42S02), no ante
 * cualquier error. Una caída de MySQL sigue propagándose, porque devolver "sin
 * configuración" ante una base caída convertiría una falla de infraestructura
 * en números silenciosamente distintos.
 */

'use strict';

const { sequelize } = require('../config/database');
const { isMissingTableError } = require('../utils/schemaState');
const logger = require('../config/logger');

/** Se avisa una sola vez por tabla y por proceso: es una condición estable. */
const avisado = new Set();

function avisarTablaAusente(tabla) {
  if (avisado.has(tabla)) return;
  avisado.add(tabla);
  logger.warn(
    `${tabla} no existe (migración sin aplicar): `
    + 'las jornadas afectadas se calculan en modo historical_fallback',
  );
}

/** Ejecuta una consulta tolerando que la tabla todavía no exista. */
async function consultarOpcional(tabla, sql, replacements) {
  try {
    const [rows] = await sequelize.query(sql, { replacements });
    return rows;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    avisarTablaAusente(tabla);
    return [];
  }
}

const idsValidos = (lista) => [...new Set((lista || []).map(Number).filter(Number.isInteger))];
const marcas = (n) => Array.from({ length: n }, () => '?').join(',');

/**
 * Historial de vigencia de los empleados pedidos.
 *
 * @returns {Map<number, Array>} employee_id → tramos ordenados por valid_from.
 */
async function loadScheduleHistory(employeeIds) {
  const ids = idsValidos(employeeIds);
  if (!ids.length) return new Map();

  const rows = await consultarOpcional('employee_schedule_history', `
    SELECT
      h.employee_id,
      h.schedule_id,
      DATE_FORMAT(h.valid_from, '%Y-%m-%d') AS valid_from,
      DATE_FORMAT(h.valid_to,   '%Y-%m-%d') AS valid_to,
      COALESCE(h.check_in,      s.check_in)      AS check_in,
      COALESCE(h.check_out,     s.check_out)     AS check_out,
      COALESCE(h.tolerance_in,  s.tolerance_in)  AS tolerance_in,
      COALESCE(h.tolerance_out, s.tolerance_out) AS tolerance_out,
      h.break_mode,
      h.break_minutes,
      h.break_after_minutes,
      h.weekly_target_minutes,
      h.daily_target_minutes,
      h.night_start,
      h.night_end,
      s.work_days
    FROM employee_schedule_history h
    LEFT JOIN schedules s ON s.id = h.schedule_id
    WHERE h.employee_id IN (${marcas(ids.length)})
    ORDER BY h.employee_id, h.valid_from
  `, ids);

  const porEmpleado = new Map();
  for (const r of rows) {
    const lista = porEmpleado.get(r.employee_id) || [];
    lista.push(normalizeConfigRow(r));
    porEmpleado.set(r.employee_id, lista);
  }
  return porEmpleado;
}

/**
 * Asignaciones de turnera publicadas dentro del rango.
 *
 * Sólo turneras `published`: un borrador es una propuesta que RRHH todavía
 * está armando, y calcular contra él produciría atrasos por un turno que nunca
 * se comunicó.
 *
 * Un día puede tener dos tramos (turno partido, `segment` 1 y 2). Se conservan
 * los dos: el primero da la entrada prevista y el último la salida.
 */
async function loadShiftAssignments(employeeIds, { from, to }) {
  const ids = idsValidos(employeeIds);
  if (!ids.length) return new Map();

  const rows = await consultarOpcional('shift_assignments', `
    SELECT
      a.employee_id,
      DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
      a.segment,
      a.kind,
      COALESCE(a.start_time, t.start_time) AS start_time,
      COALESCE(a.end_time,   t.end_time)   AS end_time,
      t.break_minutes,
      a.schedule_id AS shift_schedule_id,
      ss.weekly_target_minutes
    FROM shift_assignments a
    JOIN shift_schedules ss ON ss.id = a.schedule_id AND ss.status = 'published'
    LEFT JOIN shift_templates t ON t.id = a.template_id
    WHERE a.employee_id IN (${marcas(ids.length)})
      AND a.work_date >= ? AND a.work_date <= ?
    ORDER BY a.employee_id, a.work_date, a.segment
  `, [...ids, from, to]);

  const porClave = new Map();
  for (const r of rows) {
    const clave = `${r.employee_id}|${r.work_date}`;
    const lista = porClave.get(clave) || [];
    lista.push(r);
    porClave.set(clave, lista);
  }
  return porClave;
}

/**
 * Contratos que se solapan con el rango.
 *
 * Lo que HOY aporta esta consulta es sólo la IDENTIDAD del contrato vigente
 * (contract_id) y su vigencia. `employee_contracts` todavía NO tiene carga
 * horaria (weekly_target/daily_target), así que el motor NO obtiene de acá el
 * objetivo semanal —ese dato viene de `employee_schedule_history` cuando está
 * cargado—. Adjuntar el contract_id sirve para trazabilidad y para que la
 * FASE C posterior, cuando el contrato lleve carga horaria, tenga dónde
 * colgarla sin cambiar la forma de esta resolución.
 *
 * En resumen: por ahora el contrato dice QUIÉN, no CUÁNTO.
 */
async function loadContracts(employeeIds, { from, to }) {
  const ids = idsValidos(employeeIds);
  if (!ids.length) return new Map();

  const rows = await consultarOpcional('employee_contracts', `
    SELECT
      c.id AS contract_id,
      c.employee_id,
      DATE_FORMAT(c.start_date, '%Y-%m-%d') AS start_date,
      DATE_FORMAT(c.end_date,   '%Y-%m-%d') AS end_date
    FROM employee_contracts c
    WHERE c.employee_id IN (${marcas(ids.length)})
      AND c.start_date <= ?
      AND (c.end_date IS NULL OR c.end_date >= ?)
    ORDER BY c.employee_id, c.start_date
  `, [...ids, to, from]);

  const porEmpleado = new Map();
  for (const r of rows) {
    const lista = porEmpleado.get(r.employee_id) || [];
    lista.push(r);
    porEmpleado.set(r.employee_id, lista);
  }
  return porEmpleado;
}

/**
 * Carga toda la configuración del lote y devuelve un resolvedor por fecha.
 *
 * @returns {{ forDate(employeeId, workDate): Object|null, historyFor(employeeId): Array }}
 */
async function loadWorkdayConfig(employeeIds, { from, to }) {
  const [history, assignments, contracts] = await Promise.all([
    loadScheduleHistory(employeeIds),
    loadShiftAssignments(employeeIds, { from, to }),
    loadContracts(employeeIds, { from, to }),
  ]);

  return {
    historyFor: (employeeId) => history.get(Number(employeeId)) || [],

    forDate(employeeId, workDate) {
      const id = Number(employeeId);

      // 1. Turnera publicada para esa fecha exacta.
      const tramos = assignments.get(`${id}|${workDate}`);
      if (tramos && tramos.length) {
        const cfg = configDesdeTurnera(tramos);
        if (cfg) return cfg;
      }

      // 2. Horario habitual con vigencia.
      const tramo = vigenteEn(history.get(id), workDate);
      if (tramo) {
        return {
          ...tramo,
          contract_id: contratoVigente(contracts.get(id), workDate),
          source: 'schedule_history',
        };
      }

      // 3. Contrato: aporta carga, no horario. NO habilita el modo
      //    `configured` por sí solo — sin hora de entrada no hay atraso que
      //    calcular, y devolver una config a medias haría que el motor deje de
      //    reportar el fallback cuando en realidad no sabe el horario.
      return null;
    },
  };
}

/** Tramo de historial vigente en la fecha; gana el `valid_from` más reciente. */
function vigenteEn(tramos, workDate) {
  if (!Array.isArray(tramos) || !tramos.length) return null;
  let mejor = null;
  for (const t of tramos) {
    if (!t.valid_from || t.valid_from > workDate) continue;
    if (t.valid_to && t.valid_to < workDate) continue;
    if (!mejor || t.valid_from > mejor.valid_from) mejor = t;
  }
  return mejor;
}

function contratoVigente(lista, workDate) {
  if (!Array.isArray(lista)) return null;
  for (const c of lista) {
    if (c.start_date > workDate) continue;
    if (c.end_date && c.end_date < workDate) continue;
    return c.contract_id;
  }
  return null;
}

/**
 * Configuración derivada de los tramos de turnera de un día.
 *
 * Los días marcados `off`, `vacation`, `permiso` o `presupuesto` NO son
 * jornadas de trabajo con horario: devolver un horario para ellos haría que
 * una persona de vacaciones figure llegando tarde todos los días. Se devuelve
 * `null` con el `kind` a la vista para que el consumidor lo trate como lo que
 * es y no como una ausencia común.
 */
function configDesdeTurnera(tramos) {
  const trabajo = tramos.filter((t) => (t.kind || 'work') === 'work' && t.start_time && t.end_time);
  if (!trabajo.length) {
    return {
      non_working: true,
      kind: tramos[0].kind || 'off',
      shift_schedule_id: tramos[0].shift_schedule_id ?? null,
      source: 'shift_assignment',
    };
  }

  const primero = trabajo[0];
  const ultimo = trabajo[trabajo.length - 1];
  return {
    schedule_id: null,
    shift_schedule_id: primero.shift_schedule_id ?? null,
    check_in: String(primero.start_time),
    check_out: String(ultimo.end_time),
    tolerance_in: 0,
    tolerance_out: 0,
    // Un turno partido ya trae el corte marcado en la turnera; el descanso
    // real es el que se fiche entre los tramos.
    break_mode: trabajo.length > 1 ? 'punched' : 'fixed_unpaid',
    break_minutes: trabajo.length > 1 ? 0 : Number(primero.break_minutes || 0),
    break_after_minutes: 0,
    weekly_target_minutes: primero.weekly_target_minutes != null
      ? Number(primero.weekly_target_minutes)
      : null,
    daily_target_minutes: null,
    segments: trabajo.length,
    source: 'shift_assignment',
  };
}

/**
 * Deja la fila lista para el motor.
 *
 * `weekly_target_minutes` se deja en null cuando no está cargado. No se
 * completa con 2880: el objetivo semanal es un dato de RRHH y suponerlo
 * convertiría una omisión de carga en horas extra o en déficit inventado.
 */
function normalizeConfigRow(r) {
  const hora = (v) => (v != null ? String(v) : null);
  const num = (v) => (v != null ? Number(v) : null);
  return {
    schedule_id: num(r.schedule_id),
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    check_in: hora(r.check_in),
    check_out: hora(r.check_out),
    tolerance_in: r.tolerance_in != null ? Number(r.tolerance_in) : 0,
    tolerance_out: r.tolerance_out != null ? Number(r.tolerance_out) : 0,
    break_mode: r.break_mode || 'punched',
    break_minutes: r.break_minutes != null ? Number(r.break_minutes) : 0,
    break_after_minutes: r.break_after_minutes != null ? Number(r.break_after_minutes) : 0,
    weekly_target_minutes: num(r.weekly_target_minutes),
    daily_target_minutes: num(r.daily_target_minutes),
    night_start: hora(r.night_start),
    night_end: hora(r.night_end),
    // Días laborables del horario, ya normalizados a un array de DAYOFWEEK
    // (1=Domingo … 7=Sábado, la convención de la migración 046). Se resuelve
    // acá una sola vez para que el CSV crudo no circule por todo el motor.
    work_days: parseWorkDays(r.work_days),
  };
}

/**
 * "1,2,3,4,5" → [1,2,3,4,5], en la convención DAYOFWEEK del proyecto.
 *
 * IMPORTANTE: la convención NO es la de JavaScript. Tras la migración 046,
 * `schedules.work_days` usa DAYOFWEEK de MySQL: 1=Domingo, 2=Lunes … 7=Sábado.
 * El default sembrado es '2,3,4,5,6' (lunes a viernes). Confundirla con
 * 0=Domingo correría todos los días laborables uno, así que la conversión al
 * comparar contra una fecha tiene que sumar 1 al día JS (0=Dom → 1=Dom).
 *
 * Devuelve `null` —no `[]`— cuando no hay dato: un horario sin work_days
 * cargado no dice "no trabaja ningún día", dice "no sabemos qué días". Esa
 * distinción es la que evita fabricar descansos inventados.
 */
function parseWorkDays(value) {
  if (value == null || value === '') return null;
  const dias = String(value)
    .split(',')
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return dias.length ? [...new Set(dias)].sort((a, b) => a - b) : null;
}

module.exports = {
  loadWorkdayConfig,
  loadScheduleHistory,
  loadShiftAssignments,
  loadContracts,
  normalizeConfigRow,
  parseWorkDays,
  vigenteEn,
  configDesdeTurnera,
};
