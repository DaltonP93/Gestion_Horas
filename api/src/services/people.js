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
const { parseCivilDate, civilDateISO } = require('../utils/civilDate');

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

/**
 * Lista candidatos aplicando ALCANCE organizacional. Roles con alcance sólo ven
 * candidatos de su empresa/sucursal; un candidato sin alcance (company/branch
 * NULL) sólo lo ve un rol global. `scope` proviene de orgScope.getOrgScope.
 */
async function listCandidates({ status } = {}, scope) {
  const orgScope = require('./orgScope');
  const where = [];
  const repl = [];
  if (status) { where.push('c.status = ?'); repl.push(status); }
  const scopeFrag = orgScope.candidateScopeFilter(scope, { companyCol: 'c.company_id', branchCol: 'c.branch_id' });
  // candidateScopeFilter devuelve una cláusula 'AND …'; la integramos como where.
  if (scopeFrag.clause) { where.push(scopeFrag.clause.replace(/^AND\s+/, '')); repl.push(...scopeFrag.params); }
  const [rows] = await sequelize.query(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.source,
            c.position_applied, c.status, c.company_id, c.branch_id,
            c.converted_employee_id, c.created_at, c.updated_at
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
            status, notes, company_id, branch_id, converted_employee_id,
            created_at, updated_at
       FROM candidates WHERE id = ? LIMIT 1`,
    { replacements: [id] },
  );
  return rows[0] || null;
}

/**
 * Valida existencia, ALCANCE y COHERENCIA sucursal → empresa de las referencias
 * de alcance de un candidato. Existencia inválida → 400; fuera de alcance → 403;
 * sucursal que no pertenece a la empresa indicada → 400.
 *
 * Fail-closed (P1-A): un actor con alcance NO puede crear/convertir un candidato
 * SIN alcance (company_id y branch_id ambos NULL) — sólo un rol global puede.
 */
async function validateCandidateRefs(scope, data) {
  const orgScope = require('./orgScope');
  const companyId = data.company_id ?? null;
  const branchId = data.branch_id ?? null;
  if (scope && !scope.unrestricted && companyId == null && branchId == null) {
    throw httpError(403, 'OUT_OF_SCOPE', 'Un rol con alcance no puede crear un candidato sin empresa/sucursal');
  }
  if (branchId != null) {
    const [b] = await sequelize.query('SELECT id, company_id FROM branches WHERE id = ? LIMIT 1', { replacements: [branchId] });
    if (!b.length) throw httpError(400, 'BRANCH_NOT_FOUND', 'La sucursal referenciada no existe');
    orgScope.assertBranchInScope(scope, branchId);
    if (companyId != null && b[0].company_id != null && Number(b[0].company_id) !== Number(companyId)) {
      throw httpError(400, 'INCOHERENT_SCOPE', 'La sucursal no pertenece a la empresa indicada');
    }
  }
  if (companyId != null) {
    const [c] = await sequelize.query('SELECT id FROM companies WHERE id = ? LIMIT 1', { replacements: [companyId] });
    if (!c.length) throw httpError(400, 'COMPANY_NOT_FOUND', 'La empresa referenciada no existe');
    orgScope.assertCompanyInScope(scope, companyId);
  }
}

async function createCandidate(data, userId) {
  const [result] = await sequelize.query(
    `INSERT INTO candidates
       (first_name, last_name, email, phone, source, position_applied, status, notes, company_id, branch_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [
      data.first_name, data.last_name, data.email ?? null, data.phone ?? null,
      data.source ?? null, data.position_applied ?? null, data.status || 'new',
      data.notes ?? null, data.company_id ?? null, data.branch_id ?? null, userId ?? null,
    ] },
  );
  // sequelize.query(INSERT) devuelve [insertId, affectedRows] contra MySQL real,
  // pero un objeto {insertId} con mocks: soportamos ambos (patrón de syncJobs.js).
  return result?.insertId ?? result;
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
 * Conversión trazable y ATÓMICA: marca el candidato como 'hired' y lo enlaza a
 * un empleado EXISTENTE. No crea empleados ni fabrica datos.
 *
 * Atomicidad contra doble conversión concurrente:
 *   1. Transacción + `SELECT ... FOR UPDATE` que bloquea la fila del candidato.
 *   2. `UPDATE ... WHERE converted_employee_id IS NULL` (condicional) + chequeo
 *      de `affectedRows`: aunque dos requests corran a la vez, sólo una gana; la
 *      otra ve 0 filas afectadas y recibe 409.
 */
async function convertCandidate(id, employeeId, scope) {
  const orgScope = require('./orgScope');
  if (!(await employeeExists(employeeId))) {
    throw httpError(400, 'EMPLOYEE_NOT_FOUND', 'employee_id no corresponde a un empleado existente');
  }
  // El EMPLEADO destino debe estar dentro del alcance del actor (403 si no).
  if (scope && !scope.unrestricted) {
    const empRefs = await orgScope.loadEmployeeOrgRefs(employeeId);
    if (!orgScope.canSeeEmployeeRefs(scope, empRefs)) {
      throw httpError(403, 'OUT_OF_SCOPE', 'El empleado destino está fuera de tu alcance');
    }
  }
  let committed = false;
  const tx = await sequelize.transaction();
  try {
    const [rows] = await sequelize.query(
      'SELECT id, status, company_id, branch_id, converted_employee_id FROM candidates WHERE id = ? FOR UPDATE',
      { replacements: [id], transaction: tx },
    );
    const cand = rows[0];
    if (!cand) throw httpError(404, 'CANDIDATE_NOT_FOUND', 'Candidato no encontrado');
    // El CANDIDATO debe estar dentro del alcance del actor. Si no, se responde
    // 404 (no se filtra existencia de candidatos de otra empresa/sucursal).
    if (scope && !scope.unrestricted && !orgScope.canSeeCandidateRefs(scope, cand)) {
      throw httpError(404, 'CANDIDATE_NOT_FOUND', 'Candidato no encontrado');
    }
    if (cand.converted_employee_id) {
      throw httpError(409, 'CANDIDATE_ALREADY_CONVERTED', 'El candidato ya fue convertido');
    }
    const [result] = await sequelize.query(
      "UPDATE candidates SET status = 'hired', converted_employee_id = ? WHERE id = ? AND converted_employee_id IS NULL",
      { replacements: [employeeId, id], transaction: tx },
    );
    if (Number(result?.affectedRows ?? 0) !== 1) {
      throw httpError(409, 'CANDIDATE_ALREADY_CONVERTED', 'El candidato ya fue convertido');
    }
    await tx.commit();
    committed = true;
    return { candidate_id: id, converted_employee_id: employeeId, from_status: cand.status };
  } catch (err) {
    if (!committed) { try { await tx.rollback(); } catch { /* noop */ } }
    throw err;
  }
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
 * Valida existencia, ALCANCE y COHERENCIA MUTUA de las referencias
 * organizativas de una asignación (sucursal/departamento/centro de costo).
 *
 * (P1-B) Coherencia fail-closed: se resuelve la EMPRESA implicada por cada
 * referencia conocida y todas deben coincidir:
 *   - sucursal      → `branches.company_id`
 *   - centro de costo → `cost_centers.company_id`
 *   - departamento  → pertenencia vía el modelo existente
 *                     `departments.cost_center_id → cost_centers.company_id`
 *     (no se inventa una relación nueva: se usa la que ya existe en 076). Un
 *     departamento sin centro de costo no aporta empresa y no bloquea.
 * Si dos referencias conocidas pertenecen a empresas distintas → 400
 * `INCOHERENT_SCOPE` (p.ej. sucursal de empresa A + centro de costo de empresa B).
 * Existencia inválida → 400; fuera de alcance → 403.
 *
 * Se ejecuta DENTRO de la transacción de `createAssignment` (recibe `transaction`)
 * para evitar TOCTOU entre la validación y el INSERT.
 */
async function validateAssignmentRefs(scope, data, transaction) {
  const orgScope = require('./orgScope');
  const q = (sql, repl) => sequelize.query(sql, { replacements: repl, transaction });
  const companies = []; // empresas implicadas (no nulas) para chequear coherencia

  if (data.branch_id != null) {
    const [b] = await q('SELECT id, company_id FROM branches WHERE id = ? LIMIT 1', [data.branch_id]);
    if (!b.length) throw httpError(400, 'BRANCH_NOT_FOUND', 'La sucursal referenciada no existe');
    orgScope.assertBranchInScope(scope, data.branch_id);
    if (b[0].company_id != null) companies.push(Number(b[0].company_id));
  }
  if (data.cost_center_id != null) {
    const [c] = await q('SELECT id, company_id FROM cost_centers WHERE id = ? LIMIT 1', [data.cost_center_id]);
    if (!c.length) throw httpError(400, 'COST_CENTER_NOT_FOUND', 'El centro de costo referenciado no existe');
    orgScope.assertCompanyInScope(scope, c[0].company_id);
    if (c[0].company_id != null) companies.push(Number(c[0].company_id));
  }
  if (data.department_id != null) {
    const [d] = await q(
      `SELECT d.id, cc.company_id AS company_id
         FROM departments d
         LEFT JOIN cost_centers cc ON cc.id = d.cost_center_id
        WHERE d.id = ? LIMIT 1`, [data.department_id]);
    if (!d.length) throw httpError(400, 'DEPARTMENT_NOT_FOUND', 'El departamento referenciado no existe');
    orgScope.assertDepartmentInScope(scope, data.department_id);
    if (d[0].company_id != null) companies.push(Number(d[0].company_id));
  }

  const distinct = [...new Set(companies)];
  if (distinct.length > 1) {
    throw httpError(400, 'INCOHERENT_SCOPE',
      'Las referencias (sucursal/departamento/centro de costo) pertenecen a empresas distintas');
  }
}

/**
 * Crea una nueva vigencia de forma ATÓMICA y append-only.
 *
 * Concurrencia: se abre la transacción y se BLOQUEA la fila del empleado
 * (`SELECT ... FOR UPDATE`) ANTES de leer la vigencia abierta. Así dos requests
 * simultáneas para el mismo empleado se serializan: la segunda ve la vigencia
 * que abrió la primera y, si su `valid_from` no es posterior, recibe 409. Esto
 * impide dos vigencias abiertas y las inserciones retroactivas inválidas incluso
 * partiendo de cero vigencias (el lock es sobre el empleado, no sobre filas que
 * todavía no existen).
 */
async function createAssignment(employeeId, data, userId, scope) {
  // Fecha civil REAL (no sólo formato) antes de abrir transacción: rechaza
  // 2025-02-29, 2026-13-01, etc. Defensa en profundidad además del schema Joi.
  if (!parseCivilDate(data.valid_from)) {
    throw httpError(400, 'INVALID_DATE', 'valid_from no es una fecha civil válida');
  }
  let committed = false;
  const tx = await sequelize.transaction();
  try {
    const [emp] = await sequelize.query(
      'SELECT id FROM employees WHERE id = ? FOR UPDATE',
      { replacements: [employeeId], transaction: tx },
    );
    if (!emp.length) throw httpError(400, 'EMPLOYEE_NOT_FOUND', 'employee_id no corresponde a un empleado existente');

    // Validación de referencias DENTRO de la transacción, tras el lock del
    // empleado (anti-TOCTOU): existencia + alcance + coherencia mutua de empresa.
    await validateAssignmentRefs(scope, data, tx);

    const [openRows] = await sequelize.query(
      `SELECT id, valid_from FROM employee_assignments
        WHERE employee_id = ? AND valid_to IS NULL
        ORDER BY valid_from DESC LIMIT 1`,
      { replacements: [employeeId], transaction: tx },
    );
    const open = openRows[0] || null;
    // El driver mysql entrega columnas DATE como objeto Date (no hay
    // dateStrings), así que `String(open.valid_from)` daría 'Wed Apr 01 2026…'
    // y una comparación de strings sería SIEMPRE verdadera (una letra > un
    // dígito), rechazando toda vigencia posterior. Normalizamos ambos lados a
    // fecha civil ISO (parseCivilDate acepta Date y string) antes de comparar.
    const openISO = open ? civilDateISO(parseCivilDate(open.valid_from)) : null;
    if (open && openISO && openISO >= data.valid_from) {
      throw httpError(409, 'ASSIGNMENT_OUT_OF_ORDER',
        'Ya existe una vigencia abierta con fecha igual o posterior; corregí las fechas');
    }

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
    committed = true;
    // [insertId, affectedRows] contra MySQL real; {insertId} con mocks.
    return { id: result?.insertId ?? result, closed_previous: open ? open.id : null };
  } catch (err) {
    if (!committed) { try { await tx.rollback(); } catch { /* noop */ } }
    throw err;
  }
}

module.exports = {
  isWriteEnabled,
  assertWriteEnabled,
  employeeExists,
  listCandidates,
  getCandidate,
  validateCandidateRefs,
  createCandidate,
  updateCandidate,
  convertCandidate,
  listAssignments,
  openAssignment,
  createAssignment,
  validateAssignmentRefs,
};
