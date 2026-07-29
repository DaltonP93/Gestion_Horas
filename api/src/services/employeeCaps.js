/**
 * employeeCaps.js — sub-acciones granulares sobre la ficha del empleado.
 *
 * PR 1 (edición de ficha). Introduce el vocabulario mínimo de sub-acciones
 * que el frontend usa para mostrar u ocultar controles y que el backend
 * exige antes de escribir. El catálogo global (módulo/submódulo/acción)
 * llega en PR 3; aquí sólo se cubren las capacidades de esta pantalla.
 *
 * Sub-acciones:
 *   - personal.update    (nombre, apellido, teléfono, cargo, etc.)
 *   - legal.view         (C.I., N° IPS, salario, género, hijos, antigüedad)
 *   - legal.update       (modificar los datos legales)
 *   - biometrics.link    (vincular reloj)
 *   - status.change      (dar de baja / reactivar)
 */

// Defaults por rol. Nadie más allá de super_admin/admin obtiene bypass total.
// Supervisor por defecto es solo lectura (sin ver legal ni tocar nada).
const ROLE_CAPS = {
  super_admin: { personal_update: true,  legal_view: true,  legal_update: true,  biometrics_link: true,  status_change: true  },
  admin:       { personal_update: true,  legal_view: true,  legal_update: true,  biometrics_link: true,  status_change: true  },
  gth:         { personal_update: true,  legal_view: true,  legal_update: true,  biometrics_link: true,  status_change: true  },
  hr:          { personal_update: true,  legal_view: true,  legal_update: true,  biometrics_link: true,  status_change: true  },
  manager:     { personal_update: false, legal_view: true,  legal_update: false, biometrics_link: false, status_change: false },
  coordinator: { personal_update: false, legal_view: true,  legal_update: false, biometrics_link: false, status_change: false },
  gestor:      { personal_update: false, legal_view: true,  legal_update: false, biometrics_link: false, status_change: false },
  supervisor:  { personal_update: false, legal_view: false, legal_update: false, biometrics_link: false, status_change: false },
  employee:    { personal_update: false, legal_view: false, legal_update: false, biometrics_link: false, status_change: false },
};

const EMPTY = { personal_update: false, legal_view: false, legal_update: false, biometrics_link: false, status_change: false };

function capsForRole(role) {
  return { ...(ROLE_CAPS[role] || EMPTY) };
}

// Campos legales tratados con permiso separado (matchea allowlist de /quick).
const LEGAL_FIELDS = new Set([
  'document_number', 'ips_number', 'salary_base',
  'gender', 'pay_type', 'children_count', 'antiguedad_rate',
]);

function classifyField(field) {
  return LEGAL_FIELDS.has(field) ? 'legal' : 'personal';
}

module.exports = { capsForRole, classifyField, LEGAL_FIELDS, ROLE_CAPS };
