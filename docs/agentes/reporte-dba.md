# Reporte DBA — SisHoras (MySQL 8)

**Fecha:** 2026-07-07
**Alcance:** `database/init.sql`, `database/migrations/002–037`, consultas SQL en `api/src/routes/`, `api/src/services/`, `api/src/controllers/`, flujo de sync `att2000 (SQL Server) → attendance_logs → daily_summary`.
**Entregable asociado:** `database/migrations/038_performance_indexes.sql` (solo cambios aditivos e idempotentes).

## 1. Resumen ejecutivo

El esquema es en general correcto (InnoDB, utf8mb4, FKs en las tablas núcleo, clave única antiduplicados en `attendance_logs`, tabla resumen `daily_summary` con `uk_emp_date`). Los problemas de rendimiento de las "cargas de horas" **no están en el diseño de tablas sino en cómo se consulta y se recalcula**:

1. **`DATE(timestamp)` en los WHERE** de casi todos los caminos calientes impide usar el índice compuesto `idx_emp_ts` (16 ocurrencias localizadas).
2. **N+1 severo en el recálculo masivo** (`api/src/services/processing.js`): un mes de 200 empleados ≈ 5.200 pares (empleado, día) × ~5 queries c/u ≈ **26.000 round-trips**, cuando ya existe una versión set-based (`bulkRecalcDailySummary`) que resuelve un día completo en 1 query.
3. **N+1 severo en el sync att2000** (`api/src/config/zkAdapter.js`): 3 queries MySQL por cada marcaje importado (hasta 50.000 marcajes en `fullSync` ≈ 150.000 round-trips).
4. **Agregaciones mensuales sin índice cubriente** en `daily_summary` (reportes, nómina, ejecutivo, tendencias).
5. **Cero uso de Redis como caché** (solo se usa como Pub/Sub); el dashboard recalcula los mismos KPIs en cada request.

Además hay **3 defectos funcionales de esquema/consulta** que hoy rompen endpoints o datos (sección 2.5).

## 2. Revisión del esquema

### 2.1 Normalización (1FN–3FN)

| Tabla.columna | Problema | FN | Recomendación |
|---|---|---|---|
| `schedules.work_days` = `'1,2,3,4,5'` (init.sql:31) | Atributo multivaluado en VARCHAR | **1FN** | Tabla `schedule_work_days(schedule_id, dow)` o `SET`; hoy además **ningún cálculo la usa** |
| `report_schedules.recipients` emails CSV (mig. 002) | Multivaluado | **1FN** | Tabla hija o JSON; riesgo bajo |
| `permissions.status` **y** `permissions.approval_state` (init.sql:150 + mig. 011) | Dos máquinas de estado paralelas | **3FN/consistencia** | Derivar `status` de `approval_state`; fuente real de bugs (2.5) |
| `daily_summary.schedule_id` (init.sql:124) | Snapshot del turno **nunca escrito** | — | Poblarla en el recálculo o eliminarla |
| `users.role` ENUM que crece por migración (003, 010: 9 valores) | ENUM como catálogo mutable | 2FN práctica | Tabla `roles` + FK, o congelar el ENUM |
| `notification_settings`/`system_settings` clave→valor | EAV consciente | aceptable | OK |

El núcleo (empleado / turno / departamento / marcaje / resumen) **cumple 3FN**.

### 2.2 Tipos de datos

- `attendance_logs.id BIGINT` ✔; `daily_summary.id INT` alcanza.
- `devices.ip_address VARCHAR(15)` (init.sql:85): **no admite IPv6**; ampliar a VARCHAR(45).
- `latitude DECIMAL(10,8)/longitude DECIMAL(11,8)` ✔, pero conviven con `lat/lng DECIMAL(10,7)` duplicadas (mig. 016; ver 2.5).
- `raw_data JSON` guarda `'{}'` en cada push; preferir `NULL`.

### 2.3 Claves foráneas

Correctas en el núcleo. Faltantes: `employees.branch_id`, `devices.branch_id`, `departments.branch_id`, `users.branch_id` → sin FK a `branches(id)`; `checkin_qr_tokens.branch_id`; `user_notifications.user_id` → sin FK. No van en 038 (requieren limpieza de huérfanos y ventana de mantenimiento).

### 2.4 Charset / collation / zona horaria

- Tablas `utf8mb4` **sin collation explícita** → dependen del default del servidor. Fijar `DEFAULT COLLATE=utf8mb4_0900_ai_ci`.
- **Inconsistencia de zona horaria:** `init.sql:7` fija `SET time_zone = '-06:00'` pero `api/src/config/database.js:12` conecta con `timezone: '-03:00'` (Paraguay). Cualquier consulta manual o cron por `mysql` CLI usará la zona del servidor y **puede asignar marcajes nocturnos al día equivocado**. Corregir `init.sql` y fijar `default-time-zone='-03:00'`.

### 2.5 Defectos funcionales detectados

1. **`api/src/routes/supervisor.js:78`** — `pending-approvals` selecciona `p.start_date, p.end_date`, columnas **inexistentes** (el esquema define `date_from/date_to`): el endpoint devuelve error SQL siempre. Filtra `'coordinator_approved'`, que no es valor del ENUM `status`.
2. **`api/src/routes/selfCheckin.js:142`** — inserta `source` con `'web'|'qr'|'geo'`, pero `attendance_logs.source` es `ENUM('device','mobile','manual')`: en modo estricto el INSERT **falla**. Usa la columna `raw`, que no existe (`raw_data`).
3. **Geolocalización duplicada:** `latitude/longitude/accuracy` (init.sql) vs `lat/lng` (mig. 016); el marcaje móvil escribe unas y el self-checkin las otras. Unificar y migrar.

## 3. Consultas problemáticas para las cargas de horas

### 3.1 Funciones sobre columnas indexadas — `DATE(timestamp)` (patrón dominante)

`WHERE employee_id = ? AND DATE(timestamp) = ?` **no puede usar `idx_emp_ts`**; solo `idx_date`, que devuelve marcajes de *todos* los empleados del día. Ocurrencias:

| Archivo:línea | Camino |
|---|---|
| `attendanceController.js:95` | `detectMarkType` — **en cada marcaje** |
| `attendanceController.js:111` | `recalcDailySummary` |
| `attendanceController.js:255` | live feed dashboard |
| `scheduler.js:63` | **generateMarcadasReport** (reporte principal) |
| `scheduler.js:351` | `bulkRecalcDailySummary` |
| `processing.js:44,52` / `routes/processing.js:20,33` | recálculo masivo/preview |
| `reports.js:102` | daily-detail |
| `me.js:152-153` | portal del empleado |
| `supervisor.js:41` | subconsulta correlacionada **por fila** |
| `reconciliation.js:21,40` | job nocturno |
| `reportsBuilder.js:152,156` | reportes a medida (además `DATE(ds.date)` sobre columna ya DATE) |

**Arreglo doble:** (a) índice funcional compuesto `idx_al_emp_day` (migración 038); (b) rewrite sargable:

```sql
-- Antes:  WHERE employee_id = ? AND DATE(timestamp) = ?
-- Después: WHERE employee_id = ? AND timestamp >= ? AND timestamp < ? + INTERVAL 1 DAY
-- Antes:  AND DATE(al.timestamp) BETWEEN :from AND :to
-- Después: AND al.timestamp >= :from AND al.timestamp < DATE_ADD(:to, INTERVAL 1 DAY)
```

### 3.2 N+1

1. **`processing.js:64-84` (`recomputeRange`)** — el peor: itera cada par (empleado, día) llamando `recalcDailySummary` (4-5 queries). Un mes ≈ 20-30 mil queries. **Ya existe la solución**: `bulkRecalcDailySummary(date)` resuelve el día en 1 UPSERT → iterar días (26 queries/mes): ~1000× menos.
2. **`zkAdapter.js:233-279` (`syncAttendance`)** — 3 queries por marcaje; `fullSync` (50000) ≈ 150.000 round-trips. Arreglo: `Map(code→id)` y `Map(sensor_id→device_id)` (2 queries) + INSERT por lotes de 500-1000.
3. **`supervisor.js:40-41`** — subconsulta correlacionada por empleado; reescribir como `LEFT JOIN (SELECT employee_id, MAX(timestamp) ... GROUP BY employee_id)`.
4. **`scheduler.js:320-343`** — dos subconsultas escalares idénticas por grupo; reescribir con JOIN.

### 3.3 `SELECT *`
`attendanceController.js:281` (`SELECT ds.*` arrastra TEXT en cada listado, impide index-only). El resto en tablas chicas, tolerable.

### 3.4 Paginación con OFFSET
`audit_events` crece sin límite: migrar `audit.js` a keyset pagination (`WHERE created_at < :cursor ORDER BY created_at DESC LIMIT n`).

### 3.5 Agregaciones sin índice cubriente
`reports.js:19-35`, `payroll.js:30-52`, `executive.js:27-109`, `trends.js:46-61`, `kpiGoals.js:132`, `embed.js:70`: agregan `daily_summary` por `date BETWEEN`. Con `idx_date(date)` hacen range + lookup por fila (~5.000 lecturas aleatorias/mes). Solución: índice cubriente (4.2).

## 4. Índices propuestos (con EXPLAIN antes/después)

Todos en la migración 038, creación condicional vía `INFORMATION_SCHEMA` (MySQL **no soporta** `CREATE INDEX IF NOT EXISTS`).

### 4.1 `idx_al_emp_day` — `attendance_logs (employee_id, (DATE(timestamp)))`
```text
-- ANTES:  WHERE employee_id=42 AND DATE(timestamp)='2026-07-07'
EXPLAIN: type=ref key=idx_date rows≈400  Extra=Using where
-- DESPUÉS:
EXPLAIN: type=ref key=idx_al_emp_day rows≈4
```

### 4.2 `idx_ds_date_cover` — `daily_summary (date, employee_id, status, worked_minutes, late_minutes, overtime_minutes)` — cubriente
```text
-- ANTES:  type=range key=idx_date rows≈5200 (5200 lookups aleatorios)
-- DESPUÉS: type=range key=idx_ds_date_cover rows≈5200  USING INDEX (index-only)
```

### 4.3 `idx_ds_date_status` — `daily_summary (date, status, late_minutes)` — alertas/KPIs del día (elimina filesort).

### 4.4 `idx_perm_status_created` — `permissions (status, created_at)` — bandeja de pendientes (elimina full scan + filesort).

### 4.5 Redundancias detectadas (documentadas, no se eliminan en 038)
- `employees.idx_code` duplica el índice de `UNIQUE(code)`.
- `attendance_logs.idx_emp_ts` es prefijo exacto de `uq_attendance_punch`.

## 5. Mejoras para cargas de horas "instantáneas"

### 5.1 Evaluación de `daily_summary`
1. **`overtime_minutes` nunca se calcula** (reportes suman 0). Ídem `break_minutes`.
2. **Los ausentes no se materializan**: conteos `status='absent'` subcuentan. Agregar al cron nocturno un `INSERT ... SELECT` anti-join.
3. **Dos algoritmos de horas distintos**: `daily_summary.worked_minutes = last_out − first_in` (incluye almuerzo) vs `generateMarcadasReport` (suma pares). Los totales **no cuadran**. Unificar.
4. **Corte de turno nocturno inconsistente**: Marcadas asigna 00:00-04:59 al día anterior; `daily_summary` no.
5. Con `idx_ds_date_cover`, agregar un mes toma ms: **no hace falta `monthly_summary`** hasta ~2.000 empleados o series multianuales.

### 5.2 Recálculo
`recomputeRange` → iterar días con `bulkRecalcDailySummary`; optimizarlo con JOIN y rango sargable; importación att2000 por lotes.

### 5.3 Particionamiento por fecha — aplica, pero no todavía
Umbral: >10-20M filas o purga por año. Requiere PK con la columna de partición y eliminar índices funcionales (migrar a columna generada `work_date STORED`).

### 5.4 Estrategia de caché Redis (cache-aside)

| Clave | Contenido | TTL | Invalidación |
|---|---|---|---|
| `dash:stats:{date}` | KPIs de `getDashboardStats` | 15-30 s | TTL corto / `DEL` en `processAttendanceEvent` |
| `dash:recent:{date}` | live feed (20 filas) | — | lista Redis (`LPUSH`+`LTRIM 0 19`): 0 queries/request |
| `report:monthly:{y}-{m}:{dept}` | `/api/reports/monthly` | 1 h (mes cerrado: 24 h) | `DEL report:monthly:*` al recalcular |
| `payroll:{y}-{m}:{branch}` | preview de nómina | 1 h | ídem |
| `exec:overview:{y}-{m}:{branch}` | dashboard ejecutivo | 10 min | ídem |
| `emp:summary:{id}:{from}:{to}` | historial por empleado | 5 min | `DEL emp:summary:{id}:*` |

Los meses cerrados son inmutables salvo recálculo: cachearlos agresivamente hace instantáneos los reportes históricos.

## 6. Priorización recomendada

| # | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 1 | Aplicar migración 038 | 5 min | Alto (todas las lecturas calientes) |
| 2 | `recomputeRange` → `bulkRecalcDailySummary` por día | 1-2 h | Muy alto (~1000×) |
| 3 | `syncAttendance` por lotes con mapas en memoria | 2-3 h | Muy alto |
| 4 | Rewrites sargables (`DATE(ts)` → rangos) | 2-4 h | Alto |
| 5 | Corregir defectos 2.5 (supervisor.js, ENUM source, lat/lng, `raw`) | 1-2 h | Crítico funcional |
| 6 | Caché Redis (dashboard y reportes mensuales) | 3-5 h | Alto (UX instantánea) |
| 7 | Materializar ausentes + calcular overtime | 2-4 h | Medio (exactitud) |
| 8 | FKs faltantes | ventana mant. | Medio |
| 9 | Particionamiento | diferir | Bajo hoy |

> La migración `database/migrations/038_performance_indexes.sql` acompaña este reporte (4 índices idempotentes, sin DROPs destructivos).
