# Modelo de configuración laboral — FASE C

## Objetivo

La configuración laboral responde, para cada `employee_id + work_date`, **qué
condiciones eran válidas ese día**. No usa `employees.schedule_id` para
recalcular el pasado y no modifica `attendance_logs`.

## Auditoría del modelo existente

| Concepto | Modelo existente | Estado | Decisión FASE C |
|---|---|---|---|
| Catálogo de horarios | `schedules` | Suficiente como catálogo actual, pero mutable | Se usa sólo al CREAR un snapshot; nunca como fallback histórico |
| Días laborales | `schedules.work_days` (DAYOFWEEK 1=Dom..7=Sáb) | Suficiente como fuente de snapshot | Se copia a `employee_schedule_history.work_days` |
| Descanso base | `schedules.break_minutes` | Parcial | El snapshot congela además `break_mode` y `break_after_minutes` |
| Vigencia histórica | `employee_schedule_history` (072/073) | Base correcta | Se completa con writer/API y metadata 075 |
| Perfil de cálculo | columnas de 073 en `employee_schedule_history` | Correcto | Se mantiene junto al horario porque comparte la misma vigencia |
| Contrato administrativo | `employee_contracts` | Correcto | Sigue separado: tipo, salario, prueba, alta/baja; no define por sí solo horario/carga |
| Turnera | `shift_schedules` + `shift_assignments` | Correcto | La asignación publicada del día gana sobre el horario habitual |
| Turno partido | `shift_assignments.segment` | Correcto | Se respetan los segmentos publicados |
| Vacaciones/permisos | `permissions` + módulo `vacations` | Existente | El effective-config los expone como excepción de calendario |
| Feriados | `holidays` | Existente | El effective-config los expone sin convertir falta de config en ausencia |
| Estado derivado | `daily_summary` + migración 074 | Preparado | No se activa ni recalcula en FASE C |
| Motor | `WorkdayEngine` + `dailySummaryEngine` | FASE A/B cerrada | FASE C sólo le suministra configuración efectiva |

## Decisión de arquitectura

No se crea una segunda tabla `employee_work_profile_history`. Horario y perfil
laboral comparten exactamente la misma vigencia y se resuelven juntos en
`employee_schedule_history`.

`employee_contracts` conserva su función administrativa. Esto evita que una
edición de salario/estado contractual cambie silenciosamente el cálculo de
jornada.

## Snapshot histórico

Una vigencia guarda una copia completa de los valores que afectan cálculo:

- `schedule_id` sólo para trazabilidad;
- `schedule_name_snapshot`;
- `check_in`, `check_out`;
- `tolerance_in`, `tolerance_out`;
- `work_days`;
- `break_mode`, `break_minutes`, `break_after_minutes`;
- `weekly_target_minutes`, `daily_target_minutes`;
- `work_regime`;
- `night_start`, `night_end`;
- `rounding_policy` + versión/config;
- `overtime_policy` + versión/config;
- metadata de revisión y motivo.

Editar posteriormente `schedules` **no cambia el snapshot**. El reader de
FASE C ya no hace `COALESCE(history.work_days, schedules.work_days)`.

Si falta `check_in`, `check_out` o `work_days`, el tramo es
`config_incomplete` y se degrada a `historical_fallback`.

## Vigencias

Semántica elegida, consistente con el código existente:

- `valid_from`: inclusivo.
- `valid_to`: inclusivo.
- `valid_to = NULL`: vigente sin fecha de cierre.

Los solapamientos se bloquean en dos capas:

1. named lock `sishoras:workcfg:<employee_id>` + transacción en el servicio;
2. triggers de la migración 073 como segunda línea de defensa.

No se backfillea el horario actual hacia el pasado.

## Precedencia

1. `shift_assignments` de una Turnera **published** para la fecha.
2. `employee_schedule_history` vigente y completo.
3. `employee_contracts` sólo aporta identidad/trazabilidad contractual.
4. Sin configuración confiable: `historical_fallback`.

Una Turnera conflictiva (más de una publicada para el mismo empleado/día) se
expone como conflicto; el horario elegido sólo sirve para trazabilidad y no
debe tratarse como verdad laboral para atrasos.

## Perfil laboral

`weekly_target_minutes` es configurable y acepta cualquier entero válido, no
sólo 48/45/42/36/32/24/20 horas.

`work_regime` es una clasificación explícita:

- `day`
- `night`
- `mixed`
- `special`
- `custom`

No se infiere régimen por cantidad de horas.

`contract_excess_minutes` y horas extra legales siguen siendo conceptos
distintos. Una policy de overtime ausente significa **no calculado**, no cero
legal.

## Descansos

- `none`: sin descuento.
- `punched`: el descanso ya se refleja en los pares OUT/IN.
- `fixed_unpaid`: descuento fijo, acreditando el gap ya fichado para no
  descontar dos veces.

FASE C almacena/resuelve la configuración; no cambia la matemática ya
endurecida en FASE A/B.

## Políticas

Las policies se guardan por nombre, versión y JSON de configuración dentro del
snapshot. No se activan globalmente por existir.

Una policy sólo puede modificar cálculos cuando WorkdayEngine tenga una
implementación explícita y testeada para ese código/versión.

## Excepciones de calendario

El endpoint effective-config informa:

- Turnera `off` / `vacation` / `permiso`;
- permisos/vacaciones aprobados de `permissions`;
- feriados activos.

`expected_workday` puede ser:

- `true`: se sabe que debía trabajar;
- `false`: se sabe que no debía trabajar;
- `null`: no existe configuración suficiente.

`null` nunca se convierte automáticamente en `absent`.

## API

Base: `/api/workday-config`.

- `GET /meta`
- `GET /employees/:employeeId/history`
- `POST /employees/:employeeId/history`
- `PUT|PATCH /history/:id`
- `POST /history/:id/close`
- `GET /employees/:employeeId/effective?date=YYYY-MM-DD`

Los endpoints `/profiles` son aliases del mismo snapshot; no existe un
segundo historial de perfil que pueda desalinearse.

RBAC reutiliza `configuracion` y los roles existentes
`super_admin/admin/gth/hr`.

## Auditoría

Crear/editar/cerrar genera eventos con:

- usuario;
- empleado;
- snapshot/id;
- before/after de vigencia y referencia;
- motivo;
- versión del snapshot.

No se guardan secretos.

## Migraciones

072, 073 y 074 ya están en `main`, por lo que FASE C las trata como
inmutables aunque aún no se hayan ejecutado en producción.

075 es aditiva y agrega sólo metadata/versionado de snapshot y policies. No se
ejecuta durante el desarrollo del PR.

## Compatibilidad

Mientras no existan filas nuevas en `employee_schedule_history`, los reportes
siguen en `historical_fallback`.

FASE C no:

- activa flags;
- recalcula `daily_summary`;
- modifica `attendance_logs`;
- escribe ATT2000;
- despliega migraciones.

## Rollout posterior

El rollout real pertenece a FASE E:

1. backup;
2. validar estado de migraciones;
3. aplicar 072→073→074→075 en ambiente controlado;
4. mantener flags OFF;
5. cargar una muestra de configuración con vigencia explícita;
6. ejecutar auditor/dry-run;
7. comparar Marcadas + daily_summary;
8. habilitar writers sólo con GO explícito;
9. rollback documentado.
