# Runbook de despliegue, migraciones y backup/restore — SisHoras

> **Alcance:** procedimiento operativo para levantar el stack, correr migraciones,
> respaldar y restaurar la BD. Complementa `deploy/DEPLOY.md` (instalación en host).
> **No** autoriza por sí solo tocar producción: cada acción sobre datos reales
> requiere autorización explícita del propietario. att2000 es **READ-ONLY**.
>
> **Estado de verificación (2026-09-08):** los archivos de este runbook y los fixes
> asociados (nginx del compose, imagen de migraciones, script de restore) se
> validaron por revisión estática y `bash -n`/lint de YAML. **El levantamiento
> real del stack y la prueba de restore NO se corrieron en esta sesión** (sin
> Docker en el entorno de trabajo): la sección §5 deja el procedimiento listo
> para que ops lo ejecute en un entorno descartable antes de prod.

## 0. Prerrequisitos
- Docker + Docker Compose v2 en el host.
- Variables de entorno / secretos provistos **fuera del repo** (ver `.env.example`
  de cada componente y del raíz). Nunca commitear valores.
- **Kill-switches en OFF** (fail-closed) al desplegar por primera vez:
  `ATT2000_AUTO_PULL_ENABLED=false`, `ZKTECO_AUTO_POLL=false`,
  `WORKDAY_CONFIG_WRITE_ENABLED=false`, `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED` (OFF).

## 1. Nginx: compose vs host
- **Stack de compose** (self-contained): usa `deploy/nginx.compose.conf`, montado por
  `docker-compose.yml` en `/etc/nginx/conf.d/default.conf`. Hace proxy a los **nombres
  de servicio** (`web:3000`, `api:4000`, `analytics:5000`). Es **HTTP-only**.
- **Producción con TLS**: el TLS lo termina el **nginx del host** con
  `deploy/nginx-sishoras.conf` (Let's Encrypt, proxy a `127.0.0.1`), o un balanceador
  delante del stack. Ver los pasos de certbot en el encabezado de ese archivo.
- *(Fix aplicado: antes el compose montaba `./nginx/` inexistente; por eso el servicio
  nginx no levantaba.)*

## 2. Levantar el stack
```bash
# Build + up (sin el perfil de herramientas: NO corre migraciones)
docker compose up -d --build

# Estado / logs
docker compose ps
docker compose logs -f api
```
El servicio `mysql` inicializa la BD con `database/init.sql` sólo en el **primer**
arranque (volumen `mysql_data` vacío).

## 3. Migraciones (imagen one-shot dedicada)
La imagen `Dockerfile.migrate` (contexto = raíz del repo) incluye el runner
`api/scripts/migrate.js`, las migraciones de `database/migrations/` y el cliente
`mysql`. Está en el profile `tools`, así que **no** corre en `up`.
```bash
# Ver estado (READ-ONLY, no aplica nada)
docker compose --profile tools run --rm migrate node scripts/migrate.js --status

# Aplicar pendientes (forward-only). SIEMPRE con backup previo (ver §4).
docker compose --profile tools run --rm migrate
```
- El runner tiene **guardia de monotonicidad y unicidad de número** (PR #212):
  aborta si hay una migración pendiente de número menor que el máximo aplicado o
  números duplicados. Para un orden decidido a propósito: `--allow-out-of-order`.
- **072–075 (FASE C/E) NO se aplican sin autorización** (gate NO-GO: backup +
  auditoría + OK del propietario). El runner las tomaría como pendientes: revisar
  `--status` antes de aplicar y acotar si corresponde.
- Migraciones **forward-only** (sin `down`): el rollback de datos es el restore (§5).

## 4. Backup
`scripts/backup-mysql.sh` (mysqldump `--single-transaction` → gzip, verifica integridad,
purga > RETENTION_DAYS). Correr en el **host** con acceso al mysql del stack:
```bash
DB_NAME=asistencia BACKUP_DIR=/var/backups/sishoras \
  DB_PASSWORD=... ./scripts/backup-mysql.sh
```
Cron sugerido (diario 02:00):
```
0 2 * * * DB_PASSWORD=... /ruta/Gestion_Horas/scripts/backup-mysql.sh >> /var/log/sishoras-backup.log 2>&1
```
> Nota: el dump es de la base sola (sin `CREATE DATABASE`). El restore asume que la
> base destino existe.

## 5. Restore (DESTRUCTIVO) + validación
`scripts/restore-mysql.sh` restaura un `.sql.gz`. Verifica el gzip antes de tocar la
base y exige confirmación (tipear el nombre de la base) salvo `--yes`.
```bash
DB_PASSWORD=... ./scripts/restore-mysql.sh /var/backups/sishoras/asistencia_2026-09-08.sql.gz
```

### 5.1 Validar el restore en un entorno DESCARTABLE (antes de confiar en él)
**Pendiente de ejecutar por ops** (no se corrió en esta sesión). Procedimiento en MySQL 8 efímero:
```bash
# 1. Levantar un mysql descartable
docker run -d --name restore-test -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=asistencia -p 127.0.0.1:3399:3306 mysql:8.0
# esperar readiness (SELECT 1 autenticado en bucle)

# 2. Restaurar un backup real sobre la base vacía
DB_HOST=127.0.0.1 DB_PORT=3399 DB_USER=root DB_PASSWORD=test DB_NAME=asistencia \
  ./scripts/restore-mysql.sh <backup>.sql.gz --yes

# 3. Verificar
docker exec restore-test mysql -uroot -ptest asistencia \
  -e "SELECT COUNT(*) FROM employees; SELECT COUNT(*) FROM schema_migrations;"
# (desde api/) DB_HOST=127.0.0.1 DB_PORT=3399 DB_USER=root DB_PASSWORD=test \
#   npm run migrate:status   # la cadena de migraciones debe verse coherente

# 4. Limpiar
docker rm -f restore-test
```
Registrar el resultado (filas, tiempo, RPO/RTO observados) al cerrar el gate de backup.

## 6. Rollback de un despliegue
- **Código:** `git` (revert del merge) + `docker compose up -d --build`.
- **Datos:** restore del último backup válido (§5). No hay `down` de migraciones.
- **Nginx:** el host mantiene su config; el stack se puede bajar con
  `docker compose down` sin afectar datos (volúmenes `mysql_data`/`redis_data` persisten).

## 7. Checklist previo a exponer a usuarios
- [ ] Secretos provistos por entorno; ningún valor en el repo.
- [ ] Kill-switches en OFF (§0).
- [ ] `migrate --status` revisado; migraciones aplicadas con backup previo.
- [ ] Backup diario en cron y **restore validado** en descartable (§5.1).
- [ ] TLS terminado (host nginx / balanceador); headers de seguridad activos.
- [ ] Smoke: login, dashboard, asistencia, un reporte.
