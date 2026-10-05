/**
 * Formulario de plantillas de Evaluaciones. Replica, para la UX, la validación
 * de `api/src/services/appraisalTemplateValidation.js`; el servidor sigue
 * siendo la autoridad y vuelve a validar todo.
 *
 * Límites del esquema (migración 034): nombres VARCHAR(120), descripciones
 * TEXT (65535 bytes), peso DECIMAL(5,2); escala entera 0–10, mínimo < máximo;
 * 1 a 50 criterios sin nombres duplicados (sin distinguir acentos, espacios ni
 * mayúsculas). Ningún criterio inválido se descarta en silencio.
 */
export const TEMPLATE_NAME_MAX = 120
export const CRITERION_NAME_MAX = 120
export const TEXT_MAX_BYTES = 65535
export const SCALE_LOWER = 0
export const SCALE_UPPER = 10
export const CRITERIA_MAX = 50
export const WEIGHT_MIN = 0.01
export const WEIGHT_MAX = 999.99

export interface TemplateFormInput {
  name: string
  description: string
  scale_min: number
  scale_max: number
}
export interface CriterionFormInput { name: string; description: string; weight: number }
export interface TemplatePayload {
  name: string
  description?: string
  scale_min: number
  scale_max: number
  criteria: { name: string; description?: string; weight: number }[]
}

// Ambas ramas declaran `payload` y `error`: el proyecto no usa strictNullChecks,
// así que `!r.ok` no estrecha la unión por sí solo.
type Result =
  | { ok: true; payload: TemplatePayload; error?: undefined }
  | { ok: false; error: string; payload?: undefined }

// Constructor: el target ES2017 no admite el literal /\p{M}/u (los navegadores sí).
const COMBINING_MARKS = new RegExp('\\p{M}', 'gu')
const codePoints = (s: string) => Array.from(s).length
const bytes = (s: string) => new TextEncoder().encode(s).length

export function normalizeCriterionName(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Parsea el valor crudo de un input de escala SIN truncar ni reinterpretar: sólo
 * un entero canónico (`-?\d+`) devuelve su número; cualquier otra cosa (fracción
 * "1.5", notación exponencial "1e1", texto o vacío) devuelve NaN para que la
 * validación lo rechace. Evita el `parseInt("1.5")→1` / `parseInt("1e1")→1`.
 */
export function parseScaleInput(raw: string): number {
  return /^[+-]?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN
}

export function validateTemplateForm(form: TemplateFormInput, criteria: CriterionFormInput[]): Result {
  const name = form.name.trim()
  if (!name) return { ok: false, error: 'El nombre de la plantilla es requerido' }
  if (codePoints(name) > TEMPLATE_NAME_MAX) return { ok: false, error: `El nombre admite hasta ${TEMPLATE_NAME_MAX} caracteres` }
  if (bytes(form.description) > TEXT_MAX_BYTES) return { ok: false, error: 'La descripción es demasiado larga' }
  const { scale_min: min, scale_max: max } = form
  const inRange = (v: number) => Number.isInteger(v) && v >= SCALE_LOWER && v <= SCALE_UPPER
  if (!inRange(min) || !inRange(max)) {
    return { ok: false, error: `La escala debe usar enteros entre ${SCALE_LOWER} y ${SCALE_UPPER}` }
  }
  if (min >= max) return { ok: false, error: 'La escala mínima debe ser menor que la máxima' }
  if (!criteria.length) return { ok: false, error: 'Al menos un criterio es requerido' }
  if (criteria.length > CRITERIA_MAX) return { ok: false, error: `Máximo ${CRITERIA_MAX} criterios` }
  const seen = new Set<string>()
  const out: TemplatePayload['criteria'] = []
  for (let i = 0; i < criteria.length; i += 1) {
    const c = criteria[i]
    const n = i + 1
    const cname = c.name.trim()
    if (!cname) return { ok: false, error: `Criterio ${n}: el nombre es requerido` }
    if (codePoints(cname) > CRITERION_NAME_MAX) return { ok: false, error: `Criterio ${n}: el nombre admite hasta ${CRITERION_NAME_MAX} caracteres` }
    if (bytes(c.description) > TEXT_MAX_BYTES) return { ok: false, error: `Criterio ${n}: la descripción es demasiado larga` }
    const w = c.weight
    if (typeof w !== 'number' || !Number.isFinite(w) || w < WEIGHT_MIN || w > WEIGHT_MAX || Number(w.toFixed(2)) !== w) {
      return { ok: false, error: `Criterio ${n}: el peso debe ser un número entre ${WEIGHT_MIN} y ${WEIGHT_MAX} con hasta 2 decimales` }
    }
    const key = normalizeCriterionName(cname)
    if (seen.has(key)) return { ok: false, error: `Criterio ${n}: nombre duplicado` }
    seen.add(key)
    out.push({ name: cname, ...(c.description ? { description: c.description } : {}), weight: w })
  }
  return {
    ok: true,
    payload: { name, ...(form.description ? { description: form.description } : {}), scale_min: min, scale_max: max, criteria: out },
  }
}

/** Mensaje para el usuario según la respuesta del servidor (400/403/404/409). */
export function templateErrorMessage(err: unknown, fallback = 'Error al guardar'): string {
  const res = (err as { response?: { status?: number; data?: { error?: unknown } } })?.response
  const serverMsg = typeof res?.data?.error === 'string' ? res.data.error : null
  switch (res?.status) {
    case 400: return serverMsg || 'Datos inválidos'
    case 403: return 'No tienes permisos para esta acción sobre plantillas'
    case 404: return 'La plantilla ya no existe'
    case 409: return serverMsg || 'La plantilla cambió mientras se editaba; recarga e intenta de nuevo'
    default: return fallback
  }
}
