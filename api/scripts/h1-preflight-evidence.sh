#!/usr/bin/env bash
#
# h1-preflight-evidence.sh — reproduce la evidencia de H1 (#208) contra un
# MySQL 8 DESCARTABLE, usando el CHECKER real `preflight-mysql-check.js` y el
# esquema real `database/init.sql`. NUNCA correr contra producción ni att2000.
#
# Escenarios:
#   ESC1  init.sql tal cual (admin demo activo)  -> BLOCKED: DEFAULT_ADMIN_CREDENTIAL
#   ESC2  hash del admin ROTADO                   -> RESULT: {"checked":true,"ok":true}
#   ESC3  BD SIN tabla `users`                    -> BLOCKED: DEFAULT_ADMIN_CHECK_UNAVAILABLE
#
# Credenciales: SÓLO de un contenedor efímero DESCARTABLE (mismo patrón que el
# job de CI de #194). Sobreescribibles por entorno. No son secretos operativos.
set -u
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$API_DIR/.." && pwd)"
CID="${CID:-sishoras-h1-evidence}"
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-3307}" \
       DB_USER="${DB_USER:-root}" DB_PASSWORD="${DB_PASSWORD:-disposable_ci_pw}" \
       DB_NAME="${DB_NAME:-asistencia}"
MZ="mysql --protocol=TCP -h$DB_HOST -P$DB_PORT -u$DB_USER -p$DB_PASSWORD"
log(){ echo "== $* =="; }

docker rm -f "$CID" >/dev/null 2>&1
log "arrancando mysql:8.0 efímero"
docker run -d --name "$CID" -e MYSQL_ROOT_PASSWORD="$DB_PASSWORD" -e MYSQL_DATABASE="$DB_NAME" \
  -p 127.0.0.1:${DB_PORT}:3306 mysql:8.0 >/dev/null || { echo "FATAL: docker run"; exit 1; }
for i in $(seq 1 90); do $MZ -N -e "SELECT 1;" >/dev/null 2>&1 && break; sleep 2; done
sleep 3
$MZ -N -e "SELECT 1;" >/dev/null 2>&1 || { echo "FATAL: MySQL no responde"; docker rm -f "$CID" >/dev/null 2>&1; exit 1; }

log "cargando database/init.sql"
$MZ "$DB_NAME" < "$REPO_DIR/database/init.sql" 2>/dev/null

cd "$API_DIR"
echo; log "ESC1: admin demo activo (init.sql) -> se espera DEFAULT_ADMIN_CREDENTIAL"
node scripts/preflight-mysql-check.js; echo "exit=$?"

echo; log "ESC2: hash del admin rotado -> se espera RESULT ok"
NEWHASH="$(node -e 'console.log(require("bcrypt").hashSync("Un4-Cl4v3-Fuerte-2026#",12))')"
$MZ "$DB_NAME" -e "UPDATE users SET password_hash='$NEWHASH' WHERE username='admin';" 2>/dev/null
node scripts/preflight-mysql-check.js; echo "exit=$?"

echo; log "ESC3: BD sin tabla users -> se espera DEFAULT_ADMIN_CHECK_UNAVAILABLE (fail-closed)"
$MZ "$DB_NAME" -e "SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS users; SET FOREIGN_KEY_CHECKS=1;" 2>/dev/null
node scripts/preflight-mysql-check.js; echo "exit=$?"

echo; log "limpieza"; docker rm -f "$CID" >/dev/null 2>&1; echo "DONE"
