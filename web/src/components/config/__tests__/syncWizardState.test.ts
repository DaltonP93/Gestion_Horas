import {
  enabledIds, devicePayload, deviceDirty, windowDirty, hasPendingChanges, reviewState,
  type DeviceLike, type Draft,
} from '../syncWizardState'

// Relojes de referencia (config = evidencia de producción).
const gerencia = (over: Partial<DeviceLike> = {}): DeviceLike => ({
  id: 3, name: 'Gerencia', connection_mode: 'auto',
  auto_sync_enabled: 1, auto_sync_paused: 0,
  auto_sync_interval_min: 15, auto_sync_offset_min: 0,
  auto_sync_attempts: 3, auto_sync_cooldown_sec: 4, auto_sync_timeout_sec: 600, ...over,
})
const comedor = (over: Partial<DeviceLike> = {}): DeviceLike => ({
  id: 1, name: 'Comedor', connection_mode: 'auto',
  auto_sync_enabled: 0, auto_sync_paused: 0,
  auto_sync_interval_min: 30, auto_sync_offset_min: 5,
  auto_sync_attempts: 5, auto_sync_cooldown_sec: 6, auto_sync_timeout_sec: 900, ...over,
})
const lavadero = (over: Partial<DeviceLike> = {}): DeviceLike => ({
  id: 2, name: 'Lavadero', connection_mode: 'tcp',
  auto_sync_enabled: 0, auto_sync_paused: 0,
  auto_sync_interval_min: 60, auto_sync_offset_min: 10,
  auto_sync_attempts: 5, auto_sync_cooldown_sec: 4, auto_sync_timeout_sec: 600, ...over,
})
const noDraft: Record<number, Draft> = {}

describe('enabledIds (reload deriva selección del backend)', () => {
  test('sólo incluye los auto_sync_enabled', () => {
    const ids = enabledIds([gerencia(), comedor(), lavadero()])
    expect([...ids]).toEqual([3])
  })
  test('tras guardar Comedor, el backend lo devuelve enabled → queda seleccionado', () => {
    const ids = enabledIds([gerencia(), comedor({ auto_sync_enabled: 1 }), lavadero()])
    expect(ids.has(1)).toBe(true)
    expect(ids.has(3)).toBe(true)
    expect(ids.has(2)).toBe(false)
    expect(ids.size).toBe(2) // Paso 1: 2 de 3 incluidos
  })
})

describe('devicePayload (cuerpo del PUT)', () => {
  test('reloj seleccionado → enabled=true con sus parámetros', () => {
    const sel = new Set([1, 3])
    const p = devicePayload(comedor(), sel, noDraft)
    expect(p).toEqual({
      enabled: true, paused: false, interval_min: 30, offset_min: 5,
      attempts: 5, cooldown_sec: 6, timeout_sec: 900, connection_mode: 'auto',
    })
  })
  test('reloj no seleccionado → enabled=false (exclusión)', () => {
    expect(devicePayload(lavadero(), new Set([1, 3]), noDraft).enabled).toBe(false)
  })
  test('Gerencia sigue enabled=true al guardar (no se detiene)', () => {
    expect(devicePayload(gerencia(), new Set([1, 3]), noDraft).enabled).toBe(true)
  })
  test('el draft avanzado pisa los valores del backend', () => {
    const p = devicePayload(comedor(), new Set([1]), { 1: { interval: 45, mode: 'tcp' } })
    expect(p.interval_min).toBe(45)
    expect(p.connection_mode).toBe('tcp')
  })
})

describe('deviceDirty / hasPendingChanges', () => {
  test('master activo + AGREGAR Comedor → hay cambios pendientes', () => {
    const devices = [gerencia(), comedor(), lavadero()]
    const sel = new Set([1, 3]) // se agrega Comedor
    expect(deviceDirty(comedor(), sel, noDraft)).toBe(true)
    expect(hasPendingChanges(devices, sel, noDraft, '04:00-23:59', '04:00-23:59')).toBe(true)
  })
  test('master activo + EXCLUIR un reloj → pendiente', () => {
    const devices = [gerencia(), comedor({ auto_sync_enabled: 1 })]
    const sel = new Set([3]) // se saca Comedor (estaba enabled)
    expect(deviceDirty(comedor({ auto_sync_enabled: 1 }), sel, noDraft)).toBe(true)
    expect(hasPendingChanges(devices, sel, noDraft, 'x', 'x')).toBe(true)
  })
  test('master activo + modificar CONFIG AVANZADA → pendiente', () => {
    const sel = new Set([3])
    expect(deviceDirty(gerencia(), sel, { 3: { interval: 20 } })).toBe(true)
  })
  test('sin cambios → NO pendiente (botón Guardar deshabilitado / "actualizado")', () => {
    const devices = [gerencia(), comedor(), lavadero()]
    const sel = enabledIds(devices) // = {3}, idéntico al backend
    expect(hasPendingChanges(devices, sel, noDraft, '04:00-23:59', '04:00-23:59')).toBe(false)
  })
  test('editar avanzado de un reloj NO involucrado no cuenta como pendiente', () => {
    // Lavadero ni seleccionado ni habilitado; tocar su intervalo no ensucia.
    expect(deviceDirty(lavadero(), new Set([3]), { 2: { interval: 99 } })).toBe(false)
  })
  test('cambiar la ventana operativa → pendiente', () => {
    expect(windowDirty('05:00-22:00', '04:00-23:59')).toBe(true)
    expect(hasPendingChanges([gerencia()], new Set([3]), noDraft, '05:00-22:00', '04:00-23:59')).toBe(true)
  })
  test('misma ventana (con espacios) → no pendiente', () => {
    expect(windowDirty(' 04:00-23:59 ', '04:00-23:59')).toBe(false)
  })
})

describe('reviewState (resumen guardado vs pendiente)', () => {
  test('Comedor recién agregado → pending_add (no mostrar "próxima" como activa)', () => {
    expect(reviewState(comedor(), new Set([1, 3]), noDraft)).toBe('pending_add')
  })
  test('Gerencia ya activa y sin cambios → saved', () => {
    expect(reviewState(gerencia(), new Set([3]), noDraft)).toBe('saved')
  })
  test('Gerencia con parámetros modificados → pending_update', () => {
    expect(reviewState(gerencia(), new Set([3]), { 3: { interval: 10 } })).toBe('pending_update')
  })
  test('reloj habilitado que se desmarca → pending_remove', () => {
    expect(reviewState(comedor({ auto_sync_enabled: 1 }), new Set([3]), noDraft)).toBe('pending_remove')
  })
})
