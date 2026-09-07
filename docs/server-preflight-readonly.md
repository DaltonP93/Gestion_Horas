# Runbook — preflight READ-ONLY del servidor (lo ejecuta el DUEÑO)

> **Propósito:** relevar el estado del servidor **sin cambiarlo**. Todos los comandos son de
> **sólo lectura**. Este runbook lo ejecuta **el dueño** en el servidor; el agente **no** lo corre.
>
> **PROHIBIDO en este preflight:** `git pull`/`fetch`/`checkout`, `pm2 restart/reload/stop`,
> reinicios de servicio, migraciones (`npm run migrate`), **cualquier** `INSERT/UPDATE/DELETE`,
> cambios de flags/env, y pruebas con relojes ZKTeco. Nada de escrituras en `att2000`.
>
> **Secretos:** no imprimir valores de secretos. Los flags se derivan del **`pm2_env` del proceso**
> (no de la sesión SSH) y se reportan sólo como `true/false/unset`; los secretos sólo como `SET/MISSING`.

## 0. Proteger APP_DIR (abortar si no está bien configurado)
```bash
APP_DIR="__COMPLETAR__"        # <-- reemplazar por la ruta ABSOLUTA del despliegue
case "$APP_DIR" in
  __COMPLETAR__|"") echo "FALLO: reemplazá APP_DIR por la ruta real"; return 2>/dev/null || exit 1;;
  /*) : ;;                                   # debe ser absoluta
  *) echo "FALLO: APP_DIR debe ser ABSOLUTA"; return 2>/dev/null || exit 1;;
esac
[ -d "$APP_DIR" ] || { echo "FALLO: APP_DIR no existe"; return 2>/dev/null || exit 1; }
git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "FALLO: APP_DIR no es un repo git"; return 2>/dev/null || exit 1; }
git -C "$APP_DIR" remote get-url origin 2>/dev/null | grep -q "Gestion_Horas" \
  || { echo "FALLO: el origin no es el repo esperado (Gestion_Horas)"; return 2>/dev/null || exit 1; }
cd "$APP_DIR" || { echo "FALLO: no se pudo entrar a APP_DIR"; return 2>/dev/null || exit 1; }
echo "OK: APP_DIR verificado ($APP_DIR)"
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
pm2 jlist | node -e '
const d=require("fs").readFileSync(0,"utf8");let l;try{l=JSON.parse(d)}catch(e){console.error("no-json");process.exit(0)}
for(const p of l){console.log((p.name||"?")+"  "+((p.pm2_env&&p.pm2_env.status)||"?"))}'   # nombre+estado, sin secretos
ss -ltnp 2>/dev/null | grep -E ':(3000|4000|5000|8080|8081)\b' || sudo ss -ltnp | grep -E ':(3000|4000|5000|8080|8081)\b'
systemctl is-active nginx 2>/dev/null || true
```

## 3. Versiones Node / MySQL
```bash
node -v ; npm -v ; mysql --version           # cliente mysql
# Versión del SERVIDOR MySQL (SÓLO lectura). Credenciales de sólo lectura del entorno; nunca en claro.
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -e "SELECT VERSION();"   # requiere DB_* del entorno
```

## 4. Espacio y memoria
```bash
df -h "$APP_DIR" / ; free -h ; uptime
```

## 5. Backups (estado y fecha del último) — sin restaurar
```bash
BACKUP_DIR="__COMPLETAR__"                    # <-- destino real de scripts/backup-mysql.sh
[ -d "$BACKUP_DIR" ] && ls -lt "$BACKUP_DIR" | head -5 || echo "REVISAR: BACKUP_DIR inexistente/omitido"
```
> **restore NO probado**, RPO/RTO indefinidos (`docs/BACKUP_RESTORE.md`). Sólo se confirma existencia y fecha.

## 6. Flags / secretos — desde el `pm2_env` del PROCESO (no la sesión), sólo estado
```bash
# Ajustar al nombre EXACTO del proceso PM2 de la API (o Bridge). Falla si no es único.
API_PROC="${API_PROC:-api}"
pm2 jlist > /tmp/pm2_snapshot.json 2>/dev/null || { echo "FALLO: pm2 jlist"; }
node -e '
const fs=require("fs");
const name=process.argv[1];
const flags=["ATT2000_AUTO_PULL_ENABLED","ZKTECO_AUTO_POLL","WORKDAY_CONFIG_WRITE_ENABLED","WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED"];
const secrets=["JWT_SECRET","JWT_REFRESH_SECRET","DB_PASSWORD","ATT_PASSWORD"];
let list; try{list=JSON.parse(fs.readFileSync("/tmp/pm2_snapshot.json","utf8"))}catch(e){console.error("FALLO: pm2 json ilegible");process.exit(1)}
const m=list.filter(p=>p&&p.name===name);
if(m.length!==1){console.error("FALLO: proceso PM2 \""+name+"\" no identificado unívocamente (encontrados: "+m.length+")");process.exit(2)}
const env=(m[0].pm2_env)||{};
// Flags: sólo true/false/unset (fail-closed: sólo el literal exacto "true" habilita).
for(const k of flags){const v=env[k];
  const s=(v===undefined||v===null||v==="")?"unset(=>false)":(String(v)==="true"?"true (HABILITADO)":"false");
  console.log(k+"="+s);}
// Secretos: sólo presencia, nunca el valor.
for(const k of secrets){const v=env[k];console.log(k+"="+((v===undefined||v===null||v==="")?"MISSING":"SET"));}
' "$API_PROC"
rm -f /tmp/pm2_snapshot.json
```
> Se espera todos los flags en **false/unset** (fail-closed). Cualquier `true` es hallazgo a revisar con el dueño.
> Si el proceso no se identifica unívocamente, el script **falla** (no adivina).

## 7. att2000 READ-ONLY — inspección ESTÁTICA **orientativa** (NO prueba permisos efectivos)
```bash
# (a) grep CASE-INSENSITIVE de símbolos de escritura (orientativo, no prueba de permisos):
grep -RInEi "writeCheckinOut|ATT2000_WRITE_ENABLED" api/src config 2>/dev/null \
  && echo "REVISAR: aparece un símbolo de escritura" || echo "orientativo: sin writeCheckinOut/ATT2000_WRITE_ENABLED"
grep -RInEi "(INSERT|UPDATE|DELETE)[[:space:]].*CHECKINOUT" api/src 2>/dev/null \
  && echo "REVISAR: aparece DML sobre CHECKINOUT" || echo "orientativo: sin DML sobre CHECKINOUT"
# (b) EJECUTAR el test que fija el contrato read-only (no basta con que exista el archivo):
if [ -d api/node_modules ]; then ( cd api && npx jest att2000Readonly 2>&1 | tail -6 ); \
  else echo "REVISAR: api/node_modules ausente; no se pudo correr att2000Readonly.test.js"; fi
# (c) Permisos EFECTIVOS en la fuente:
echo "UNVERIFIED_DB_PERMISSIONS: sin una conexión autorizada de sólo lectura a att2000, los permisos"
echo "efectivos NO se verifican desde este preflight (esta sección es estática y orientativa)."
```

## Qué reportar (sanitizado)
HEAD/rama; tabla PM2 (nombre+estado); versiones Node/MySQL; `df`/`free`; fecha del último backup;
flags en `true/false/unset` y secretos en `SET/MISSING` (del `pm2_env`); resultado de la inspección
estática de att2000 + `UNVERIFIED_DB_PERMISSIONS`. **Sin** valores de secretos, IPs internas, hosts ni PII.
```
