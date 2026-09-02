'use strict';

/**
 * people.js — FASE F2.
 *
 * Backend de personas: candidatos (con conversión trazable a empleado) e
 * historial de asignaciones organizativas con vigencia efectiva.
 *
 * Kill switch fail-closed: `PEOPLE_WRITE_ENABLED` (sólo "true" habilita).
 *
 * INVARIANTE DE HISTORIAL: las asignaciones son APPEND-ONLY. Crear una nueva
 * vigencia NO borra la anterior: cierra la vigencia abierta previa
 * (`valid_to` = nuevo `valid_from` - 1 día) dentro de la misma transacción.
 * Así el contexto anterior se conserva siempre.
 *
 * La conversión de candidato NO fabrica un empleado: enlaza a uno EXISTENTE.
 */

const { sequelize } = require('../config/database');

function isWriteEnabled() {
  return process.env.PEOPLE_WRITE_ENABLED === 'true';
}
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
function assertWriteEnabled() {
  if (isWriteEnabled()) return;
  throw httpError(503, 'PEOPLE_WRITES_DISABLED', 'La gestión de personas está en modo sólo lectura durante el rollout');
}

async function employeeExists(id) {
  const [rows] = await sequelize.query('SELECT 1 AS ok FROM employees WHERE id = ? LIMIT 1', { replacements: [id] });
  return rows.length > 0;
}

// ─── Candidatos ─────────────────────────────────────────────────────────────

async function listCandidates({ status } = {}) {
  const where = [];
  const repl = [];
  if (status) { where.push('c.status = ?'); repl.push(status); }
  const [rows] = await sequelize.query(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.source,
            c.position_applied, c.status, c.converted_employee_id,
            c.created_at, c.updated_at
       FROM candidates c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.created_at DESC`,
    { replacements: repl },
  );
  return rows;
}

async function getCandidate(id) {
  const [rows] = await sequelize.query(
    `SELECT id, first_name, last_name, email, phone, source, position_applied,
            status, notes, converted_employee_id, created_at, updated_at
       FROM candidates WHERE id = ? LIMIT 1`,
    { replacements: [id] },
  );
  return rows[0] || null;
}

async function createCandidate(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO candidates
       (first_name, last_name, email, phone, source, position_applied, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [
      data.first_name, data.last_name, data.email ?? null, data.phone ?? null,
      data.source ?? null, data.position_applied ?? null, data.status || 'new',
      data.notes ?? null, userId ?? null,
    ] },
  );
  return result.insertId;
}

async function updateCandidate(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  if (!sets.length) return 0;
  const [result] = await sequelize.query(
    `UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`,
    { replacements: [...vals, id] },
  );
  return Number(result?.affectedRows ?? 0);
}

/**
 * Conversión trazable: marca el candidato como 'hired' y lo enlaza a un
 * empleado EXISTENTE. No crea empleados ni fabrica datos. Idempotencia suave:
 * si ya está convertido, se rechaza (409) para no pisar el enlace.
 */
async function convertCandidate(id, employeeId) {
  const cand = await getCandidate(id);
  if (!cand) throw httpError(404, 'CANDIDATE_NOT_FOUND', 'Candidato no encontrado');
  if (cand.converted_employee_id) {
    throw httpError(409, 'CANDIDATE_ALREADY_CONVERTED', 'El candidato ya fue convertido');
  }
  if (!(await employeeExists(employeeId))) {
    throw httpError(400, 'EMPLOYEE_NOT_FOUND', 'employee_id no corresponde a un empleado existente');
  }
  await sequelize.query(
    "UPDATE candidates SET status = 'hired', converted_employee_id = ? WHERE id = ?",
    { replacements: [employeeId, id] },
  );
  return { candidate_id: id, converted_employee_id: employeeId, from_status: cand.status };
}

// ─── Asignaciones (vigencia efectiva, append-only) ──────────────────────────

async function listAssignments(employeeId) {
  const [rows] = await sequelize.query(
    `SELECT a.id, a.employee_id, a.branch_id, a.department_id, a.cost_center_id,
            a.job_title, a.reference_salary, a.valid_from, a.valid_to, a.change_reason,
            a.created_at,
            b.name AS branch_name, d.name AS department_name, cc.name AS cost_center_name
       FROM employee_assignments a
       LEFT JOIN branches    b  ON b.id  = a.branch_id
       LEFT JOIN departments d  ON d.id  = a.department_id
       LEFT JOIN cost_centers cc ON cc.id = a.cost_center_id
      WHERE a.employee_id = ?
      ORDER BY a.valid_from DESC, a.id DESC`,
    { replacements: [employeeId] },
  );
  return rows;
}

async function openAssignment(employeeId) {
  const [rows] = await sequelize.query(
    `SELECT id, valid_from FROM employee_assignments
      WHERE employee_id = ? AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1`,
    { replacements: [employeeId] },
  );
  return rows[0] || null;
}

/**
 * Crea una nueva vigencia. Append-only: cierra la vigencia abierta previa en la
 * misma transacción. Rechaza inserciones fuera de orden (una vigencia abierta
 * que empiece en/después del nuevo valid_from) para no solapar el historial.
 */
async function createAssignment(employeeId, data, userId) {
  if (!(await employeeExists(employeeId))) {
    throw httpError(400, 'EMPLOYEE_NOT_FOUND', 'employee_id no corresponde a un empleado existente');
  }
  const open = await openAssignment(employeeId);
  if (open && String(open.valid_from) >= String(data.valid_from)) {
    throw httpError(409, 'ASSIGNMENT_OUT_OF_ORDER',
      'Ya existe una vigencia abierta con fecha igual o posterior; corregí las fechas');
  }

  const tx = await sequelize.transaction();
  try {
    if (open) {
      await sequelize.query(
        `UPDATE employee_assignments
            SET valid_to = DATE_SUB(?, INTERVAL 1 DAY)
          WHERE id = ? AND valid_to IS NULL`,
        { replacements: [data.valid_from, open.id], transaction: tx },
      );
    }
    const [result] = await sequelize.query(
      `INSERT INTO employee_assignments
         (employee_id, branch_id, department_id, cost_center_id, job_title,
          reference_salary, valid_from, valid_to, change_reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      { replacements: [
        employeeId, data.branch_id ?? null, data.department_id ?? null,
        data.cost_center_id ?? null, data.job_title ?? null,
        data.reference_salary ?? null, data.valid_from,
        data.change_reason ?? null, userId ?? null,
      ], transaction: tx },
    );
    await tx.commit();
    return { id: result.insertId, closed_previous: open ? open.id : null };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = {
  isWriteEnabled,
  assertWriteEnabled,
  employeeExists,
  listCandidates,
  getCandidate,
  createCandidate,
  updateCandidate,
  convertCandidate,
  listAssignments,
  openAssignment,
  createAssignment,
};
