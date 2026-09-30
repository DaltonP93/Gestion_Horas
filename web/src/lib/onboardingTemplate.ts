/**
 * Alta de plantillas de onboarding. Espeja la validación del API
 * (`api/src/services/onboardingValidation.js`, validateTemplateCreate):
 * `due_days` es un entero de 0 a 3650 y 0 significa "vence el mismo día".
 * El API valida todo igualmente; esto sólo evita enviar valores que rechazaría.
 */
export const TEMPLATE_DUE_DAYS_MAX = 3650

export interface TemplateTaskDraft {
  title: string
  description: string
  default_assignee_role: string
  due_days: number
}

export function isValidDueDays(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= TEMPLATE_DUE_DAYS_MAX
}

type Result =
  | { ok: true; payload: { name: string; type: 'onboarding' | 'offboarding'; description: string; tasks: TemplateTaskDraft[] } }
  | { ok: false; error: string }

/** Filas sin título se descartan (filas vacías del formulario); el resto debe ser válido. */
export function buildTemplatePayload(
  form: { name: string; type: 'onboarding' | 'offboarding'; description: string },
  tasks: TemplateTaskDraft[],
): Result {
  const name = form.name.trim()
  if (!name) return { ok: false, error: 'El nombre es requerido' }
  const rows = tasks.filter(t => t.title.trim())
  if (!rows.length) return { ok: false, error: 'Se requiere al menos una tarea' }
  const bad = rows.findIndex(t => !isValidDueDays(t.due_days))
  if (bad >= 0) return { ok: false, error: `Tarea "${rows[bad].title.trim()}": el plazo debe ser un entero de 0 a ${TEMPLATE_DUE_DAYS_MAX} días` }
  return { ok: true, payload: { ...form, name, tasks: rows.map(t => ({ ...t, title: t.title.trim() })) } }
}
