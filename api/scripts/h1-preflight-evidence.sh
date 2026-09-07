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
#  - Imagen MySQL PINNEADA POR DIGEST (inmutable, no `mysql:8.0` mutable).
#  - SÓLO Docker LOCAL: aborta si hay DOCKER_HOST o un contexto no-default (remoto).
#  - `set -Eeuo pipefail` + `trap` de limpieza desde el inicio.
#  - Valida mecánicamente los 3 escenarios; cualquier desviación => exit != 0.
#  - guard_output valida CADA salida ANTES de imprimirla/publicarla; si detecta SQL,
#    hash bcrypt, la contraseña demo o el password descartable, ABORTA informando
#    SÓLO el tipo de fuga (nunca el valor) y sin reimprimir el contenido rechazado.
#  - `--selftest`: prueba negativa con un centinela que el guard debe rechazar
#    (exit != 0, sin filtrar el centinela). No requiere Docker.
#
# NUNCA correr contra producción ni att2000. No requiere variables externas.
set -Eeuo pipefail

# --- Identificadores internos, aislados (se ignora todo lo externo) ---------
unset DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME CID 2>/dev/null || true
NONCE="$(openssl rand -hex 6 2>/dev/null || printf '%s%s' "$$" "${RANDOM}${RANDOM}")"
CID="sishoras-h1ev-${NONCE}"
DB_NAME="h1ev_${NONCE}"
DB_PW="$(openssl rand -hex 16 2>/dev/null || printf 'pw%s%s' "$$" "${RANDOM}${RANDOM}")"
# Imagen fijada por DIGEST (tag versionada 8.0.40 + digest inmutable del manifest multi-arch).
MYSQL_IMAGE="mysql:8.0.40@sha256:d58ac93387f644e4e040c636b8f50494e78e5afc27ca0a87348b2f577da2b7ff"
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$API_DIR/.." && pwd)"

fail(){ echo "FALLO: $*" >&2; exit 1; }

# Sólo Docker LOCAL: nunca un daemon remoto (evita crear contenedores en otro host).
assert_local_docker(){
  [ -z "${DOCKER_HOST:-}" ] || fail "DOCKER_HOST está seteado ('${DOCKER_HOST}'): se exige Docker local"
  local ctx; ctx="$(docker context show 2>/dev/null || echo default)"
  [ "$ctx" = "default" ] || fail "contexto Docker no-default ('$ctx'): se exige Docker local"
}

# guard_output: valida un texto ANTES de que se imprima/publique. Si detecta la
# contraseña demo, un hash bcrypt, el password descartable o SQL, ABORTA e informa
# SÓLO el tipo de fuga — NUNCA el valor detectado ni el contenido rechazado.
# Silencioso en éxito (para poder llamarlo antes de cualquier echo/printf/sed).
guard_output(){ # $1=texto a validar
  local t="$1"
  printf '%s' "$t" | grep -q "Admin1234!"          && fail "fuga detectada (tipo: contraseña demo) — contenido NO impreso"
  printf '%s' "$t" | grep -q '\$2[aby]\$'          && fail "fuga detectada (tipo: hash bcrypt) — contenido NO impreso"
  printf '%s' "$t" | grep -Fq "$DB_PW"             && fail "fuga detectada (tipo: password descartable) — contenido NO impreso"
  printf '%s' "$t" | grep -qiE '\b(INSERT|UPDATE|DELETE|DROP|SELECT)[[:space:]]+' && fail "fuga detectada (tipo: SQL) — contenido NO impreso"
  return 0
}

# Prueba negativa (self-test): un CENTINELA que guard_output DEBE rechazar. Demuestra
# que el harness aborta (exit!=0) y que el centinela NO aparece en stdout ni stderr.
if [ "${1:-}" = "--selftest" ]; then
  SENTINEL='centinela-$2b$10$ZZZ-SQL SELECT-Admin1234!'   # incluye varios patrones que el guard bloquea
  set +e; ST_OUT="$( guard_output "linea con $SENTINEL" 2>&1 )"; ST_RC=$?; set -e
  [ "$ST_RC" -ne 0 ] || { echo "SELFTEST FALLO: guard_output no abortó ante el centinela"; exit 1; }
  if printf '%s' "$ST_OUT" | grep -Fq "$SENTINEL"; then echo "SELFTEST FALLO: el centinela apareció en la salida"; exit 1; fi
  echo "SELFTEST OK: guard abortó (exit=$ST_RC) informando sólo el tipo de fuga, sin filtrar el centinela"
  exit 0
fi
cleanup(){
  # Sólo eliminar SI la etiqueta del contenedor coincide con NUESTRO nonce.
  local lbl
  lbl="$(docker inspect -f '{{ index .Config.Labels "h1evidence" }}' "$CID" 2>/dev/null || true)"
  if [ "$lbl" = "$NONCE" ]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || fail "docker no disponible"
assert_local_docker

echo "== arrancando MySQL (pinneada por digest) efímero (nonce ${NONCE}) =="
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
# scenario: corre el checker, VALIDA la salida con guard_output ANTES de cualquier
# echo/printf/sed, y sólo entonces imprime (redactando el password) y valida exit+patrón.
scenario(){ # $1=nombre $2=exit_esperado $3=patrón
  local name="$1" want_exit="$2" pat="$3" out code
  set +e; out="$(run_checker)"; code=$?; set -e
  guard_output "$out"                              # <-- guard ANTES de imprimir; aborta sin reimprimir si hay fuga
  echo "--- $name (exit=$code) ---"
  printf '%s\n' "$out" | sed "s/${DB_PW}/<redacted>/g"
  [ "$code" = "$want_exit" ] || fail "$name: exit esperado $want_exit, obtenido $code"
  printf '%s' "$out" | grep -q "$pat" || fail "$name: no se encontró el patrón esperado '$pat'"
}

echo "== ESC1: admin demo activo (init.sql) =="
scenario "ESC1 DEFAULT_ADMIN_CREDENTIAL" 3 "BLOCKED: DEFAULT_ADMIN_CREDENTIAL"

echo "== ESC2: hash del admin ROTADO =="
NEWHASH="$(cd "$API_DIR" && node -e 'console.log(require("bcrypt").hashSync("Un4-Cl4v3-Fuerte-2026#",12))')" \
  || fail "generación de hash rotado"
mexec -e "UPDATE users SET password_hash='${NEWHASH}' WHERE username='admin';" "$DB_NAME" \
  || fail "UPDATE del hash rotado"
scenario "ESC2 RESULT ok" 0 '"ok":true'

echo "== ESC3: BD SIN tabla users =="
mexec -e "SET FOREIGN_KEY_CHECKS=0; DROP TABLE users; SET FOREIGN_KEY_CHECKS=1;" "$DB_NAME" \
  || fail "DROP TABLE users"
scenario "ESC3 DEFAULT_ADMIN_CHECK_UNAVAILABLE" 3 "BLOCKED: DEFAULT_ADMIN_CHECK_UNAVAILABLE"

echo "== OK: los 3 escenarios validados (cada salida pasó por guard_output ANTES de imprimirse) =="
echo "DONE"
