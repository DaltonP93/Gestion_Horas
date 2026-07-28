/**
 * syncWizardState — lógica PURA del asistente de sincronización (sin React).
 *
 * Separa el cálculo de "qué guardar" y "qué cambió" para poder probarlo en Node
 * (jest) sin montar el componente. El SyncWizard consume estas funciones.
 *
 * Contexto del bug que corrige: cuando la programación general ya estaba activa,
 * el Paso 3 sólo ofrecía "Desactivar" y nunca ejecutaba el guardado por reloj,
 * así que agregar un reloj (p.ej. Comedor) NO se persistía. Aquí vive la
 * detección de cambios pendientes y la construcción del payload por reloj.
 */

export interface DeviceLike {
  id: number
  name?: string
  connection_mode?: string
  auto_sync_enabled: number
  auto_sync_paused: number
  auto_sync_interval_min: number
  auto_sync_offset_min: number
  auto_sync_attempts: number
  auto_sync_cooldown_sec: number
  auto_sync_timeout_sec: number
}

export type Draft = {
  interval?: number; offset?: number; mode?: string
  attempts?: number; cooldown?: number; timeout?: number; paused?: boolean
}

export interface AutoSyncPayload {
  enabled: boolean
  paused: boolean
  interval_min: number
  offset_min: number
  attempts: number
  cooldown_sec: number
  timeout_sec: number
  connection_mode: string
}

/** Ids de relojes habilitados según el backend (fuente de verdad de `selected`). */
export function enabledIds(devices: DeviceLike[] = []): Set<number> {
  return new Set(devices.filter(d => !!d.auto_sync_enabled).map(d => d.id))
}

const dnum = (draft: Draft | undefined, k: keyof Draft, fallback: number) =>
  Number(draft?.[k] ?? fallback)

/** Cuerpo del PUT /api/devices/:id/auto-sync para un reloj (incluye enabled). */
export function devicePayload(d: DeviceLike, selected: Set<number>, draft: Record<number, Draft>): AutoSyncPayload {
  const dr = draft[d.id]
  return {
    enabled: selected.has(d.id),
    paused: (dr?.paused ?? !!d.auto_sync_paused) ? true : false,
    interval_min: dnum(dr, 'interval', d.auto_sync_interval_min),
    offset_min:   dnum(dr, 'offset',   d.auto_sync_offset_min),
    attempts:     dnum(dr, 'attempts', d.auto_sync_attempts),
    cooldown_sec: dnum(dr, 'cooldown', d.auto_sync_cooldown_sec),
    timeout_sec:  dnum(dr, 'timeout',  d.auto_sync_timeout_sec),
    connection_mode: String(dr?.mode ?? d.connection_mode ?? 'auto'),
  }
}

/**
 * ¿Cambió algo de este reloj respecto del backend? Compara inclusión, pausa,
 * intervalo, offset, modo, intentos, cooldown y timeout. Los relojes que ni
 * están seleccionados ni estaban habilitados (y sólo se les tocó lo avanzado)
 * NO se consideran pendientes.
 */
export function deviceDirty(d: DeviceLike, selected: Set<number>, draft: Record<number, Draft>): boolean {
  const inc = selected.has(d.id)
  const wasInc = !!d.auto_sync_enabled
  if (inc !== wasInc) return true
  if (!inc && !wasInc) return false

  const p = devicePayload(d, selected, draft)
  return (
    p.paused !== !!d.auto_sync_paused ||
    p.interval_min !== Number(d.auto_sync_interval_min) ||
    p.offset_min !== Number(d.auto_sync_offset_min) ||
    p.attempts !== Number(d.auto_sync_attempts) ||
    p.cooldown_sec !== Number(d.auto_sync_cooldown_sec) ||
    p.timeout_sec !== Number(d.auto_sync_timeout_sec) ||
    p.connection_mode !== String(d.connection_mode ?? 'auto')
  )
}

/** ¿Cambió la ventana operativa global respecto del backend? */
export function windowDirty(win: string, backendWin?: string): boolean {
  return String(win ?? '').trim() !== String(backendWin ?? '').trim()
}

/** ¿Hay cambios pendientes de guardar (algún reloj o la ventana)? */
export function hasPendingChanges(
  devices: DeviceLike[],
  selected: Set<number>,
  draft: Record<number, Draft>,
  win: string,
  backendWin?: string,
): boolean {
  return devices.some(d => deviceDirty(d, selected, draft)) || windowDirty(win, backendWin)
}

/** Estado de un reloj en el resumen del Paso 3 (guardado vs pendiente). */
export type ReviewState =
  | 'saved'            // incluido y sin cambios: ya está guardado y activo
  | 'pending_add'      // seleccionado pero aún NO habilitado en backend
  | 'pending_update'   // ya habilitado, con parámetros modificados sin guardar
  | 'pending_remove'   // habilitado en backend pero desmarcado (se quitará al guardar)

export function reviewState(d: DeviceLike, selected: Set<number>, draft: Record<number, Draft>): ReviewState {
  const inc = selected.has(d.id)
  const wasInc = !!d.auto_sync_enabled
  if (inc && !wasInc) return 'pending_add'
  if (!inc && wasInc) return 'pending_remove'
  if (inc && wasInc) return deviceDirty(d, selected, draft) ? 'pending_update' : 'saved'
  return 'saved' // ni incluido ni estaba: no aparece en el resumen
}
