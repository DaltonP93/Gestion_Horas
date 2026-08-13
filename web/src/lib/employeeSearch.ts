/**
 * employeeSearch.ts — Lógica pura del buscador de empleados.
 *
 * La búsqueda es REMOTA: `/api/employees` ya filtra por nombre, apellido,
 * código, legajo, documento y nombre completo concatenado. Acá no se filtra
 * nada en el cliente; sólo se decide cuándo vale la pena consultar y cómo
 * mostrar cada resultado.
 *
 * Se mantiene separado del componente para poder probar estas reglas sin
 * montar React.
 */

export interface EmpleadoOpcion {
  id: number | string;
  code?: string | null;
  employee_number?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  department?: string | null;
  department_name?: string | null;
}

/** Caracteres mínimos para disparar una búsqueda de texto. */
export const MIN_CHARS = 2;

/**
 * ¿Vale la pena consultar al servidor con este término?
 *
 * Regla general: al menos dos caracteres, para no pedir la empresa entera en
 * cuanto alguien toca una tecla.
 *
 * Excepción: los términos NUMÉRICOS se buscan desde un solo carácter. Los
 * códigos y legajos son cortos y la gente los tipea de memoria; exigir dos
 * dígitos volvería inalcanzable al empleado con código "7".
 */
export function shouldSearch(term: string): boolean {
  const t = (term || '').trim();
  if (!t) return false;
  if (/^\d+$/.test(t)) return true;
  return t.length >= MIN_CHARS;
}

/** "Nombre Apellido" — la línea principal del resultado. */
export function employeeLabel(emp: EmpleadoOpcion | null | undefined): string {
  if (!emp) return '';
  const full = (emp.full_name || '').trim();
  if (full) return full;
  return [emp.first_name, emp.last_name].filter(Boolean).join(' ').trim();
}

/**
 * "Cód. XXXX · Departamento" — la línea secundaria.
 *
 * Se omite la parte que falte en vez de imprimir separadores huérfanos o la
 * palabra "null", que es lo que se ve cuando un empleado no tiene
 * departamento asignado.
 */
export function employeeMeta(emp: EmpleadoOpcion | null | undefined): string {
  if (!emp) return '';
  const partes: string[] = [];
  if (emp.code) partes.push(`Cód. ${emp.code}`);
  const depto = emp.department || emp.department_name;
  if (depto) partes.push(String(depto));
  return partes.join(' · ');
}

/** Texto de una sola línea, para el input una vez elegido el empleado. */
export function employeeInputText(emp: EmpleadoOpcion | null | undefined): string {
  if (!emp) return '';
  const label = employeeLabel(emp);
  return emp.code ? `${label} (${emp.code})` : label;
}
