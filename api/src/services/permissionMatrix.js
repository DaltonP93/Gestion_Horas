/**
 * permissionMatrix.js — Catálogo de módulos y permisos por defecto según rol.
 * Usado por API y UI para construir la matriz de permisos.
 */

const MODULES = [
  // Portal (empleado)
  { key: 'mi_perfil',      label: 'Mi perfil',            section: 'portal'  },
  { key: 'mi_asistencia',  label: 'Mi asistencia',        section: 'portal'  },
  { key: 'marcar',         label: 'Marcar (QR/GPS)',      section: 'portal'  },
  { key: 'mis_permisos',   label: 'Mis permisos',         section: 'portal'  },
  { key: 'mis_vacaciones', label: 'Mis vacaciones',       section: 'portal'  },
  // Gestión
  { key: 'dashboard',      label: 'Dashboard',            section: 'gestion' },
  { key: 'empleados',      label: 'Empleados',            section: 'gestion' },
  { key: 'asistencia',     label: 'Asistencia',           section: 'gestion' },
  { key: 'permisos',       label: 'Permisos',             section: 'gestion' },
  { key: 'aprobaciones',   label: 'Aprobaciones',         section: 'gestion' },
  { key: 'supervisor',     label: 'Mi equipo',            section: 'gestion' },
  { key: 'reportes',       label: 'Reportes',             section: 'gestion' },
  { key: 'turnera',        label: 'Turnera (turnos)',     section: 'gestion' },
  { key: 'ejecutivo',      label: 'Dashboard ejecutivo',  section: 'gestion' },
  { key: 'nomina',         label: 'Nómina SAA',           section: 'gestion' },
  // Admin
  { key: 'departamentos',  label: 'Departamentos',        section: 'admin'   },
  { key: 'usuarios',       label: 'Usuarios',             section: 'admin'   },
  { key: 'ingresos',       label: 'Ingresos / Egresos',   section: 'gestion' },
  { key: 'lactancia',      label: 'Maternidad / Lactancia', section: 'gestion' },
  { key: 'auditoria',      label: 'Auditoría',            section: 'admin'   },
  { key: 'reglas',         label: 'Reglas (condiciones)', section: 'admin'   },
  { key: 'configuracion',  label: 'Configuración',        section: 'admin'   },
  { key: 'sistema',        label: 'Sistema',              section: 'admin'   },
];

const ROLE_DEFAULTS = {
  super_admin: { all: { v: 1, c: 1, u: 1, d: 1 } },
  admin:       { all: { v: 1, c: 1, u: 1, d: 1 } },
  gth:         {
    portal:  { v: 0, c: 0, u: 0, d: 0 },   // admin/gth NO ve portal del empleado
    gestion: { v: 1, c: 1, u: 1, d: 1 },
    admin:   { v: 1, c: 1, u: 1, d: 0 },
  },
  hr: {
    portal:  { v: 0, c: 0, u: 0, d: 0 },
    gestion: { v: 1, c: 1, u: 1, d: 0 },
    admin:   { v: 0, c: 0, u: 0, d: 0 },
    only: { configuracion: { v: 1, c: 0, u: 1, d: 0 } },
  },
  manager: {
    portal:  { v: 0, c: 0, u: 0, d: 0 },
    gestion: { v: 1, c: 0, u: 0, d: 0 },
    only: { aprobaciones: { v: 1, c: 1, u: 1, d: 0 }, supervisor: { v: 1, c: 0, u: 0, d: 0 } },
  },
  coordinator: {
    portal:  { v: 0, c: 0, u: 0, d: 0 },
    gestion: { v: 1, c: 0, u: 0, d: 0 },
    only: { aprobaciones: { v: 1, c: 1, u: 1, d: 0 }, supervisor: { v: 1, c: 0, u: 0, d: 0 } },
  },
  gestor: {
    portal:  { v: 0, c: 0, u: 0, d: 0 },
    gestion: { v: 1, c: 0, u: 0, d: 0 },
  },
  supervisor: {
    portal:  { v: 0, c: 0, u: 0, d: 0 },
    gestion: { v: 1, c: 0, u: 0, d: 0 },
    only: { supervisor: { v: 1, c: 0, u: 0, d: 0 } },
  },
  employee: {
    portal:  { v: 1, c: 1, u: 1, d: 1 },
    gestion: { v: 0, c: 0, u: 0, d: 0 },
    admin:   { v: 0, c: 0, u: 0, d: 0 },
  },
};

function defaultsForRole(role) {
  const def = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.employee;
  const out = {};
  for (const m of MODULES) {
    const section = def[m.section] || { v: 0, c: 0, u: 0, d: 0 };
    const all = def.all;
    const only = def.only?.[m.key];
    const src = only || all || section;
    out[m.key] = {
      can_view:   src.v ? 1 : 0,
      can_create: src.c ? 1 : 0,
      can_update: src.u ? 1 : 0,
      can_delete: src.d ? 1 : 0,
    };
  }
  return out;
}

module.exports = { MODULES, ROLE_DEFAULTS, defaultsForRole };
