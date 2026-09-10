# Runbook — aplicar migraciones (incl. FASE E 083) por OPS, sin CREATE ROUTINE al runtime

> **Estado:** procedimiento preparado. **NO ejecutado.** Lo corre **OPS** en la
> ventana acordada, con autorización explícita del propietario por acción. No lo
> ejecuta la API ni este agente. att2000 sigue READ-ONLY.

## Por qué OPS y no la API
- El endpoint HTTP `/api/fase-e/migrations/apply` **fue retirado**: la API ya **no
  aplica migraciones**.
- Las migraciones **073** (función/trigger) y **082** (procedimiento) crean
  **rutinas**. El usuario **runtime** de la API **NO** debe tener
  `CREATE ROUTINE`/`TRIGGER`. Las migraciones las aplica un **usuario ADMIN** de
  MySQL, por **socket** (auth `unix_socket`, sin password) o con credenciales
  admin **efímeras** en el shell — **nunca guardadas en PM2/API**.
- La 083 (consola FASE E) es DDL plano (sin rutinas): no necesita `CREATE ROUTINE`.

## Grants del usuario runtime (referencia)
El usuario de la API alcanza con DML + el DDL de tablas/columnas que usa la app:
`SELECT, INSERT, UPDATE, DELETE` y, si aplica migraciones de tabla en dev,
`CREATE, ALTER, INDEX, REFERENCES`. **NO** conceder `CREATE ROUTINE`, `ALTER
ROUTINE`, `TRIGGER`, `SUPER`. En prod, el runtime **no** aplica migraciones.

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
2. Aplica pendientes **ACOTADO a `--upto=083_fase_e_activation_console.sql`**
   (forward-only, en orden) y **verifica el `exit` real** del runner; aborta si
   != 0. **No arrastra migraciones futuras (084+).**
3. **Valida explícitamente 072→083 registradas** (`schema_migrations`),
   incluida **082 antes de 083**.
4. Re-aplica **con el mismo `--upto=083`** = **no-op** (idempotencia).

**Entorno admin saneado:** el script invoca a `migrate.js` con
`MIGRATE_NO_DOTENV=1`, así `api/.env` **no** puede aportar la contraseña runtime
ni mezclar identidades; OPS pasa `DB_*` explícitos. En auth por **socket**,
`DB_PASSWORD` se fuerza **vacío** (sólo `unix_socket`).

## Verificación manual (opcional)
```bash
mysql --socket=/var/run/mysqld/mysqld.sock -uroot asistencia -N -B -e \
  "SELECT filename FROM schema_migrations WHERE filename LIKE '08%' ORDER BY filename;"
# Debe listar 080, 081, 082, 083 en ese orden.
```

## Invariantes
- El runtime de la API **no** ejecuta migraciones ni tiene `CREATE ROUTINE/TRIGGER`.
- Migración 083 **no activa** multiempresa ni el motor: writers/flags siguen en OFF.
- Aplicar el esquema ≠ activar FASE E (eso es otro paso con su propia autorización).
