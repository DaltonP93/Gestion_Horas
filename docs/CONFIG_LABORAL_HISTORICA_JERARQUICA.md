# Configuración Laboral Histórica, Jerárquica y Masiva

> **Estado:** `OPEN_PR` (no en `main`). Aditivo, fail-closed, sin recálculo de
> histórico. Migración `085` en el repo, **NO aplicada en prod**. Los writers
> viven detrás de `WORKDAY_CONFIG_WRITE_ENABLED` (el mismo flag que FASE C),
> por lo que crear/actualizar defaults responde `503` mientras esté en `false`.

Esta fase agrega los dos niveles de configuración de jornada que faltaban en la
precedencia (empresa y departamento, además del general de organización) con
**vigencia histórica versionada**, un **resolutor efectivo por empleado+fecha**
que aplica toda la precedencia, y **operaciones masivas con preview/dry-run**.
Reutiliza el `WorkdayEngine`, `workdayConfig.forDate`, los validadores de
`workdayConfigurationService` y las tablas existentes (`employee_schedule_history`,
`employee_assignments`, `cost_centers`, `employee_contracts`).

## 1. Auditoría del esquema/lógica actual (antes de codificar)

| Pieza existente | Qué aporta | Límite encontrado (gap) |
|---|---|---|
| `workdayConfig.js` (`forDate`, `loadWorkdayConfig`) | Resuelve **capa 1** (turnera publicada) y **capa 2** (`employee_schedule_history`) por fecha civil, cross-midnight correcto. | No conoce defaults por depto/empresa/general: si no hay turnera ni ESH, cae directo a `historical_fallback`. |
| `employee_schedule_history` (072/073/075) | Override **por empleado**, versionado (`valid_from`/`valid_to`), snapshot inmutable. | Sólo nivel empleado; no hay equivalente de alcance. |
| `shift_assignments` / `shift_schedules` | Turnera publicada por día (capa 1). | — (se reutiliza vía `forDate`). |
| `employee_assignments` (078) | Departamento/centro de costo **con vigencia** (as-of-date). | No se usaba para elegir un default de jornada por depto/empresa. |
| `employee_contracts` | Identidad/vigencia del vínculo. | **No trae horas/horario**: no puede fabricar jornada; sólo traza `contract_id`. |
| API `workdayConfiguration` (`/api/workday-config`) | CRUD de ESH + `/effective` (capas 1–2). | No exponía precedencia completa ni defaults ni masivo. |
| UI `/empleados/[id]/configuracion-laboral` | Edición por empleado. | No hay superficie de administración por alcance ni masiva. |
| `workdayEngine.js` | Motor puro (wall-clock, TZ-independiente). | — (se respeta; no se toca). |

**Precedencia previa (incompleta):** `published_shift_assignment` →
`employee_schedule_history` → `employee_contract_trace` → `historical_fallback`.

## 2. Precedencia nueva (explícita y auditable) — UN SOLO resolvedor

**Única fuente de verdad: `workdayConfig.loadWorkdayConfig().resolveForDate()`**
(constante `PRECEDENCE` en `api/src/services/workdayConfig.js`). El motor
(`workdaySummaryService`, `scheduler`) consume `forDate()`, que es exactamente
`resolveForDate().config`; el endpoint administrativo consume `resolveForDate()`
vía `workdayConfigDefaultsService.getEffectiveForDate` (envoltura). **No existe un
segundo algoritmo de precedencia** (el `workdayEffectiveConfig.js` paralelo se
eliminó). Orden de mayor a menor prioridad:

1. `published_shift_assignment` — turnera publicada (por día).
2. `employee_historical_override` — `employee_schedule_history` (snapshot vigente).
3. `department_historical_default` — `workday_config_defaults` scope=department **(NUEVO)**.
4. `company_historical_default` — scope=company **(NUEVO)**.
5. `general_historical_default` — scope=general **(NUEVO)**.
6. `employee_contract_trace` — identidad de contrato (aporta `contract_id`, **no** habilita `configured`).
7. `historical_fallback` — sin evidencia → el motor resuelve sin config (`forDate` = `null`).

Reglas: una capa sólo habilita `configured` si su config es **completa**
(`check_in` + `check_out` + `work_days`); si no, se **salta** a la siguiente
(nunca se inventa una jornada). La turnera aporta el HORARIO del día y el "perfil"
(target/policies) sale del snapshot del empleado o, si no existe, del default
jerárquico vigente. El departamento/empresa del empleado se resuelven
**as-of-date** SÓLO desde `employee_assignments` (078): departamento de
`a.department_id` y empresa del **snapshot histórico `a.company_id`** (086),
congelado al crear la asignación (Corrección H). El motor **no** lee
`branches`/`cost_centers` para reconstruir el pasado, ni `employees.department_id`
actual (Corrección B: eso fabricaría historia). **Sin asignación vigente no hay
alcance autoritativo** → general/fallback. Una asignación con `company_id` NULL
(empresa histórica desconocida) NO habilita el company default. La derivación de
empresa (branch/cost_center/departamento, con `INCOHERENT_SCOPE` si difieren)
ocurre una sola vez, al **escribir** la asignación (`people.createAssignment`).

**Degradación deliberada:** si faltan 078/076/085 (tablas o columnas), los
loaders degradan a "sin dato" y el resultado es IDÉNTICO al comportamiento previo
(sin defaults → `historical_fallback`). Sin `WORKDAY_CONFIG_WRITE_ENABLED` y sin
085 aplicada en prod, la jerarquía no altera ningún cálculo.

## 3. Datos (migraciones `085` y `086`)

`database/migrations/085_workday_config_defaults.sql` (aditiva, idempotente,
sin backfill):

- **`workday_config_defaults`** — default de jornada **versionado por alcance**:
  `scope ENUM('general','company','department')`, `company_id`/`department_id`
  nullables, `valid_from`/`valid_to` (inclusive, `NULL`=abierta), payload de
  jornada con paridad con ESH (`check_in`…`work_days`, políticas + versión/config,
  franja nocturna). Columna generada `scope_key = scope:company:department` con
  `UNIQUE(scope_key, valid_from)`; `CHECK ck_wcd_scope` fija la semántica de
  alcance en BD (general=sin ids, company=company_id, department=department_id).
  La NO-superposición de vigencias dentro del alcance se valida en el servicio.
  FKs a `companies`/`departments` `ON DELETE RESTRICT`.
- **`workday_config_default_audit`** — auditoría de defaults
  (`create|update_metadata|supersede_close|supersede_create|close`, actor,
  `before_json`/`after_json`, motivo).

`database/migrations/086_employee_assignments_company_snapshot.sql` (Corrección
H, aditiva/idempotente/sin backfill): agrega **`employee_assignments.company_id`**
(FK a `companies` `ON DELETE RESTRICT`) — el snapshot histórico de empresa que se
congela al crear la asignación. NULL = empresa histórica desconocida.

**Modelo elegido:** versionado **append-only e inmutable del pasado** — una
versión nueva es una fila nueva y su configuración efectiva no se reescribe
in-place (ver §4 supersede), como `labor_calendars` (079) y el snapshot de ESH.
Preserva el histórico sin explosión de snapshots por empleado y evita la deriva
retroactiva.

## 4. API (rutas nuevas, `/api/workday-config`)

- `GET /precedence` — precedencia canónica + `writes_enabled` (para UI/docs).
- `GET /employees/:id/effective-hierarchical?date=YYYY-MM-DD` — **resuelve la
  jornada efectiva** por el mismo resolvedor del motor (read-only).
- `GET /defaults?scope=&company_id=&department_id=` — listado (read-only).
- `POST /defaults` — crea una versión (lock por alcance, chequeo de solapes, auditoría).
- `PUT /defaults/:id` — **sólo metadata** (`label`/`change_reason`). Cambiar
  configuración efectiva o vigencia devuelve `409 IMMUTABLE_EFFECTIVE_CONFIG`.
- `POST /defaults/:id/supersede` — **append-only**: cierra la versión vigente en
  `effective_from - 1` y crea la sucesora desde `effective_from`, en UNA
  transacción atómica bajo el scope lock (rechaza `effective_from` no posterior
  con `409 SUPERSEDE_NOT_FORWARD`).
- `POST /defaults/:id/close` — cierre deliberado de vigencia (sin sucesora).
- `POST /defaults/bulk/preview` — **dry-run masivo, cero escrituras** (sin N+1).
- `POST /defaults/bulk/apply` — aplicación masiva **atómica** (una transacción,
  todo-o-nada, locks deterministas), sólo sin conflictos (`409 BULK_HAS_CONFLICTS`).

Todas las escrituras pasan por `assertWriteEnabled()` (fail-closed) **antes** de
tocar la BD y quedan auditadas. Locks de alcance: create/update/supersede/close
del mismo scope comparten `sishoras:wcd:<scope_key>` (el alcance es inmutable).

## 5. UI

- `/configuracion/laboral` — administración escalable: precedencia visible,
  resolutor efectivo por empleado+fecha, alta de default por alcance con
  vigencia y días, importación masiva con preview/dry-run (aplicar bloqueado si
  hay filas **invalid / incomplete / overlap**), listado filtrable y **banner de
  modo sólo lectura** cuando el flag está en `false`. Companies/departments se
  leen con sus formas reales (`trade_name||legal_name||code`; array directo).
  Registrada en `navModules` (roles admin/gth/hr) + i18n es/en/pt.

## 6. Tests

- `api/tests/workdayConfig.test.js` — resolvedor único, sin N+1, guard "no lee
  employees".
- `api/tests/workdayHierarchicalResolver.test.js` — integración por el motor:
  defaults depto/empresa/general; turnera/override ganan; **cambio de
  departamento** as-of-date; **B** (estado actual no fabrica historia); **H**
  (empresa del snapshot `a.company_id`, no branches/cost_centers actuales; NULL
  no aplica company default); **I** (versiones resueltas por fecha); **A/G**
  (`forDate` === `resolveForDate().config`; endpoint === motor).
- `api/tests/workdayConfigDefaultsService.test.js` — alcance (rechazo de
  company_id en department), write-gate fail-closed, negativos de validación,
  policy version/config, **bulk atómico**, **identidad de lock**, **supersede
  append-only** e **inmutabilidad de PUT** (IMMUTABLE_EFFECTIVE_CONFIG).
- `api/tests/peopleService.test.js` — `validateAssignmentRefs` devuelve la
  empresa autoritativa; `createAssignment` persiste el snapshot; INCOHERENT_SCOPE.
- `web/src/lib/__tests__/workdayDefaults.test.ts` — validación/normalización,
  formas reales de API, `bulkBlockingCount` (incluye incomplete).
- Corridas: `api` suite completa verde; matriz TZ UTC/America-Asuncion/Asia-Tokyo;
  `web` build (typecheck) + jest verdes. Migraciones 085/086 las valida el job
  MySQL 8 efímero de CI.

## 7. Invariantes respetadas

No toca ATT2000 (READ-ONLY); no `DELETE`; no modifica fichajes históricos; **no
recalcula `daily_summary`**; no inventa contratos/horarios/asignaciones a partir
de datos ambiguos (config incompleta se salta de capa; empresa histórica
desconocida = NULL, no se infiere); el pasado es inmutable (append-only); toda
operación masiva es preview/dry-run y su aplicación es gateada. Migraciones
085/086 aditivas y **NO aplicadas en prod**; writers fail-closed. Sin merge ni
deploy.

## 8. Gaps / trabajo futuro (fuera de este PR)

- `employee_contracts` no aporta horas: la capa 5 sólo traza `contract_id`. Si
  el negocio quisiera derivar jornada del contrato, requeriría un esquema nuevo
  (no se asume aquí, por invariante de no inventar datos).
- El "bootstrap" (sembrar defaults desde datos actuales) queda como importación
  masiva con dry-run explícito; no hay backfill automático.
- Aplicar `085` y activar `WORKDAY_CONFIG_WRITE_ENABLED` son pasos de OPS con su
  propia autorización; este PR no los ejecuta.
