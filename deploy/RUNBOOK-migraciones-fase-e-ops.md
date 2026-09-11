# Runbook — aplicar migraciones (incl. FASE E 083 + 084) por OPS, sin CREATE ROUTINE al runtime

> **Estado:** procedimiento preparado. **NO ejecutado.** Lo corre **OPS** en la
> ventana acordada, con autorización explícita del propietario por acción. No lo
> ejecuta la API ni este agente. att2000 sigue READ-ONLY.

## Por qué OPS y no la API
- El endpoint HTTP `/api/fase-e/migrations/apply` **fue retirado**: la API ya **no
  aplica migraciones**. El master-flag `FASE_E_ACTIVATION_ENABLED` **no** aplica
  migraciones (nunca lo hizo por HTTP en esta versión); sólo gatea el flip del
  writer, el recálculo y el restore.
- Las migraciones **073** (función/trigger), **082** (procedimiento) y **084**
  (procedimiento) crean **rutinas**. El usuario **runtime** de la API **NO** debe
  tener `CREATE ROUTINE`/`TRIGGER`. Las migraciones las aplica un **usuario ADMIN**
  de MySQL —con privilegio **`CREATE ROUTINE` al menos temporal**— por **socket**
  (auth `unix_socket`, sin password) o con credenciales admin **efímeras** en el
  shell — **nunca guardadas en PM2/API**.
- La **083** (consola FASE E) es DDL plano (sin rutinas): no necesita `CREATE ROUTINE`.
- La **084** (reconciliación de forma) usa un **procedimiento efímero**
  (`mig_084_apply`, creado y `DROP`eado dentro del propio archivo) para agregar de
  forma **idempotente** lo que falte (`rows_skipped`, el estado
  `restored_with_conflicts`, `applied_json`, `heartbeat_seq`, índices). Por eso el
  usuario ADMIN necesita `CREATE ROUTINE` **también** para 084. Con binary logging
  activo (default de MySQL 8) puede requerir además
  `SET GLOBAL log_bin_trust_function_creators=1` o `SUPER`, igual que 073.
- **El servicio de la consola EXIGE 083 Y 084** (el GO/NO-GO verifica la forma
  completa: columnas, valores de ENUM e índices). Aplicar sólo 083 deja la consola
  en **NO-GO**. Por eso el tope de OPS es **084**, no 083.

## Grants del usuario runtime (referencia)
El usuario de la API alcanza con DML + el DDL de tablas/columnas que usa la app:
`SELECT, INSERT, UPDATE, DELETE` y, si aplica migraciones de tabla en dev,
`CREATE, ALTER, INDEX, REFERENCES`. **NO** conceder `CREATE ROUTINE`, `ALTER
ROUTINE`, `TRIGGER`, `SUPER`. En prod, el runtime **no** aplica migraciones.

## Grants del usuario ADMIN de OPS (para esta corrida)
El usuario ADMIN que corre `ops-migrate.sh` necesita, además del DDL de
tablas/columnas/índices, **`CREATE ROUTINE`** (para 073/082/**084**, que crean
rutinas efímeras) — puede ser **temporal**: revocable tras la corrida. Con binary
logging activo, además `SET GLOBAL log_bin_trust_function_creators=1` **o** `SUPER`.
Por **socket** con `root`/`unix_socket` ya se cumple; por TCP, conceder
`CREATE ROUTINE` (temporal) al usuario admin efímero.

## Precondiciones
- [ ] **Backup fresco y verificado** (`scripts/backup-mysql.sh`), único rollback.
- [ ] Autorización explícita del propietario para esta corrida.
- [ ] Código de `main`/#202 desplegado (las migraciones viven en el repo desplegado).
- [ ] Acceso ADMIN a MySQL por socket (o credenciales admin efímeras).

## Procedimiento
```bash
# Recomendado: socket admin (root por unix_socket), credenciales NO almacenadas.
DB_SOCKET=/var/run/mysqld/mysqld.sock DB_USER=root DB_NAME=asistencia \
  sudo -E bash scripts/ops-migrate.sh

# Alternativa TCP con admin efímero en el shell (no en PM2/API):
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=admin DB_PASSWORD='***' DB_NAME=asistencia \
  bash scripts/ops-migrate.sh
```
`ops-migrate.sh`:
1. `migrate.js --status` (read-only) — muestra pendientes.
2. Aplica pendientes **ACOTADO a `--upto=084_fase_e_console_shape_reconcile.sql`**
   (forward-only, en orden) y **verifica el `exit` real** del runner; aborta si
   != 0. **No arrastra migraciones futuras (085+).**
3. **Valida explícitamente 072→084 registradas** (`schema_migrations`), cada una
   **exactamente una vez** (0 = falta; >1 = duplicada), incluida **082 antes de
   083** y **084 al final**.
4. **Verifica que NO se aplicó ninguna migración por encima del tope** (`filename >
   084…` en `schema_migrations` debe ser 0).
5. Re-aplica **con el mismo `--upto=084`** = **no-op** (idempotencia).

**Entorno admin saneado:** el script invoca a `migrate.js` con
`MIGRATE_NO_DOTENV=1`, así `api/.env` **no** puede aportar la contraseña runtime
ni mezclar identidades; OPS pasa `DB_*` explícitos. En auth por **socket**,
`DB_PASSWORD` se fuerza **vacío** (sólo `unix_socket`).

## Verificación manual (opcional)
```bash
mysql --socket=/var/run/mysqld/mysqld.sock -uroot asistencia -N -B -e \
  "SELECT filename FROM schema_migrations WHERE filename LIKE '08%' ORDER BY filename;"
# Debe listar 080, 081, 082, 083, 084 en ese orden.

# Forma completa que exige el GO/NO-GO (084 reconcilia esto):
mysql --socket=/var/run/mysqld/mysqld.sock -uroot asistencia -N -B -e \
  "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_summary_recalc_batch' AND COLUMN_NAME='status';"
# El ENUM debe incluir 'restored_with_conflicts'. Además deben existir
# daily_summary_recalc_batch.rows_skipped, daily_summary_backup.applied_json,
# el índice único daily_summary_backup.uq_batch_cell y fase_e_console_lock.heartbeat_seq.
```

## Parámetros del PILOTO productivo (cotas de la consola)
La consola acota fail-closed cada operación mutante por **empleados** y **celdas**
(además del rango). Para el **piloto** se configuran **mínimos** en el `.env` de la
API (reversibles, sin reiniciar con `pm2 reload --update-env`):
```env
FASE_E_MAX_EMPLOYEES=1   # piloto: un empleado por operación
FASE_E_MAX_CELLS=2       # piloto: un día (celda + spillover)
```
Si un apply/restore supera la cota → error explícito (`TOO_MANY_EMPLOYEES`/
`TOO_MANY_CELLS`) y **no escribe nada**. Terminado el piloto, subir a los valores
productivos (defaults del código: 2000 / 200000) con OK del propietario.

## Invariantes
- El runtime de la API **no** ejecuta migraciones ni tiene `CREATE ROUTINE/TRIGGER`.
- El usuario **ADMIN de OPS** necesita `CREATE ROUTINE` (temporal) para 073/082/**084**.
- Migraciones 083 + 084 **no activan** multiempresa ni el motor: writers/flags siguen en OFF.
- Aplicar el esquema ≠ activar FASE E (eso es otro paso con su propia autorización).
