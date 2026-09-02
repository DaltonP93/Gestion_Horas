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
  **conversión trazable**: `POST /api/candidates/:id/convert` enlaza a un
  empleado **existente** (`converted_employee_id`), nunca crea ni fabrica
  empleados; queda auditada.
- **`employee_assignments`** — historial **temporal** de asignación organizativa
  (sucursal, departamento, centro de costo, cargo, remuneración de referencia)
  con vigencia efectiva `valid_from`/`valid_to`. **Append-only**: crear una
  vigencia cierra la anterior (`valid_to` = nuevo `valid_from` − 1 día) en una
  transacción; nunca borra el contexto anterior. Inserciones fuera de orden se
  rechazan (409).
- **`employee_documents.access_level`** — metadato de acceso aditivo (sin tocar
  los archivos reales; sin firma).
- Rutas `/api/candidates` y `/api/assignments/employee/:id` con permisos
  granulares (`candidatos`, `asignaciones`), validación Joi y auditoría con
  correlation id (remuneración redactada). UI mínima: `/candidatos` (con
  conversión).

Flag nuevo: **`PEOPLE_WRITE_ENABLED`** — default `false` (fail-closed), sólo
`"true"` habilita crear/editar/convertir. Reads y autorización siempre activos.

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
