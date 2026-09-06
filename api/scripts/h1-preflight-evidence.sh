#!/usr/bin/env bash
#
# h1-preflight-evidence.sh — reproduce la evidencia de H1 (#208) contra un
# MySQL 8 DESCARTABLE Y AISLADO, usando el checker real
# `api/scripts/preflight-mysql-check.js` y el esquema real `database/init.sql`.
#
# GARANTÍAS DE AISLAMIENTO (nunca toca infraestructura existente):
#  - Ignora cualquier DB_HOST/DB_NAME/DB_USER/DB_PORT/CID del entorno: genera
#    contenedor, base, puerto y password ÚNICOS y aleatorios por corrida.
#  - El contenedor lleva una etiqueta con un nonce; la limpieza SÓLO elimina un
#    contenedor cuya etiqueta coincide con ESTE nonce.
#  - Todas las consultas administrativas van por `docker exec` (sin salir a red).
#    La ÚNICA conexión TCP es la del checker Node (mysql2) al puerto loopback del
#    propio contenedor descartable — es justo el camino que se quiere validar.
#  - Imagen MySQL PINNEADA (no `mysql:8.0` mutable).
#  - `set -Eeuo pipefail` + `trap` de limpieza desde el inicio.
#  - Valida mecánicamente los 3 escenarios; cualquier desviación => exit != 0.
#
# NUNCA correr contra producción ni att2000. No requiere variables externas.
set -Eeuo pipefail

# --- Identificadores internos, aislados (se ignora todo lo externo) ---------
unset DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME CID 2>/dev/null || true
NONCE="$(openssl rand -hex 6 2>/dev/null || printf '%s%s' "$$" "${RANDOM}${RANDOM}")"
CID="sishoras-h1ev-${NONCE}"
DB_NAME="h1ev_${NONCE}"
DB_PW="$(openssl rand -hex 16 2>/dev/null || printf 'pw%s%s' "$$" "${RANDOM}${RANDOM}")"
MYSQL_IMAGE="mysql:8.0.40"          # pinneada (no mutable)
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$API_DIR/.." && pwd)"

fail(){ echo "FALLO: $*" >&2; exit 1; }
cleanup(){
  # Sólo eliminar SI la etiqueta del contenedor coincide con NUESTRO nonce.
  local lbl
  lbl="$(docker inspect -f '{{ index .Config.Labels "h1evidence" }}' "$CID" 2>/dev/null || true)"
  if [ "$lbl" = "$NONCE" ]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || fail "docker no disponible"

echo "== arrancando ${MYSQL_IMAGE} efímero (nonce ${NONCE}) =="
docker run -d --name "$CID" --label "h1evidence=${NONCE}" \
  -e MYSQL_ROOT_PASSWORD="$DB_PW" -e MYSQL_DATABASE="$DB_NAME" \
  -p 127.0.0.1:0:3306 "$MYSQL_IMAGE" >/dev/null \
  || fail "docker run"

# Puerto loopback asignado dinámicamente (exclusivo de este contenedor)
HOST_PORT="$(docker port "$CID" 3306/tcp | sed -n 's/.*:\([0-9]\{1,5\}\)$/\1/p' | head -1)"
[ -n "${HOST_PORT:-}" ] || fail "no se pudo determinar el puerto publicado"

# Helper: consultas admin SIEMPRE por docker exec (sin red), password por env.
mexec(){ docker exec -e MYSQL_PWD="$DB_PW" -i "$CID" mysql -uroot --batch --raw "$@"; }

echo "== esperando readiness (query AUTENTICADA a la base propia, por docker exec) =="
# `mysqladmin ping` reporta "alive" ya en el server temporal de init (antes de
# fijar el password real), así que NO sirve de gate. Se espera a que una query
# autenticada contra NUESTRA base tenga éxito: eso garantiza el server real.
ready=""
for _ in $(seq 1 120); do
  if mexec -e "SELECT 1;" "$DB_NAME" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { docker logs "$CID" 2>&1 | tail -20 >&2; fail "MySQL no alcanzó readiness autenticada en $DB_NAME"; }

echo "== cargando database/init.sql (por docker exec) =="
docker exec -e MYSQL_PWD="$DB_PW" -i "$CID" mysql -uroot "$DB_NAME" < "$REPO_DIR/database/init.sql" \
  || fail "carga de init.sql"

# --- checker Node: única conexión TCP, al contenedor descartable -------------
run_checker(){ # imprime salida combinada; devuelve exit del checker
  ( cd "$API_DIR" && DB_HOST=127.0.0.1 DB_PORT="$HOST_PORT" DB_USER=root \
      DB_PASSWORD="$DB_PW" DB_NAME="$DB_NAME" node scripts/preflight-mysql-check.js ) 2>&1
}
assert(){ # $1=nombre $2=exit_esperado $3=patrón $4=salida $5=exit_real
  local name="$1" want_exit="$2" pat="$3" out="$4" got_exit="$5"
  echo "--- $name (exit=$got_exit) ---"
  # Sanitizar: nunca imprimir el password del contenedor descartable.
  echo "$out" | sed "s/${DB_PW}/<redacted>/g"
  [ "$got_exit" = "$want_exit" ] || fail "$name: exit esperado $want_exit, obtenido $got_exit"
  echo "$out" | grep -q "$pat" || fail "$name: no se encontró el patrón esperado '$pat'"
}

echo "== ESC1: admin demo activo (init.sql) =="
set +e; OUT1="$(run_checker)"; C1=$?; set -e
assert "ESC1 DEFAULT_ADMIN_CREDENTIAL" 3 "BLOCKED: DEFAULT_ADMIN_CREDENTIAL" "$OUT1" "$C1"

echo "== ESC2: hash del admin ROTADO =="
NEWHASH="$(cd "$API_DIR" && node -e 'console.log(require("bcrypt").hashSync("Un4-Cl4v3-Fuerte-2026#",12))')" \
  || fail "generación de hash rotado"
mexec -e "UPDATE users SET password_hash='${NEWHASH}' WHERE username='admin';" "$DB_NAME" \
  || fail "UPDATE del hash rotado"
set +e; OUT2="$(run_checker)"; C2=$?; set -e
assert "ESC2 RESULT ok" 0 '"ok":true' "$OUT2" "$C2"

echo "== ESC3: BD SIN tabla users =="
mexec -e "SET FOREIGN_KEY_CHECKS=0; DROP TABLE users; SET FOREIGN_KEY_CHECKS=1;" "$DB_NAME" \
  || fail "DROP TABLE users"
set +e; OUT3="$(run_checker)"; C3=$?; set -e
assert "ESC3 DEFAULT_ADMIN_CHECK_UNAVAILABLE" 3 "BLOCKED: DEFAULT_ADMIN_CHECK_UNAVAILABLE" "$OUT3" "$C3"

echo "== OK: los 3 escenarios validados mecánicamente =="
echo "DONE"
