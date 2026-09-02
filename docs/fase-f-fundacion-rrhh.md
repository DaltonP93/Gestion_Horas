# FASE F — Fundación RR. HH. robusta

> Guía técnica del programa de evolución de SisHoras (Gestion_Horas) hacia una
> plataforma integral de asistencia, RR. HH. y nómina. Documenta decisiones de
> arquitectura, migraciones, flags y límites por módulo. **No** declara
> cumplimiento legal ni cálculo de nómina oficial: eso requiere fuente
> normativa verificable y aprobación humana.

## Invariantes no negociables (aplican a toda la FASE F)

- **att2000 (SQL Server) es estrictamente READ-ONLY.** Ninguna migración,
  writer ni código de esta fase escribe en `CHECKINOUT` ni tablas vinculadas.
- **No se fabrican** marcaciones, ausencias, horas ni estados; no se recalcula
  ni se sobrescribe histórico de asistencia (`attendance_logs`, `daily_summary`).
- **Auto-polling ZKTeco sigue desactivado por defecto** (no lo toca esta fase).
- **Todo writer nuevo es fail-closed**: protegido por autorización de servidor
  (permiso granular en API), validación (Joi) y un feature flag que sólo el
  string exacto `true` habilita. Por defecto, apagado.
- **La autorización se aplica en la API, no sólo en la UI.**
- Migraciones exclusivamente **MySQL**, versionadas, idempotentes y aditivas;
  compatibles con una producción que puede no tener aún 072/073/075 aplicadas.
- `migrate --status` permanece estrictamente read-only.

## Modelo actual reutilizado (no se duplica)

- Organización: `branches` (015), `departments` (+`parent_id`, 066).
- Personas: `employees`, `users` (rol como ENUM, sin tabla de roles),
  `employee_contracts` (051), `job_titles` (069), `payment_types` (068).
- Permisos: `permissionMatrix.js` (MODULES + ROLE_DEFAULTS), overrides por
  usuario en `user_permissions`, middleware `requirePermission(module, action)`
  y `authorize(...roles)`; alcance por departamento en `departmentScope.js`.
- Auditoría: `audit_events` (012) + servicio `audit.js`.
- Acceso a datos: `sequelize.query` con SQL crudo (no hay modelos ORM).

## PR F1 — Gobierno, organización, permisos y auditoría (este PR)

### Qué agrega

1. **Entidades de organización** (migración `076`):
   - `companies` (empresas / personas jurídicas empleadoras).
   - `cost_centers` (centros de costo, opcionalmente ligados a una empresa).
   - Enlaces **nuleables, aditivos y sin backfill**: `branches.company_id`,
     `departments.cost_center_id` (FKs `ON DELETE SET NULL`).
   - Sin backfill deliberado: asignar empresa/centro "por defecto" sería
     fabricar gobierno; las columnas quedan en NULL hasta que una persona las
     complete desde el ABM.
2. **Correlation id de auditoría**:
   - Middleware `requestId` → `req.correlationId` + header `X-Correlation-Id`.
   - `audit_events.correlation_id` (migración `077`), con **degradación**: si la
     columna no está (077 pendiente), `audit.js` detecta el `ER_BAD_FIELD_ERROR`
     y reintenta el INSERT legacy; la auditoría nunca se pierde por esquema
     parcial.
   - `utils/redact.js` enmascara claves sensibles (RUC/`tax_id`, salarios,
     documentos, credenciales, biometría) en el `details` auditado.
3. **Permisos granulares en API**: módulos `empresas` y `centros_costo` en la
   matriz; rutas `/api/companies` y `/api/cost-centers` con
   `requirePermission(...)` en lectura y escritura.
4. **Autorización de ALCANCE en API** (`services/orgScope.js`): además de
   módulo/acción, se aplica alcance por **empresa / sucursal / departamento**.
   Roles no restringidos (super_admin/admin/gth/hr) son globales — bypass
   **explícito y probado**; roles con alcance ven sólo su empresa/sucursal/
   departamento (+descendientes). Las lecturas se filtran (`listCompanies`/
   `listCostCenters` por empresa del alcance; `getCompany`/`getCostCenter`
   fuera de alcance → 404) y los writers **rechazan referencias fuera de
   alcance** (`assert*InScope` → 403 `OUT_OF_SCOPE`). Degrada si
   `branches.company_id` (076) aún no existe.
5. **Writers fail-closed**: `services/governance.js` expone
   `assertWriteEnabled()` sobre `GOVERNANCE_WRITE_ENABLED` (default `false`,
   sólo `"true"` habilita). Con el flag apagado, POST/PATCH responden 503
   `GOVERNANCE_WRITES_DISABLED`; los GET funcionan siempre.
5. **UI mínima** protegida por permiso: `/configuracion/empresas` y
   `/configuracion/centros-costo` con estados de carga/error/vacío; el guardado
   muestra el 503 de modo sólo lectura sin romperse.

### Flags nuevos

| Flag | Default seguro | Efecto |
| --- | --- | --- |
| `GOVERNANCE_WRITE_ENABLED` | `false` (fail-closed) | Sólo `"true"` habilita escrituras de empresas/centros de costo. |

### Compatibilidad y migraciones

- `076` y `077` son **aditivas, idempotentes y no destructivas** (guardas
  `IF NOT EXISTS`, procedimiento para columnas/índices/FKs). Instalación limpia
  y upgrade desde el esquema previo se comportan igual. No tocan
  `employees`, `attendance_logs`, `daily_summary` ni att2000.
- **Prueba de migración en MySQL real** (no sólo form-test): el job de CI
  `migrations-mysql` levanta un MySQL 8 efímero, prepara el esquema previo real
  (init.sql + prerequisitos) y ejecuta el **runner real** `api/scripts/migrate.js`
  verificando primera aplicación, **reaplicación idempotente**, `--status`
  estrictamente read-only, y FKs/columnas (tests de integración `tests/it/`).
  El form-test (`governanceMigration.test.js`) se conserva como chequeo rápido.
- **CI en PRs encadenados**: `ci.yml` dispara en `main` y en `claude/**`, así
  cada PR de la cadena obtiene CI real sobre su HEAD aunque su base no sea main.
  Sin secretos ni acceso a producción.

### Límites de F1

- No hay DELETE de empresas/centros (se desactivan con `active=0`).
- No se asignan empleados a centros de costo todavía (eso es F2/asignaciones).

## PR F2 — Personas: candidatos y asignaciones con vigencia

Encadena sobre F1. Reutiliza `employee_contracts` (051), `employee_documents`
(067) y `job_titles` (069); **no** los duplica. Agrega (migración `078`):

- **`candidates`** — postulantes con estado (`new`…`hired`/`rejected`) y
  **conversión trazable y ATÓMICA**: `POST /api/candidates/:id/convert` abre
  transacción, bloquea la fila (`SELECT … FOR UPDATE`) y hace `UPDATE …
  WHERE converted_employee_id IS NULL` con chequeo de `affectedRows`, de modo que
  **dos conversiones concurrentes** no compiten (una gana, la otra 409). Enlaza a
  un empleado **existente** (`converted_employee_id`), nunca crea ni fabrica
  empleados. **Auditoría sin PII**: sólo id, acción y nombres de campos (nunca
  nombre/email/teléfono/notas ni texto libre).
- **AISLAMIENTO por alcance JERÁRQUICO (P1-A)** — `candidates` gana alcance
  opcional `company_id`/`branch_id` (nuleable, aditivo, sin backfill, FKs
  `SET NULL`). Regla **jerárquica y fail-closed**, idéntica en
  `canSeeCandidateRefs`, `candidateScopeFilter`, GET lista/detalle, PATCH,
  `convertCandidate` y POST/PATCH:
  - candidato **con `branch_id`** → visible sólo si esa **sucursal** está en el
    alcance del actor; **NO** hay fallback a empresa (un manager de la sucursal A
    **no** ve un candidato de la sucursal B aunque compartan empresa — cierra la
    fuga de PII entre sucursales que Codex marcó);
  - candidato **sin `branch_id` pero con `company_id`** → visible por empresa;
  - candidato **sin alcance** (ambos NULL) → sólo un rol global de RR.HH.
  `GET /:id` y `convert` fuera de alcance → **404** (no filtra existencia). Un
  actor con alcance **no puede crear ni convertir** un candidato **sin alcance**
  (→ 403). `validateCandidateRefs` valida existencia (400), alcance (403
  `OUT_OF_SCOPE`) y **coherencia sucursal → empresa** (400 `INCOHERENT_SCOPE`).
  La **conversión** verifica el alcance del candidato (404) y del **empleado
  destino** (403), manteniendo transacción/`FOR UPDATE`/anti-doble-conversión.
- **`employee_assignments`** — historial **temporal** de asignación organizativa
  con vigencia efectiva `valid_from`/`valid_to`. **Append-only y atómico**: se
  abre transacción y se **bloquea la fila del empleado** (`FOR UPDATE`) antes de
  leer la vigencia abierta, así **dos creaciones concurrentes** se serializan y
  **nunca** quedan dos vigencias abiertas; inserciones fuera de orden → 409.
  Antes de listar/leer/crear, la ruta verifica el **empleado objetivo** contra el
  alcance departamental/sucursal del actor: `GET` fuera de alcance → **404** (no
  filtra existencia), writer fuera de alcance → **403 `OUT_OF_SCOPE`**.
  **Coherencia mutua de referencias (P1-B)**: `validateAssignmentRefs` corre
  **dentro de la transacción**, tras el lock del empleado (anti-TOCTOU), y exige
  que **todas** las referencias conocidas pertenezcan a la **misma empresa** —
  sucursal (`branches.company_id`), centro de costo (`cost_centers.company_id`) y
  departamento (pertenencia vía el modelo existente
  `departments.cost_center_id → cost_centers.company_id`, sin inventar relación
  nueva). Sucursal de empresa A + centro de costo de empresa B → **400
  `INCOHERENT_SCOPE`** (ni siquiera un rol global puede mezclar empresas). FK
  `employee_id` con **`ON DELETE RESTRICT`** (no CASCADE): el historial auditable
  no se borra al eliminar un empleado. Aislamiento jerárquico, coherencia mutua y
  concurrencia probados en integración contra MySQL real
  (`tests/it/people.it.test.js`) y con la DB mockeada
  (`tests/peopleScope.test.js`, `tests/peopleService.test.js`).
- **`employee_documents.access_level`** — metadato de acceso aditivo (sin tocar
  los archivos reales; sin firma).
- Rutas `/api/candidates` y `/api/assignments/employee/:id` con permisos
  granulares (`candidatos`, `asignaciones`), validación Joi y auditoría con
  correlation id (remuneración redactada). UI mínima: `/candidatos` (con
  conversión).

Flag nuevo: **`PEOPLE_WRITE_ENABLED`** — default `false` (fail-closed), sólo
`"true"` habilita crear/editar/convertir. Reads y autorización siempre activos.

## PR F3 — Calendario, jornada y coexistencia con asistencia

Encadena sobre F2. Complementa —sin duplicar— la tabla `holidays` (feriados) y
el motor de jornada. Agrega (migración `079`):

- **`labor_calendars` — versionado REAL + código por ALCANCE (P1-B)**: la
  unicidad es por `(scope_key, code, valid_from)` —**nunca** por `code` a
  secas—, donde `scope_key` es una columna **generada** determinista
  (`COALESCE(company_id,0):COALESCE(branch_id,0)`). Decisión explícita: el
  `code` es único **dentro de un alcance** (global / empresa / sucursal), así dos
  empresas o sucursales pueden repetir el mismo código, y cada alcance versiona
  por `valid_from`. Persiste `work_days` (1..7), `timezone` (default
  `America/Asuncion`) y `week_start`. Las FKs de alcance son `ON DELETE RESTRICT`
  (MySQL prohíbe `SET NULL`/`CASCADE` sobre la base de una columna generada
  indexada; además preserva la config). `createCalendar` valida **fechas civiles
  reales** (rechaza p.ej. `2026-02-30` → 400 `INVALID_DATE`) y
  `valid_from <= valid_to` (400 `INVALID_VALIDITY`).
- **ALCANCE JERÁRQUICO en todas las rutas de calendario (P1-A)**: `canSeeCalendar`
  y `calendarScopeFilter` aplican la MISMA regla que los candidatos —
  **el `branch_id` manda, sin fallback a empresa**: un calendario global (ambos
  NULL) es visible para todos; uno **con `branch_id`** sólo si esa sucursal está
  en el alcance (un actor de la sucursal A1 **no** ve ni edita excepciones de un
  calendario de A2 aunque compartan empresa — fuga cerrada); uno **sólo-empresa**
  (`branch_id` NULL) por empresa. `list`/`:id`/`exceptions`/`:id/effective` usan
  esos helpers → fuera de alcance **404** (no filtra existencia). `GET /effective`
  **no acepta** empresa/sucursal ajena (→ 403 `OUT_OF_SCOPE`). `GET /workday/:empId`
  verifica el **alcance del empleado** (404). Writers de calendario/excepciones
  validan alcance y **coherencia sucursal → empresa**; un writer con alcance no
  puede mutar un calendario **global** (403). `validateCalendarRefs` reutiliza
  `orgScope` (sin duplicar).
- **`calendar_exceptions`** — días puntuales: `nonworking` / `working`
  (habilita un día de descanso) / `special`.
- **Lógica pura `laborCalendar.js`** — clasifica cada fecha (laborable/no)
  componiendo excepciones + feriados + `work_days`. **Invariante a la TZ del
  proceso** (mismo resultado en UTC/Asunción/Tokyo).
- **Resolución por ALCANCE + FECHA**: `pickCalendarForDate({company_id,
  branch_id}, date)` con **precedencia determinista** (sucursal > empresa >
  global; a igual especificidad, `valid_from` más reciente). `GET
  /api/labor-calendars/effective?company_id&branch_id&from&to` resuelve la
  versión aplicable **por cada día**; `GET /:id/effective` inspecciona una
  versión puntual usando sus `work_days` persistidos.
- **Jornada read-only con TRES estados explícitos** `GET
  /api/labor-calendars/workday/:empId`:
  - tabla `employee_schedule_history` ausente → `schema_state:'missing'` +
    `historical_fallback`;
  - esquema parcial → `schema_state:'incomplete'` con mensaje controlado
    (**nunca** un error SQL crudo ni un fallback/`error+reintento` silencioso).
    La detección (P1-B) exige el **conjunto COMPLETO** de columnas que lee
    `loadScheduleHistory` en el camino normal: base **072** (`check_in`,
    `check_out`, tolerancias, breaks, `weekly/daily_target_minutes`,
    `schedule_id`, vigencia) + **073** (`work_regime`, políticas, `night_*`,
    `work_days`) + metadatos **075/phaseC** (`schedule_name_snapshot`,
    `snapshot_*`, `change_reason`, `overtime/rounding_policy_version/config`).
    Falta cualquiera → `incomplete` y **no** se llega a `loadWorkdayConfig`. Así,
    una tabla con las 7 de 073 pero sin `check_in`/`check_out` (072), o con 075
    parcial, es `incomplete` de forma **explícita** (no vía el error+reintento
    interno);
  - esquema completo (todas presentes) → delega en `workdayConfig`
    (`schema_state:'complete'`).
  **No** recalcula ni modifica `attendance_logs`/`daily_summary`/att2000.
- **Fechas civiles reales (P1-B)**: excepciones (`day`), `GET /workday/:empId?date`
  y los resolutores/creación rechazan fechas imposibles (`2026-02-30` → 400
  `INVALID_DATE`) con `parseCivilDate`, **sin** ejecutar SQL de escritura.
- **P2 — IDs correctos**: `createCalendar` (y en F4 `createConcept`/`createPeriod`)
  devuelven el `insertId` real (`result?.insertId ?? result`), porque
  `sequelize.query(INSERT)` retorna `[insertId, affectedRows]` contra MySQL.
  Pendiente registrado: aplicar el mismo patrón a los writers de gobierno de F1
  **antes** de habilitarlos (F1 no se toca en esta ronda).
- **Degradación** de lectura de calendario/feriados ante tabla ausente (42S02).
  UI mínima: `/configuracion/calendario-laboral` (consulta de rango). Versionado,
  código por alcance, aislamiento **jerárquico** cross-scope (A1≠A2 de la misma
  empresa), los estados de esquema (072/073/075) y las fechas imposibles probados
  en integración contra MySQL real (`tests/it/calendar.it.test.js`) y con la DB
  mockeada (`tests/calendarScope.test.js`, `tests/calendarService.test.js`).

Flag nuevo: **`CALENDAR_WRITE_ENABLED`** — default `false` (fail-closed).

## PR F4 — Base de nómina (SANDBOX NO OFICIAL), reportes y extensibilidad

Encadena sobre F3. Construye **sólo la base segura**; **no** calcula liquidación
oficial, no evalúa fórmulas, no paga ni integra con IPS/MTESS/bancos. Migración
`080` (aditiva, idempotente, no destructiva, sin backfill):

- **`payroll_concepts`** — catálogo **versionado** de ingresos/descuentos
  (`UNIQUE(code, version)`, vigencia; `createConcept` valida `valid_from <=
  valid_to`). `formula_hint` es texto descriptivo, **nunca se evalúa**.
- **`payroll_periods`** — máquina de estados **atómica** `draft→preview→locked→
  closed`. `createPeriod` valida `period_start <= period_end`. `transition` abre
  transacción y **bloquea la fila** (`SELECT … FOR UPDATE`), valida dentro de la
  transacción y hace `UPDATE … WHERE status = <esperado>` con chequeo de
  `affectedRows` → **cierre concurrente**: uno cierra, el otro recibe 409
  (`PERIOD_CLOSED`/`STALE_TRANSITION`). Todo período nace `is_official = 0`; un
  período **cerrado es terminal**.
- **`payroll_period_snapshots`** — snapshot **agregado** al cerrar.
  **`UNIQUE(period_id)`**: exactamente uno por período (garantía en base, no sólo
  en código). FK **`ON DELETE RESTRICT`** (no CASCADE): la evidencia de cierre no
  se borra en cascada.
- **Previsualización sandbox** `GET /periods/:id/preview` — resumen AGREGADO
  `official:false` + disclaimer; **sin montos ni PII**.
- **Analytics agregado** `GET /analytics/headcount` — conteos, sin PII.
- **Adaptadores** `GET /integrations` — IPS, MTESS/REOP, firma, bancos,
  notificaciones y pagos: **SIEMPRE `enabled:false`**. No existe integración
  real, así que un flag de entorno **no** puede presentarla como habilitada.
- UI mínima `/configuracion/nomina-base` con banner **NO OFICIAL**.
- Concurrencia y unicidad de snapshot probadas en integración
  (`tests/it/payroll.it.test.js`).

Flag nuevo: **`PAYROLL_WRITE_ENABLED`** — default `false` (fail-closed). Los
nombres de flags de integración se documentan como referencia futura, pero
`/integrations` los reporta `enabled:false` sin excepción.

## Próximas etapas (planificadas, no implementadas)

- **F2** — personas, candidatos y contratos con vigencia efectiva e historial.
- **F3** — calendario/jornada/cumplimiento (timezone America/Asuncion),
  integración **de sólo lectura** con los snapshots de jornada existentes.
- **F4** — base de nómina (sin liquidación oficial ni pagos reales),
  previsualización sandbox, reportes agregados y adaptadores **apagados** para
  IPS/MTESS/firma/bancos/notificaciones/pagos.

Etapas ulteriores planificadas pero **no** integradas como conexión real:
competencias, desempeño/360/Nine Box, capacitaciones, firma electrónica,
envíos legales, pagos bancarios y notificaciones multicanal.
