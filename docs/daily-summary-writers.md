# Inventario de escritores de `daily_summary` — cierre de FASE A/B

Objetivo: **todo write futuro de `daily_summary` tiene un camino hacia el motor**
(`WorkdayEngine → dailySummaryEngine`). No debe quedar ningún job/worker oculto
recalculando con la matemática antigua cuando el motor está habilitado.

El interruptor es el feature flag `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED`
(default **OFF**). Con OFF, los caminos operativos conservan su comportamiento
legacy como rollback; con ON, todos recalculan por el motor.

## Clasificación

| Escritor | Archivo | Clase | Camino al motor |
|---|---|---|---|
| `recalcDailySummary` (por marca, operativo) | `controllers/attendanceController.js` | **DISPATCHER** | flag ON → `workdaySummaryService.resolveSummary(apply:true)`; flag OFF → `legacyRecalcDailySummary` |
| `legacyRecalcDailySummary` | `controllers/attendanceController.js` | **LEGACY (rollback)** | — cálculo propio aislado; no se le agrega matemática nueva |
| `bulkRecalcDailySummary` (bloque por fecha) | `services/scheduler.js` | **DISPATCHER** | flag ON → `bulkRecalcViaEngine` (loop de empleados × `resolveSummary`); flag OFF → `legacyBulkRecalcDailySummary` |
| `legacyBulkRecalcDailySummary` | `services/scheduler.js` | **LEGACY (rollback)** | — SQL MIN(in)/MAX(out) por día civil + `employees.schedule_id` actual |
| `bulkRecalcViaEngine` | `services/scheduler.js` | **NUEVO (motor)** | usa `resolveSummary` por empleado |
| `resolveSummary` | `services/workdaySummaryService.js` | **NUEVO (motor)** | ES el writer del motor |
| `materializeAbsents` | `services/scheduler.js` | **LEGACY / auxiliar** | inserta filas `absent` para quien, según `schedules.work_days` (vivo), debía trabajar y no tiene fila. No pisa filas existentes. Pendiente FASE C: derivar el "debía trabajar" del snapshot histórico (`expected_workday`) en vez del horario vivo. |
| justificación (`INSERT … justification, justification_type, status`) | `routes/justificationsBulk.js`, `routes/reports.js` | **NO ES MATEMÁTICA DE JORNADA** | Escriben la *justificación* de una ausencia/tardanza (dato operativo de RR.HH.), no `first_in/last_out/worked/late`. Fuera del alcance del motor. |

## Notas

- El **camino operativo por marca** (bridge/device, manual, móvil) pasa por
  `recalcDailySummary`, que delega al motor con el flag ON. Con OFF conserva el
  legacy. Es el camino central que cierra FASE B.
- El **recálculo en bloque** (`bulkRecalcDailySummary`, usado por crons/workers)
  también quedó gateado: con el flag ON corre `bulkRecalcViaEngine`, así que no
  hay una segunda matemática viva.
- `materializeAbsents` sigue usando `schedules.work_days` vivo para decidir
  "debía trabajar". Mientras el flag esté OFF esto es consistente con el resto
  del legacy; la evolución (usar `expected_workday` del motor sobre el snapshot
  histórico) es trabajo de FASE C y está anotada como contrato.
- Los escritores de **justificación** no tocan la matemática de jornada; se
  listan para que el inventario sea completo.
- **Estados `non_working` / `unconfigured` (migración 074):** el ENUM clásico no
  los admite. `statusParaDb` los colapsa a `weekend` / (null → reconciliación por
  DELETE) por defecto. Cuando la migración 074 esté aplicada, el flag
  `WORKDAY_ENGINE_STATUS_074_ENABLED=true` hace que se persistan con su valor
  real (un martes libre por config queda `non_working`, no `weekend`). Es un flag
  de ESQUEMA independiente del de escritura: 074 puede aplicarse antes o después.
- **Preservación de estados al recalcular:** sólo se conserva un permiso MANUAL
  (`status='permission'` con `justification`/`justification_type` cargados y de
  tipo distinto de `injustificada`). Los estados automáticos (holiday/weekend,
  permisos de turnera) los recalcula el motor desde los datos vigentes; una
  ausencia `injustificada` es una ausencia, no un permiso.

## Semántica de `worked_minutes` durante la migración (item 11)

`daily_summary.worked_minutes` viene guardando **PERMANENCIA** (primera entrada a
última salida, con el almuerzo adentro). El motor la llama `presence_minutes`.

Durante la migración se **conserva** esa semántica: el writer del motor escribe
`worked_minutes = presence_minutes` (el modo por defecto del materializador es
`presence`). No se cambia en silencio a tiempo neto (`segment_minutes` menos
descanso): eso movería todos los números históricos de RR.HH. y es una decisión
de negocio explícita, no un detalle de implementación.

El motor expone los tres conceptos por separado —`presence_minutes`,
`segment_minutes`, `worked_minutes` (neto)— para que cada consumidor elija el que
su cálculo necesita sin recalcular a su manera. Qué columna alimenta cada
reporte:

| Consumidor | Concepto |
|---|---|
| Reporte **Marcadas** ("Total Permanencia") | `segment_minutes` (suma de tramos, excluye la pausa entre pares) |
| `daily_summary.worked_minutes` | `presence_minutes` (permanencia; semántica histórica) |
| Mensual / semanal / banco de horas | hoy derivan de `daily_summary.worked_minutes` (permanencia). Su paso a neto es una decisión de negocio futura. |

## `notes`: evidencia de fichajes sueltos

`daily_summary` no tiene columna de anomalías, así que un fichaje suelto que
ningún bound cubre —una entrada abierta a las 18:00 tras cerrar a las 17:00—
desaparecería del resumen. Correr `last_out` a esa entrada fingiría un cierre y
falsearía la hora de salida. En cambio, el motor conserva su evidencia en
`daily_summary.notes` (p. ej. `fichajes sin par: entrada 18:00`). Ningún flujo
humano escribe esa columna en este camino, así que el writer la **reemplaza** en
cada recalc (NULL cuando ya no hay fichaje suelto) para no dejar una nota
obsoleta. `worked_minutes`/`presence_minutes` siguen saliendo del motor, no del
span; `notes` es sólo trazabilidad.
