# Runbook — preflight READ-ONLY del servidor (lo ejecuta el DUEÑO)

> **Propósito:** relevar el estado del servidor **sin cambiarlo**. Todos los comandos son de
> **sólo lectura**. Este runbook lo ejecuta **el dueño** en el servidor; el agente **no** lo corre.
>
> **PROHIBIDO en este preflight:** `git pull`/`fetch`/`checkout`, `pm2 restart/reload/stop`,
> reinicios de servicio, migraciones (`npm run migrate`), **cualquier** `INSERT/UPDATE/DELETE`,
> cambios de flags/env, y pruebas con relojes ZKTeco. Nada de escrituras en `att2000`.
>
> **Secretos:** no imprimir valores de secretos. Las variables se reportan sólo como
> `true/false/unset`. Si algún comando pidiera una contraseña, usar credenciales de **sólo lectura**
> del entorno; nunca pegar secretos en la terminal compartida ni en el reporte.

Ajustar `APP_DIR` a la ruta real del despliegue antes de empezar:

```bash
APP_DIR=/ruta/al/despliegue    # <-- completar
cd "$APP_DIR"
```

## 1. HEAD / rama desplegada (read-only, sin fetch)
```bash
git rev-parse HEAD
git branch --show-current
git log -1 --oneline
git status -sb        # ¿working tree limpio? (no modificar nada)
```

## 2. Estado PM2 y servicios
```bash
pm2 status
pm2 jlist | grep -Eo '"name":"[^"]+"|"status":"[^"]+"' | paste - -   # nombre+estado, sin secretos
# Puertos escuchando (api 4000 / web 3000 / analytics 5000 / bridge 8080-8081):
ss -ltnp 2>/dev/null | grep -E ':(3000|4000|5000|8080|8081)\b' || sudo ss -ltnp | grep -E ':(3000|4000|5000|8080|8081)\b'
systemctl is-active nginx 2>/dev/null || true
```

## 3. Versiones Node / MySQL
```bash
node -v
npm -v
mysql --version                         # versión del CLIENTE mysql
# Versión del SERVIDOR MySQL (SÓLO lectura). Usar credenciales de sólo lectura del entorno.
# No escribir la contraseña en claro: exportarla fuera del historial o usar ~/.my.cnf.
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -e "SELECT VERSION();"   # requiere DB_* en el entorno
```

## 4. Espacio y memoria
```bash
df -h "$APP_DIR" /
free -h
uptime
```

## 5. Backups (estado y fecha del último) — sin restaurar
```bash
# Ajustar BACKUP_DIR al destino real de scripts/backup-mysql.sh
BACKUP_DIR=/ruta/a/backups            # <-- completar
ls -lt "$BACKUP_DIR" 2>/dev/null | head -5    # el más reciente arriba (fecha = última corrida)
du -sh "$BACKUP_DIR" 2>/dev/null || true
```
> **Nota:** el **restore NO está probado** y RPO/RTO están indefinidos (ver `docs/BACKUP_RESTORE.md`).
> Este preflight sólo confirma que existen backups y su fecha; **no** ejecuta ni valida un restore.

## 6. Flags / kill-switches — SÓLO `true/false/unset` (nunca el valor)
```bash
# Reporta el estado booleano de cada kill-switch sin exponer ningún secreto.
# Semántica fail-closed: SÓLO el literal exacto "true" habilita; cualquier otra cosa = OFF.
for f in ATT2000_AUTO_PULL_ENABLED ZKTECO_AUTO_POLL \
         WORKDAY_CONFIG_WRITE_ENABLED WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED; do
  v="${!f-__UNSET__}"
  if   [ "$v" = "__UNSET__" ]; then echo "$f=unset(=>false)"
  elif [ "$v" = "true" ];     then echo "$f=true  (HABILITADO)"
  else                              echo "$f=false"
  fi
done
# Presencia (no valor) de secretos requeridos:
for s in JWT_SECRET JWT_REFRESH_SECRET DB_PASSWORD ATT_PASSWORD; do
  [ -n "${!s-}" ] && echo "$s=SET" || echo "$s=MISSING"
done
```
> Se espera: `ATT2000_AUTO_PULL_ENABLED`, `ZKTECO_AUTO_POLL`, `WORKDAY_CONFIG_WRITE_ENABLED`,
> `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED` en **false/unset** (fail-closed). Cualquier `true`
> es un hallazgo a revisar con el dueño antes de continuar.

## 7. Confirmar que att2000 sigue READ-ONLY (verificación estática, sin tocar la fuente)
```bash
# (a) No existe camino de escritura a la fuente SQL Server att2000:
grep -RInE "writeCheckinOut|ATT2000_WRITE_ENABLED" api/src config 2>/dev/null || echo "OK: sin writeCheckinOut ni ATT2000_WRITE_ENABLED"
grep -RInE "(INSERT|UPDATE|DELETE)\b[^;]*CHECKINOUT" api/src 2>/dev/null || echo "OK: sin INSERT/UPDATE/DELETE sobre CHECKINOUT"
# (b) El conector usa variables ATT_* (fuente read-only):
grep -RInE "ATT_(HOST|PORT|USER|PASSWORD|DATABASE)" api/src/config 2>/dev/null | grep -v PASSWORD= | head
# (c) La prueba que fija el contrato read-only existe:
ls api/tests/att2000Readonly.test.js && echo "OK: test de read-only presente"
```
> Estas comprobaciones son **estáticas** sobre el código desplegado. **No** se conecta a `att2000`
> ni se ejecuta ninguna consulta contra la fuente.

## Qué reportar (sanitizado)
HEAD/rama; tabla PM2 (nombre+estado); versiones Node/MySQL; `df`/`free`; fecha del último backup;
tabla de flags en `true/false/unset`; resultado de las 3 verificaciones de att2000. **Sin** valores de
secretos, IPs internas, hosts ni PII.
```
