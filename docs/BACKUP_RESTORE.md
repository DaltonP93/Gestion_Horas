# Backup, restauración y monitoreo — SisHoras

> Actualizado: 2026-09-23. Este documento describe controles operativos.
> No autoriza por sí mismo cambios de producción, restauraciones ni secretos.

## Objetivo

Mantener un respaldo MySQL recuperable y detectar una degradación antes de que
se convierta en pérdida de asistencia. ATT2000 continúa estrictamente READ-ONLY:
ninguno de estos scripts consulta o escribe esa fuente.

## Invariantes

- Las claves MySQL viven fuera del repositorio, en un option file root:root 0600.
- Nunca se pasan passwords por argumentos ni se imprimen en logs.
- El backup se escribe como temporal y sólo se publica tras gzip, tamaño y SHA-256.
- flock impide dos backups simultáneos.
- La retención sólo elimina archivos antiguos que aún validan gzip y checksum.
- Un restore sobre cualquier base declarada en PRODUCTION_DATABASES falla salvo doble autorización.
- El drill usa otro mysqld, sin red, con datadir y socket temporales.
- El drill elimina el datadir efímero al terminar, tanto en éxito como en fallo.

## Componentes

| Archivo | Función |
|---|---|
| scripts/backup-mysql.sh | Dump atómico, compresión, checksum y retención |
| scripts/restore-mysql.sh | Restore explícito con checksum y guards de destino |
| scripts/restore-drill-mysql.sh | Restore real sobre MySQL efímero sin red |
| scripts/check-production-health.sh | PM2, HTTP, autenticación y frescura del backup |
| deploy/systemd/sishoras-backup.* | Backup periódico |
| deploy/systemd/sishoras-healthcheck.* | Gate de salud periódico |
| scripts/tests/ops-scripts.test.sh | Contratos fail-closed ejecutados en CI |

## Objetivos operativos propuestos

- Frecuencia de backup: cada 6 horas, con demora aleatoria máxima de 10 minutos.
- RPO técnico máximo: 8 horas; el health-check falla al superar ese umbral.
- Retención local: 30 días.
- Health-check: cada 5 minutos.
- RTO: medir y aprobar contra un backup representativo antes de activar.
- Restore: exigir tablas críticas, migraciones, mysqlcheck y red deshabilitada.

La prueba aislada ya pasó; sus métricas, nombres y rutas quedan en un reporte
0600 fuera del repositorio público. Activar los defaults requiere aprobación
operativa. La copia off-site sigue pendiente y es necesaria para pérdida total
del host.

## Preparación segura de credenciales

Crear el directorio fuera del repositorio:

```bash
install -d -o root -g root -m 0700 /etc/sishoras
install -o root -g root -m 0600 \
  deploy/systemd/mysql-backup.cnf.example \
  /etc/sishoras/mysql-backup.cnf
install -o root -g root -m 0600 \
  deploy/systemd/backup.env.example \
  /etc/sishoras/backup.env
install -o root -g root -m 0600 \
  deploy/systemd/health.env.example \
  /etc/sishoras/health.env
```

Sustituir los placeholders de mysql-backup.cnf localmente. No usar la línea de
comandos, tickets, commits ni logs para transportar esos valores. Antes de
seguir, exigir propietario root y modo 0600.

## Instalación de scripts

Copiar desde un commit aprobado y conservar su SHA como evidencia:

```bash
install -d -o root -g root -m 0755 /usr/local/libexec/sishoras
install -o root -g root -m 0750 scripts/backup-mysql.sh \
  /usr/local/libexec/sishoras/backup-mysql.sh
install -o root -g root -m 0750 scripts/check-production-health.sh \
  /usr/local/libexec/sishoras/check-production-health.sh
install -o root -g root -m 0750 scripts/restore-mysql.sh \
  /usr/local/libexec/sishoras/restore-mysql.sh
install -o root -g root -m 0750 scripts/restore-drill-mysql.sh \
  /usr/local/libexec/sishoras/restore-drill-mysql.sh
install -d -o root -g root -m 0755 /usr/local/share/doc/sishoras
install -o root -g root -m 0644 docs/BACKUP_RESTORE.md \
  /usr/local/share/doc/sishoras/BACKUP_RESTORE.md
```

## Gate previo a activar timers

1. Ejecutar manualmente sishoras-backup.service.
2. Exigir un .sql.gz no vacío y su .sha256.
3. Ejecutar gzip -t y sha256sum -c desde el directorio del backup.
4. Ejecutar un restore drill del archivo recién creado.
5. Confirmar tablas críticas, mysqlcheck y reporte PASS.
6. Ejecutar el health-check con CHECK_BACKUP=1.
7. Sólo entonces habilitar los timers.

Ejemplo del drill manual:

```bash
sudo DRILL_ROOT=<PRIVATE_DRILL_PATH> REPORT_DIR=<PRIVATE_REPORT_PATH> \
  /usr/local/libexec/sishoras/restore-drill-mysql.sh \
  <PRIVATE_BACKUP_PATH>/<BACKUP_FILE>.sql.gz
```

El script inicia un mysqld con --skip-networking y socket privado. No abre
puertos, no usa credenciales productivas y no conecta con la instancia activa.

## Instalación de systemd

```bash
install -o root -g root -m 0644 deploy/systemd/sishoras-backup.service \
  deploy/systemd/sishoras-backup.timer \
  deploy/systemd/sishoras-healthcheck.service \
  deploy/systemd/sishoras-healthcheck.timer \
  /etc/systemd/system/
systemctl daemon-reload
systemctl start sishoras-backup.service
systemctl start sishoras-healthcheck.service
systemctl enable --now sishoras-backup.timer sishoras-healthcheck.timer
```

No habilitar los timers si cualquiera de los dos servicios manuales falla.

## Verificación cotidiana

```bash
systemctl status sishoras-backup.timer sishoras-healthcheck.timer
systemctl list-timers --all | grep sishoras
journalctl -u sishoras-backup.service --since today
journalctl -u sishoras-healthcheck.service --since today
```

El health-check valida el conjunto PM2 configurado sobre una sola release,
endpoints internos, rechazo sin credencial del endpoint protegido y backup
dentro del RPO. Nombres, URLs, puertos y rutas se configuran fuera del
repositorio; la URL externa es opcional.

## Restore productivo

restore-mysql.sh no tiene DB_NAME ni PRODUCTION_DATABASES por defecto. En modo
manual exige declarar las bases protegidas y aplica dos barreras adicionales
cuando el destino coincide:

- ALLOW_PRODUCTION_RESTORE=I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION
- RESTORE_CONFIRMATION=RESTORE:<PROTECTED_DB>

Antes de usarlas se debe detener toda escritura, capturar un backup del estado
dañado, identificar el archivo exacto y aprobar un runbook específico. Nombres
reales y credenciales permanecen fuera del repositorio. Este PR no ejecuta ni
automatiza restauraciones productivas.

## Rollback operativo

Si un timer genera carga o falsos positivos:

```bash
systemctl disable --now sishoras-backup.timer sishoras-healthcheck.timer
```

Conservar backups y reportes. La desactivación del timer no requiere eliminar
credenciales ni evidencia. Corregir, ejecutar ambos servicios manualmente y
habilitar de nuevo sólo tras un gate exitoso.

## Pendientes explícitos

- Copia off-site cifrada y prueba de recuperación desde otro host.
- Destino de alertas para fallos de systemd.
- Política del outbox SQLite del bridge.
- Proteger main con PR obligatorio, checks requeridos y al menos una revisión.
- Corregir a 0600 cualquier .env operativo que sea legible por grupo u otros.
