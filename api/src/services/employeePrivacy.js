/**
 * employeePrivacy.js — Enmascaramiento de datos sensibles del empleado.
 *
 * Antes vivía inline en `employeeController.getAll/getById`. Se extrae
 * para (a) tener una sola fuente de verdad de "qué campos son sensibles"
 * y (b) reutilizarlo en cualquier endpoint que devuelva empleados.
 *
 * Reglas:
 *   - Si el usuario no tiene `legal_view`, los campos legales se enmascaran.
 *   - "Enmascarar" en `list` (baja resolución) → `null`. En `detail` la UI
 *     puede mostrar `•••` para diferenciar "no autorizado" de "vacío".
 *   - Los campos personales (nombre, teléfono, cargo) NO se enmascaran
 *     con este servicio; su privacidad se maneja con RBAC de módulo.
 */

const { capsForRole } = require('./employeeCaps');

// Campos legales tratados como sensibles. Mismo listado que
// `employeeCaps.LEGAL_FIELDS` — se mantiene aquí explícito para tests.
const LEGAL_FIELDS = [
  'document_number',
  'ips_number',
  'salary_base',
  'gender',
  'pay_type',
  'children_count',
  'antiguedad_rate',
  'birth_date',
];

/**
 * Enmascara `row` (mutación in-place para evitar copias en loops de miles).
 * `caps` puede venir precomputado; si no, se resuelve por rol del user.
 */
function maskEmployeeRow(row, { user, caps } = {}) {
  if (!row) return row;
  const c = caps || capsForRole(user?.role);
  if (c.legal_view) return row;
  for (const f of LEGAL_FIELDS) {
    if (f in row) row[f] = null;
  }
  return row;
}

function maskEmployeeList(rows, { user, caps } = {}) {
  const c = caps || capsForRole(user?.role);
  if (c.legal_view) return rows;
  for (const r of rows) maskEmployeeRow(r, { caps: c });
  return rows;
}

/**
 * Devuelve un objeto `_privacy` para adjuntar a la respuesta de detalle:
 * la UI puede decidir si mostrar un mensaje o un placeholder.
 */
function privacyDescriptor({ user, caps } = {}) {
  const c = caps || capsForRole(user?.role);
  return {
    legal_visible: !!c.legal_view,
    masked_fields: c.legal_view ? [] : [...LEGAL_FIELDS],
  };
}

module.exports = {
  LEGAL_FIELDS,
  maskEmployeeRow,
  maskEmployeeList,
  privacyDescriptor,
};
