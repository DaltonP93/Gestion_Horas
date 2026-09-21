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

## 2. Precedencia nueva (explícita y auditable)

Única fuente de verdad en `api/src/services/workdayEffectiveConfig.js`
(`PRECEDENCE`), de mayor a menor prioridad:

1. `published_shift_assignment` — turnera publicada (capa 1, vía `forDate`).
2. `employee_historical_override` — `employee_schedule_history` (capa 2, vía `forDate`).
3. `department_historical_default` — `workday_config_defaults` scope=department **(NUEVO)**.
4. `company_historical_default` — scope=company **(NUEVO)**.
5. `general_historical_default` — scope=general **(NUEVO)**.
6. `employee_contract_trace` — identidad de contrato (aporta `contract_id`, **no** habilita `configured`).
7. `historical_fallback` — sin evidencia → el motor resuelve sin config.

Reglas: una capa sólo habilita `calculation_mode='configured'` si su config es
**completa** (`check_in` + `check_out` + `work_days`); si no, se **salta** a la
siguiente (nunca se inventa una jornada). El departamento/empresa del empleado se
resuelven **as-of-date** desde `employee_assignments` (078) y
`cost_centers.company_id`; sin asignación vigente se cae al `department_id`
**actual** de `employees`, marcado `scope_source='current_fallback'` para no
introducir deriva retroactiva.

## 3. Datos (migración `085`)

`database/migrations/085_workday_config_defaults.sql` (aditiva, idempotente,
sin backfill):

- **`workday_config_defaults`** — default de jornada **versionado por alcance**:
  `scope ENUM('general','company','department')`, `company_id`/`department_id`
  nullables, `valid_from`/`valid_to` (inclusive, `NULL`=abierta), payload de
  jornada con paridad con ESH (`check_in`…`work_days`, políticas, franja
  nocturna). Columna generada `scope_key = scope:company:department` con
  `UNIQUE(scope_key, valid_from)`; la NO-superposición de vigencias dentro del
  alcance se valida en el servicio (igual que ESH). FKs a `companies`/
  `departments` `ON DELETE RESTRICT`.
- **`workday_config_default_audit`** — auditoría de defaults
  (`create|update|close`, actor, `before_json`/`after_json`, motivo).

**Modelo elegido:** versionado inmutable del pasado (una versión nueva = una fila
nueva), como `labor_calendars` (079) y el snapshot de ESH. Preserva el histórico
sin explosión de snapshots por empleado y evita la deriva retroactiva.

## 4. API (rutas nuevas, `/api/workday-config`)

- `GET /precedence` — precedencia canónica + `writes_enabled` (para UI/docs).
- `GET /employees/:id/effective-hierarchical?date=YYYY-MM-DD` — **resuelve la
  jornada efectiva** aplicando toda la precedencia (read-only).
- `GET /defaults?scope=&company_id=&department_id=` — listado (read-only).
- `POST /defaults` · `PUT /defaults/:id` · `POST /defaults/:id/close` — CRUD
  versionado con lock por alcance, chequeo de solapes y auditoría (gateado).
- `POST /defaults/bulk/preview` — **dry-run masivo, cero escrituras**; valida,
  detecta solapes intra-lote y contra BD (una consulta por `scope_key`, **sin
  N+1**) y devuelve veredicto por fila. Base de la importación masiva.
- `POST /defaults/bulk/apply` — aplicación masiva **gateada**; sólo si el preview
  no tiene conflictos (`409 BULK_HAS_CONFLICTS` si los hay).

Todas las escrituras pasan por `assertWriteEnabled()` (fail-closed) **antes** de
tocar la BD y quedan auditadas por `audit.log` + `workday_config_default_audit`.

## 5. UI

- `/configuracion/laboral` — administración escalable: precedencia visible,
  resolutor efectivo por empleado+fecha, alta de default por alcance con
  vigencia y días, importación masiva con preview/dry-run (aplicar bloqueado si
  hay conflictos), listado filtrable y **banner de modo sólo lectura** cuando el
  flag está en `false`. Registrada en `navModules` (roles admin/gth/hr) + i18n
  es/en/pt.

## 6. Tests

- `api/tests/workdayEffectiveConfig.test.js` — precedencia pura (7 capas),
  vigencias, completitud, nocturnos, determinismo por string (sin TZ).
- `api/tests/workdayConfigDefaultsService.test.js` — validadores de alcance/
  cuerpo/solape, **write-gate fail-closed** (no toca BD con el flag OFF),
  **bulk dry-run sin escrituras y sin N+1**, camino feliz de `createDefault`.
- `api/tests/workdayEffectiveForDate.test.js` — cableado de `getEffectiveForDate`
  con BD y `forDate` mockeados: precedencia, vigencias, **cambio de departamento
  as-of-date** (bordes 2026-06-30/2026-07-01), nocturnos, `current_fallback`.
- `web/src/lib/__tests__/workdayDefaults.test.ts` — validación/normalización del
  formulario e importación (JSON array/NDJSON).
- Corridas: `api` suite completa verde; matriz TZ UTC/America-Asuncion/Asia-Tokyo
  sobre las suites nuevas; `web` build (typecheck) + jest verdes.

## 7. Invariantes respetadas

No toca ATT2000 (READ-ONLY); no `DELETE`; no modifica fichajes históricos; **no
recalcula `daily_summary`** (< 2026-09-16 ni ningún otro); no inventa contratos/
horarios/asignaciones a partir de datos ambiguos (config incompleta se salta de
capa); toda operación masiva es preview/dry-run y su aplicación es gateada y
requiere autorización posterior (writers en `false`). Sin merge ni deploy.

## 8. Gaps / trabajo futuro (fuera de este PR)

- `employee_contracts` no aporta horas: la capa 5 sólo traza `contract_id`. Si
  el negocio quisiera derivar jornada del contrato, requeriría un esquema nuevo
  (no se asume aquí, por invariante de no inventar datos).
- El "bootstrap" (sembrar defaults desde datos actuales) queda como importación
  masiva con dry-run explícito; no hay backfill automático.
- Aplicar `085` y activar `WORKDAY_CONFIG_WRITE_ENABLED` son pasos de OPS con su
  propia autorización; este PR no los ejecuta.
