/**
 * att2000Target — persistencia SEGURA del destino de conexión att2000.
 *
 * NUNCA se guardan credenciales (usuario/contraseña) en localStorage: sólo el
 * destino no sensible (host/puerto/base/etiqueta). Las credenciales viven en el
 * backend (variables de entorno) y se ingresan al vuelo cuando hace falta.
 */
export const TARGET_KEY = 'sishoras_att2000_target'
/** Clave HEREDADA (versiones viejas) que podía contener usuario/contraseña. */
export const LEGACY_CONN_KEY = 'sishoras_db_conn'
/** Marcador para ejecutar la purga heredada UNA sola vez. */
export const PURGE_FLAG = 'sishoras_db_conn_purged'

interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

/**
 * Elimina, UNA sola vez, cualquier credencial guardada por versiones anteriores.
 * Borra la clave heredada `sishoras_db_conn` (podía contener usuario/contraseña)
 * y el destino `sishoras_att2000_target` (ya no se configura en el navegador).
 * Deja un marcador para no repetir la purga. Devuelve true si purgó en esta llamada.
 */
export function purgeLegacyConnCreds(storage?: StorageLike): boolean {
  const s = storage ?? (typeof window !== 'undefined' ? (window.localStorage as StorageLike) : undefined)
  if (!s) return false
  try {
    if (s.getItem(PURGE_FLAG)) return false
    s.removeItem(LEGACY_CONN_KEY)
    s.removeItem(TARGET_KEY)
    s.setItem(PURGE_FLAG, new Date().toISOString())
    return true
  } catch {
    return false
  }
}

export interface Att2000Conn {
  host: string; port: string; database: string; user: string; password: string; label: string
}
export interface Att2000Target {
  host: string; port: string; database: string; label: string
}

/** Extrae SÓLO los campos no sensibles (descarta user/password). */
export function sanitizeTarget(conn: Partial<Att2000Conn>): Att2000Target {
  return {
    host: conn.host ?? '',
    port: conn.port ?? '1433',
    database: conn.database ?? 'att2000',
    label: conn.label ?? '',
  }
}

/** Normaliza lo leído del storage a un destino (ignora cualquier credencial guardada por versiones viejas). */
export function parseTarget(raw: unknown): Att2000Target {
  const t = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    host: typeof t.host === 'string' ? t.host : '',
    port: typeof t.port === 'string' ? t.port : '1433',
    database: typeof t.database === 'string' ? t.database : 'att2000',
    label: typeof t.label === 'string' ? t.label : '',
  }
}
