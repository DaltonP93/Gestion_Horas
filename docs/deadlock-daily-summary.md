# Fix de deadlock en el recálculo de `daily_summary`

## Incidente

Con auto-polling activado (`ZKTECO_AUTO_POLL=true`, programación general activa,
**sólo Gerencia incluida**, intervalo 15 min):

- **Ciclo 13:30** — `device_sync_runs id=31`, `status=error`, `duration_ms=5139`,
  mensaje: `Deadlock found when trying to get lock; try restarting transaction`.
- **Ciclo 13:45** — `id=32`, `status=success`. El worker se recuperó solo: la
  idempotencia hizo que el siguiente ciclo completara el trabajo.

La evidencia de InnoDB señalaba un conflicto sobre `attendance_logs`, índice
`idx_emp_ts`, durante un `INSERT INTO daily_summary … SELECT … ON DUPLICATE KEY
UPDATE`. Es decir: el problema estaba en la **persistencia / recálculo del
resumen diario**, NO en la conectividad con el reloj ni en el lock físico del
dispositivo.

## Causa raíz

1. **Predicado no sargable.** El recálculo filtraba con
   `WHERE DATE(al.timestamp) = ?`. `DATE(timestamp)` es una función sobre la
   columna: MySQL no puede usar el índice de rango `idx_ts (timestamp)` y termina
   tomando **next-key locks** sobre un tramo amplio del índice de
   `attendance_logs`.

2. **Sin serialización lógica por fecha.** Varios procesos pueden recalcular el
   **mismo día a la vez**:
   - worker de auto-polling (`bulkRecalcDailySummary` desde `zktecoReader`),
   - bridge en tiempo real (`recalcDailySummary` por empleado),
   - cron de respaldo att2000 (`scheduler`),
   - reproceso manual (`processing.recomputeRange`),
   - mapeo de dispositivos (`deviceMapping`).

   Al combinar locks de rango amplios (por el `DATE()`) con dos recálculos
   concurrentes del mismo día que toman los mismos índices en distinto orden,
   InnoDB detecta un ciclo → **deadlock (errno 1213)**.

## Consultas / funciones involucradas

| Función | Archivo | Rol |
|---|---|---|
| `bulkRecalcDailySummary(date)` | `api/src/services/scheduler.js` | `INSERT INTO daily_summary … SELECT … FROM attendance_logs` (víctima del deadlock) |
| `materializeAbsents(date)` | `api/src/services/scheduler.js` | Inserta ausentes del día |
| `recalcDailySummary(empId, ts)` | `api/src/controllers/attendanceController.js` | Recálculo por empleado (bridge) |
| `_backupDeviceDirectImpl` | `api/src/services/zktecoReader.js` | Persiste `raw_device_punches` y `attendance_logs`, dispara recálculo |
| `recordSyncRun` | `api/src/services/zktecoReader.js` | Audita la corrida en `device_sync_runs` |

## Solución

### 1. Rango sargable (usa el índice existente `idx_ts`)

Antes:

```sql
WHERE DATE(al.timestamp) = ?
```

Después:

```sql
WHERE al.timestamp >= ?  -- 'YYYY-MM-DD 00:00:00'
  AND al.timestamp <  ?  -- día siguiente 00:00:00
```

Los límites se calculan con `dayBounds(date)` (`api/src/services/recalcLock.js`).
**No se agrega ningún índice nuevo**: `attendance_logs` ya tiene
`idx_ts (timestamp)` e `idx_emp_ts (employee_id, timestamp)` (ver
`database/init.sql`), que cubren el rango. Añadir índices a ciegas sólo habría
ampliado el bloqueo de escritura.

### 2. Lock lógico por fecha (`GET_LOCK` de MySQL)

`withDayRecalcLock(date, fn)` toma un lock nombrado `sishoras:recalc:<fecha>`
antes de recalcular y lo libera **siempre** (en `finally`). Así dos procesos no
pueden recalcular el mismo día a la vez; los recálculos de **días distintos**
siguen corriendo en paralelo. No cambia el nivel de aislamiento global.

### 3. Reintento acotado ante deadlock / lock-wait

`withDeadlockRetry(fn)` (`api/src/utils/mysqlRetry.js`) reintenta **sólo**
`1213 ER_LOCK_DEADLOCK` y `1205 ER_LOCK_WAIT_TIMEOUT`, hasta 3 intentos, con
backoff incremental + jitter. **Cada intento abre una transacción nueva.** Se
aplica como red de seguridad al lock por fecha y a la persistencia de
`attendance_logs` / `raw_device_punches`. Nunca se vuelve a leer físicamente el
reloj: las marcas ya están en memoria/staging.

### 4. Alcance transaccional reducido

- La **lectura del reloj** nunca ocurre dentro de una transacción de base.
- Lectura → persistencia → recálculo son fases separadas.
- El lock del dispositivo se libera en `finally` (no quedan `device_locks`
  huérfanos), igual que el `GET_LOCK` por fecha.
- El recálculo procesa empleados de forma determinista (`ORDER BY
  al.employee_id`) para tomar los locks en orden consistente.

### 5. Idempotencia

- `attendance_logs`: `INSERT IGNORE` (clave única por empleado/fecha-hora/origen).
- `raw_device_punches`: `INSERT … ON DUPLICATE KEY UPDATE`.
- `daily_summary`: `INSERT … ON DUPLICATE KEY UPDATE` (no pisa estados manuales
  `holiday` / `weekend` / `permission`).
- `device_sync_runs`: nueva columna `retry_count` (migración **065**) guarda los
  reintentos por bloqueo de la corrida.

Un reintento **no duplica** filas en ninguna de esas tablas.

### 6. Estado funcional

Un deadlock al persistir/recalcular es un **error de procesamiento**, no de
conectividad. `device_sync_runs.error_message` muestra un texto amable
(sin SQL ni stack):

> «Error de procesamiento: bloqueo temporal en la base de datos al calcular el
> resumen. La lectura del reloj fue correcta; el próximo ciclo lo completa
> automáticamente.»

El reloj **no** pasa a "Sin conexión". El siguiente ciclo recupera por
idempotencia (tal como ocurrió en el incidente: 13:30 error → 13:45 success).

### 7. Instrumentación por fase

Traza estructurada a logs (nunca a la UI, sin SQL ni datos sensibles):

```
[sync] phase=acquire_device_lock job=<id> device=<id> ms=…
[sync] phase=persist_raw device=<id> ms=… retries=… rows=…
[sync] phase=persist_attendance device=<id> ms=… retries=… imported=…
[sync] phase=recalc_daily_summary device=<id> ms=… dates=…
[sync] phase=release_device_lock device=<id> ms=…
```

Incluye `job_id`, `device_id`, fase, duración, código MySQL e intento cuando
aplica.

## EXPLAIN antes / después

> Ejecutar en producción con datos reales. Plan **esperado**:

**Antes** (no sargable):

```sql
EXPLAIN SELECT … FROM attendance_logs al
WHERE DATE(al.timestamp) = '2026-07-28' GROUP BY al.employee_id;
```

- `type: index` o `ALL` sobre `attendance_logs` (o uso del índice funcional
  `idx_date ((DATE(timestamp)))` sólo si existe), recorriendo/bloqueando un
  tramo amplio del índice → next-key locks extensos.

**Después** (sargable):

```sql
EXPLAIN SELECT … FROM attendance_logs al
WHERE al.timestamp >= '2026-07-28 00:00:00'
  AND al.timestamp <  '2026-07-29 00:00:00'
GROUP BY al.employee_id;
```

- `type: range`, `key: idx_ts` (o `idx_emp_ts`), `rows` acotado al día → locks
  de rango mínimos.

## Despliegue

```bash
# 1) Traer cambios
git pull origin main

# 2) Aplicar migración 065 (idempotente: se puede correr varias veces)
cd api && node scripts/migrate.js      # runner de migraciones del repo

# 3) Reiniciar API y worker (no requiere rebuild del front)
pm2 reload api
pm2 reload sishoras-sync-worker

# 4) Verificar la columna nueva
#    SHOW COLUMNS FROM device_sync_runs LIKE 'retry_count';
```

Sin cambios de configuración. **No** activa Comedor ni Lavadero. **No** toca el
front. **No** inicia escritura al reloj (USER_WRQ).

### Rollback

La migración sólo **agrega** una columna (`retry_count`), sin borrar datos. Para
volver atrás basta con `git revert` del commit de código y `pm2 reload`; la
columna puede quedar (es inocua) o eliminarse con
`ALTER TABLE device_sync_runs DROP COLUMN retry_count;`.

## Validación (sólo Gerencia)

1. Mantener `ZKTECO_AUTO_POLL=true`, programación general activa, **sólo
   Gerencia** incluida (intervalo 15 min, intentos 3, cooldown 4, timeout 600).
2. Observar 4–6 ciclos:
   ```sql
   SELECT id, status, retry_count, duration_ms, error_message, created_at
   FROM device_sync_runs ORDER BY id DESC LIMIT 10;
   ```
   - Esperado: `status=success`. Si aparece `retry_count > 0` con
     `status=success`, el reintento absorbió un bloqueo transitorio (correcto).
   - Ya **no** debería aparecer `status=error` con "Deadlock found …".
3. Confirmar en logs del worker las fases `[sync] phase=…` con sus duraciones.
4. Verificar que no quedan trabajos ni locks colgados:
   ```sql
   SELECT id, status FROM sync_jobs WHERE status = 'running';  -- no debe quedar viejo
   SELECT * FROM device_locks;                                 -- sin huérfanos
   SELECT id, next_auto_sync_at FROM devices WHERE auto_sync_enabled = 1;
   ```
5. Recién con Gerencia estable varios ciclos seguidos se evaluaría sumar otra
   sede.
