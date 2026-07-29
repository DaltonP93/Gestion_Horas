/**
 * att2000Requests — cuerpos de las peticiones al backend legado att2000.
 *
 * El navegador SÓLO envía parámetros funcionales NO sensibles (rango de fechas).
 * NUNCA envía credenciales (usuario/contraseña), secretos, host, ni connection
 * strings: la conexión vive exclusivamente en el backend (variables de entorno).
 */
export interface DateRange { dateFrom: string; dateTo: string }

/** Test de conexión: sin cuerpo (usa el .env del servidor). */
export function testConnBody(): Record<string, never> {
  return {}
}

/** Sincronización histórica: sólo el rango de fechas. */
export function fullSyncBody(r: DateRange): DateRange {
  return { dateFrom: r.dateFrom, dateTo: r.dateTo }
}

/** Envío de marcajes locales → att2000: sólo el rango de fechas. */
export function pushBody(r: DateRange): DateRange {
  return { dateFrom: r.dateFrom, dateTo: r.dateTo }
}

/** Claves NO permitidas en ningún cuerpo público (credenciales/destino). */
export const FORBIDDEN_BODY_KEY = /pass|user|secret|pwd|credential|conn|host|server/i

/** Verifica que un cuerpo no contenga credenciales ni destino de conexión. */
export function bodyHasNoCredentials(body: unknown): boolean {
  const json = JSON.stringify(body ?? {})
  return !FORBIDDEN_BODY_KEY.test(json)
}
