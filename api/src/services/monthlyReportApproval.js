/**
 * monthlyReportApproval.js
 *
 * FASE 2 — Lógica del circuito de aprobación multinivel + firma electrónica
 * interna del REPORTE MENSUAL DE MARCADAS.
 *
 * REUTILIZA el workflow de permisos (services/permissionWorkflow.js): los
 * estados, `roleForState`, `nextApprovedState` y `canUserActOn` son los mismos.
 * Un pedido mensual usa `status` donde el permiso usa `approval_state`; se
 * adapta la forma al invocar los helpers compartidos, para no duplicar la
 * semántica coordinador → gerente de área → RR.HH.
 *
 * Estados (idénticos a permisos):
 *   pending → level1_ok → level2_ok → approved (+ rejected / cancelled)
 *
 * Al llegar a `approved` RR.HH. firma: se registra signed_by, signed_at y un
 * integrity_hash SHA-256 sobre una representación canónica de los datos del
 * reporte de ese (year, month, department_id).
 *
 * SIN PII NI TEXTO LIBRE en las tablas ni en la traza: sólo ids, roles,
 * acciones, timestamps y el hash.
 *
 * No escribe en att2000, attendance_logs ni daily_summary: sólo lee
 * daily_summary/employees para calcular el hash.
 */

const crypto = require('crypto');
const { sequelize } = require('../config/database');
const {
  roleForState,
  nextApprovedState,
  canUserActOn: permissionCanUserActOn,
} = require('./permissionWorkflow');

const STATES = ['pending', 'level1_ok', 'level2_ok', 'approved', 'rejected', 'cancelled'];
const OPEN_STATES = ['pending', 'level1_ok', 'level2_ok'];

/**
 * Adapta un pedido mensual a la forma que espera el workflow de permisos y
 * delega en su `canUserActOn`. Así la validación de rol + coordinator_id /
 * manager_id del departamento es EXACTAMENTE la misma que en permisos.
 */
async function canUserActOn(user, approval) {
  return permissionCanUserActOn(user, {
    approval_state: approval.status,
    department_id: approval.department_id,
  });
}

/**
 * Flags de niveles requeridos para un período, derivados del departamento:
 *   - needs_level1 = el depto tiene coordinador asignado
 *   - needs_level2 = el depto tiene gerente asignado
 *   - needs_final  = SIEMPRE (RR.HH. firma el documento)
 *
 * Para un período org-wide (department = null) no hay coordinador ni gerente
 * de una organización entera: sólo RR.HH./admin lo aprueban y firman.
 */
function computeNeeds(department) {
  if (!department) {
    return { needs_level1: 0, needs_level2: 0, needs_final: 1 };
  }
  return {
    needs_level1: department.coordinator_id ? 1 : 0,
    needs_level2: department.manager_id ? 1 : 0,
    needs_final: 1,
  };
}

/**
 * Estado inicial de un pedido recién creado, salteando niveles sin actor
 * asignado. El nombre del estado representa "último nivel completado".
 */
function initialStatus(needs) {
  if (needs.needs_level1) return 'pending';
  if (needs.needs_level2) return 'level1_ok';
  if (needs.needs_final) return 'level2_ok';
  return 'approved';
}

/** Lee coordinator_id / manager_id del departamento (o null si org-wide). */
async function resolveDepartment(department_id) {
  if (department_id == null) return null;
  const [[dept]] = await sequelize.query(
    'SELECT id, coordinator_id, manager_id FROM departments WHERE id = ?',
    { replacements: [department_id] }
  );
  return dept || null;
}

/**
 * Registra un evento de traza. SIN texto libre: sólo ids/rol/acción/estado.
 * Best-effort dentro de una transacción provista.
 */
async function logEvent({ approval_id, actor_user_id, actor_role, action, to_state }, transaction) {
  await sequelize.query(
    `INSERT INTO monthly_report_approval_events
       (approval_id, actor_user_id, actor_role, action, to_state)
     VALUES (?,?,?,?,?)`,
    { replacements: [approval_id, actor_user_id, actor_role, action, to_state], transaction }
  );
}

/**
 * Normaliza cualquier valor a texto estable para el hash. No importa el
 * formato exacto: sólo que sea determinístico y cambie si el dato cambia.
 */
function stable(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Construye la representación canónica del reporte mensual y su SHA-256.
 *
 * ── QUÉ ENTRA EN EL HASH (documentado) ─────────────────────────────
 *   v (versión del esquema del hash), período (year, month), alcance
 *   (department_id, o 'ORG' si es org-wide) y, POR CADA empleado activo del
 *   alcance —ordenado por código de empleado y fecha—, una fila con:
 *     [ código, fecha, estado, entrada, salida,
 *       minutos_trabajados, minutos_atraso, minutos_extra ].
 *
 *   Sólo se usa el CÓDIGO del empleado (no el nombre): el hash cambia si
 *   cambia cualquier marca/estado/minuto subyacente (detecta manipulación),
 *   sin arrastrar PII de nombres al cálculo. El hash guardado no contiene los
 *   datos; es un digest irreversible.
 *
 *   No entran datos de att2000: se lee daily_summary (ya calculado), nunca la
 *   fuente externa read-only.
 */
async function computeReportIntegrity({ year, month, department_id }) {
  const y = Number(year);
  const m = Number(month);
  const dateFrom = `${y}-${String(m).padStart(2, '0')}-01`;
  const dateTo = new Date(y, m, 0).toISOString().split('T')[0];

  const params = [dateFrom, dateTo];
  let deptFilter = '';
  if (department_id != null) {
    deptFilter = 'AND e.department_id = ?';
    params.push(department_id);
  }

  const [rows] = await sequelize.query(`
    SELECT
      e.code AS employee_code,
      ds.date, ds.status, ds.first_in, ds.last_out,
      ds.worked_minutes, ds.late_minutes, ds.overtime_minutes
    FROM employees e
    LEFT JOIN daily_summary ds
      ON e.id = ds.employee_id AND ds.date BETWEEN ? AND ?
    WHERE e.status = 'active' ${deptFilter}
    ORDER BY e.code, ds.date
  `, { replacements: params });

  const normRows = rows.map(r => [
    stable(r.employee_code),
    stable(r.date),
    stable(r.status),
    stable(r.first_in),
    stable(r.last_out),
    r.worked_minutes == null ? '' : String(r.worked_minutes),
    r.late_minutes == null ? '' : String(r.late_minutes),
    r.overtime_minutes == null ? '' : String(r.overtime_minutes),
  ]);

  const canonical = JSON.stringify({
    v: 1,
    period: { year: y, month: m },
    scope: department_id == null ? 'ORG' : `DEPT:${department_id}`,
    rows: normRows,
  });

  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { hash, canonical, rows };
}

/**
 * Bandeja de pendientes que le tocan al usuario por su rol/depto.
 * Reutiliza la misma semántica de roles del inbox de permisos.
 */
async function getInboxFor(user) {
  if (!user) return [];

  const base = `
    SELECT a.*, d.name AS department, d.coordinator_id, d.manager_id
    FROM monthly_report_approvals a
    LEFT JOIN departments d ON a.department_id = d.id
  `;

  // super_admin / admin / gth → ven TODO lo abierto en cualquier nivel.
  if (['super_admin', 'admin', 'gth'].includes(user.role)) {
    const [rows] = await sequelize.query(
      `${base} WHERE a.status IN ('pending','level1_ok','level2_ok')
       ORDER BY a.submitted_at ASC LIMIT 500`
    );
    return rows;
  }

  // coordinator → nivel 1 (pending) de los deptos donde es coordinador.
  if (user.role === 'coordinator') {
    const [rows] = await sequelize.query(
      `${base} WHERE a.status = 'pending' AND d.coordinator_id = ?
       ORDER BY a.submitted_at ASC LIMIT 500`,
      { replacements: [user.id] }
    );
    return rows;
  }

  // manager → nivel 2 (level1_ok) de sus deptos.
  if (user.role === 'manager') {
    const [rows] = await sequelize.query(
      `${base} WHERE a.status = 'level1_ok' AND d.manager_id = ?
       ORDER BY a.submitted_at ASC LIMIT 500`,
      { replacements: [user.id] }
    );
    return rows;
  }

  return [];
}

module.exports = {
  STATES,
  OPEN_STATES,
  canUserActOn,
  computeNeeds,
  initialStatus,
  resolveDepartment,
  logEvent,
  roleForState,
  nextApprovedState,
  computeReportIntegrity,
  getInboxFor,
};
