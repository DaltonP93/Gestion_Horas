#!/usr/bin/env bash
#
# migration-order-sim.sh — evidencia P1-C (#206): con el runner REAL
# `api/scripts/migrate.js` demuestra el comportamiento NO monotónico del runner
# y que 081/082 pueden aplicarse antes que las MENORES 076-080 en un esquema
# SINTÉTICO, de forma idempotente para 076-082. MySQL 8 DESCARTABLE Y AISLADO.
#
# LO QUE NO PRUEBA (honesto): 083 NO es SQL-safe aquí — falla por ausencia de
# `system_settings` (tabla del ORM). #202/083 sigue NO-GO hasta una prueba
# independiente correcta. Los stubs NO equivalen a un replay integral de 002-075.
#
# GARANTÍAS DE AISLAMIENTO:
#  - Ignora DB_*/CID del entorno; genera contenedor/base/puerto/password únicos (nonce).
#  - Etiqueta con nonce; limpieza SÓLO si la etiqueta coincide (nunca por nombre fijo).
#  - Consultas administrativas por `docker exec` (sin red). El runner Node usa el
#    puerto loopback del propio contenedor (camino real del runner).
#  - Imagen pinneada mysql:8.0.40. `set -Eeuo pipefail` + `trap` desde el inicio.
#  - Valida mecánicamente el set aplicado/pendiente, los conteos y la FK; cualquier
#    diferencia respecto de lo esperado aborta con exit != 0.
#
# NUNCA producción/att2000. Las migraciones 076-083 se extraen por SHA de HEAD de PR:
#   076-080 #161 807f82a ; 081 #198 272a739 ; 082 #201 bf8b583 ; 083 #202 6254f77
set -Eeuo pipefail

unset DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME CID 2>/dev/null || true
NONCE="$(openssl rand -hex 6 2>/dev/null || printf '%s%s' "$$" "${RANDOM}${RANDOM}")"
CID="sishoras-migord-${NONCE}"
DB_NAME="migord_${NONCE}"
DB_PW="$(openssl rand -hex 16 2>/dev/null || printf 'pw%s%s' "$$" "${RANDOM}${RANDOM}")"
# Imagen fijada por DIGEST (tag versionada 8.0.40 + digest inmutable del manifest multi-arch).
MYSQL_IMAGE="mysql:8.0.40@sha256:d58ac93387f644e4e040c636b8f50494e78e5afc27ca0a87348b2f577da2b7ff"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; SIM="$WORK/sim"

fail(){ echo "FALLO: $*" >&2; exit 1; }
cleanup(){
  local lbl
  lbl="$(docker inspect -f '{{ index .Config.Labels "migordevidence" }}' "$CID" 2>/dev/null || true)"
  [ "$lbl" = "$NONCE" ] && docker rm -f "$CID" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Sólo Docker LOCAL: nunca un daemon remoto.
assert_local_docker(){
  [ -z "${DOCKER_HOST:-}" ] || fail "DOCKER_HOST está seteado ('${DOCKER_HOST}'): se exige Docker local"
  local ctx; ctx="$(docker context show 2>/dev/null || echo default)"
  [ "$ctx" = "default" ] || fail "contexto Docker no-default ('$ctx'): se exige Docker local"
}

command -v docker >/dev/null || fail "docker no disponible"
command -v mysql  >/dev/null || fail "cliente mysql no disponible (lo usa migrate.js)"
assert_local_docker

# --- extraer migraciones 076-083 por SHA (sólo lectura de refs) --------------
declare -A SHA=( [161]=807f82a83f11f019d1297154abb01d2d9f901499
                 [198]=272a739dd81be2186000573bb0480f204c89e0c6
                 [201]=bf8b583eef5c33fdb61bbadead8700a6582b0bf2
                 [202]=6254f778a34df01cad1188d5896814da0d7ba390 )
echo "== fetch de HEAD de PR con migraciones 076-083 =="
git -C "$REPO_DIR" fetch -q origin "${SHA[161]}" "${SHA[198]}" "${SHA[201]}" "${SHA[202]}" \
  || fail "git fetch de los HEAD de PR"
mkdir -p "$WORK/migs" "$SIM/api/scripts" "$SIM/database/migrations"
for f in 076_governance_companies_cost_centers 077_audit_correlation_id \
         078_people_candidates_assignments 079_labor_calendars 080_payroll_base; do
  git -C "$REPO_DIR" show "${SHA[161]}:database/migrations/$f.sql" > "$WORK/migs/$f.sql" || fail "show $f"
done
git -C "$REPO_DIR" show "${SHA[198]}:database/migrations/081_monthly_report_approvals.sql"    > "$WORK/migs/081_monthly_report_approvals.sql"    || fail "show 081"
git -C "$REPO_DIR" show "${SHA[201]}:database/migrations/082_monthly_report_pades_metadata.sql" > "$WORK/migs/082_monthly_report_pades_metadata.sql" || fail "show 082"
git -C "$REPO_DIR" show "${SHA[202]}:database/migrations/083_fase_e_activation_console.sql"     > "$WORK/migs/083_fase_e_activation_console.sql"     || fail "show 083"
cp "$REPO_DIR/api/scripts/migrate.js" "$SIM/api/scripts/migrate.js" || fail "copiar migrate.js"

# --- contenedor MySQL aislado ------------------------------------------------
echo "== arrancando ${MYSQL_IMAGE} efímero (nonce ${NONCE}) =="
docker run -d --name "$CID" --label "migordevidence=${NONCE}" \
  -e MYSQL_ROOT_PASSWORD="$DB_PW" -e MYSQL_DATABASE="$DB_NAME" \
  -p 127.0.0.1:0:3306 "$MYSQL_IMAGE" >/dev/null || fail "docker run"
HOST_PORT="$(docker port "$CID" 3306/tcp | sed -n 's/.*:\([0-9]\{1,5\}\)$/\1/p' | head -1)"
[ -n "${HOST_PORT:-}" ] || fail "puerto publicado no determinado"

mexec(){ docker exec -e MYSQL_PWD="$DB_PW" -i "$CID" mysql -uroot --batch --raw "$@"; }

echo "== readiness (query autenticada a la base propia) =="
ready=""
for _ in $(seq 1 120); do mexec -e "SELECT 1;" "$DB_NAME" >/dev/null 2>&1 && { ready=1; break; }; sleep 2; done
[ -n "$ready" ] || { docker logs "$CID" 2>&1 | tail -20 >&2; fail "MySQL no alcanzó readiness"; }

echo "== base mínima: init.sql + stubs (branches/audit_events/employee_documents/payroll_periods) + schema_migrations =="
docker exec -e MYSQL_PWD="$DB_PW" -i "$CID" mysql -uroot "$DB_NAME" < "$REPO_DIR/database/init.sql" || fail "carga init.sql"
mexec "$DB_NAME" <<'SQL' || fail "creación de stubs"
CREATE TABLE IF NOT EXISTS branches (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(50), name VARCHAR(150)) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS audit_events (id BIGINT PRIMARY KEY AUTO_INCREMENT, entity_id INT NULL, action VARCHAR(60)) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS employee_documents (id INT PRIMARY KEY AUTO_INCREMENT, employee_id INT NULL) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS payroll_periods (id INT PRIMARY KEY AUTO_INCREMENT);
CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;
SQL

# runner real: única vía TCP al contenedor descartable (camino real de migrate.js)
run_migrate(){
  ( cd "$SIM/api" && DB_HOST=127.0.0.1 DB_PORT="$HOST_PORT" DB_USER=root DB_PASSWORD="$DB_PW" \
      DB_NAME="$DB_NAME" NODE_PATH="$REPO_DIR/api/node_modules" node scripts/migrate.js )
}
applied_csv(){ mexec -N -e "SELECT GROUP_CONCAT(SUBSTRING_INDEX(filename,'_',1) ORDER BY filename) FROM schema_migrations WHERE filename REGEXP '^0(7[6-9]|8[0-3])';" "$DB_NAME" | tr -d '\n'; }
assert_applied(){ # $1=esperado_csv $2=fase
  local got; got="$(applied_csv)"
  echo "   aplicadas 076-083 ($2): [${got}]"
  [ "$got" = "$1" ] || fail "$2: set aplicado esperado [$1], obtenido [$got]"
}
total_in_range(){ ls "$SIM/database/migrations" | grep -cE '^0(7[6-9]|8[0-3])_'; }
applied_count(){ mexec -N -e "SELECT COUNT(*) FROM schema_migrations WHERE filename REGEXP '^0(7[6-9]|8[0-3])';" "$DB_NAME" | tr -d '\n '; }
is_applied(){ mexec -N -e "SELECT COUNT(*) FROM schema_migrations WHERE filename LIKE '${1}%';" "$DB_NAME" | tr -d '\n '; }
assert_083_state(){ # $1=fase — total 8, aplicadas 7, pendiente ÚNICAMENTE 083
  local total applied a083; total="$(total_in_range)"; applied="$(applied_count)"; a083="$(is_applied 083)"
  echo "   $1: total=$total aplicadas=$applied pendientes=$((total-applied)) 083_aplicada=$a083"
  [ "$total"   = "8" ] || fail "$1: total esperado 8, obtenido $total"
  [ "$applied" = "7" ] || fail "$1: aplicadas esperado 7, obtenido $applied"
  [ "$a083"    = "0" ] || fail "$1: 083 NO debía estar aplicada (única pendiente esperada)"
}
assert_cause_083(){ # $1=out $2=fase — causa exacta 083/system_settings
  echo "$1" | grep -q "083_fase_e_activation_console" || fail "$2: el fallo no menciona 083"
  echo "$1" | grep -q "system_settings"               || fail "$2: el fallo no menciona system_settings"
}
assert_no_reapply(){ # $1=out $2=regex_ya_aplicadas $3=fase
  if echo "$1" | grep -E "Aplicando ($2)_" >/dev/null; then fail "$3: se reaplicó una migración ya aplicada ($2)"; fi
}

echo; echo "== FASE 1: migrate con 081-083 presentes, SIN 076-080 =="
cp "$WORK"/migs/081_*.sql "$WORK"/migs/082_*.sql "$WORK"/migs/083_*.sql "$SIM/database/migrations/"
set +e; OUT1="$(run_migrate 2>&1)"; RC1=$?; set -e
echo "$OUT1"; echo "   (migrate exit=$RC1 — se ESPERA != 0: 083 falla por system_settings)"
[ "$RC1" -ne 0 ] || fail "FASE 1: migrate debía fallar por 083/system_settings"
echo "$OUT1" | grep -q "system_settings" || fail "FASE 1: el fallo de 083 no menciona system_settings"
assert_applied "081,082" "FASE 1"

echo; echo "== FASE 2: se AÑADEN 076-080 (menores) y se corre migrate de nuevo =="
cp "$WORK"/migs/076_*.sql "$WORK"/migs/077_*.sql "$WORK"/migs/078_*.sql "$WORK"/migs/079_*.sql "$WORK"/migs/080_*.sql "$SIM/database/migrations/"
set +e; OUT2="$(run_migrate 2>&1)"; RC2=$?; set -e
echo "$OUT2"; echo "   (migrate exit=$RC2 — se ESPERA != 0: 083 sigue fallando)"
[ "$RC2" -ne 0 ] || fail "FASE 2: migrate debía fallar (exit!=0) por 083/system_settings"
assert_cause_083 "$OUT2" "FASE 2"                 # causa exacta 083/system_settings
assert_no_reapply "$OUT2" "08[12]" "FASE 2"       # 081/082 (ya aplicadas en FASE 1) NO se reaplican
assert_applied "076,077,078,079,080,081,082" "FASE 2"
assert_083_state "FASE 2"                          # total 8, aplicadas 7, pendiente ÚNICAMENTE 083
echo "   orden temporal (applied_at):"
mexec -N -e "SELECT filename, applied_at FROM schema_migrations WHERE filename REGEXP '^0(7[6-9]|8[0-3])' ORDER BY applied_at, filename;" "$DB_NAME"

echo; echo "== FASE 3: idempotencia — migrate otra vez (076-082 NO deben reaplicarse) =="
set +e; OUT3="$(run_migrate 2>&1)"; RC3=$?; set -e
echo "$OUT3"; echo "   (migrate exit=$RC3 — se ESPERA != 0: 083 sigue fallando)"
[ "$RC3" -ne 0 ] || fail "FASE 3: migrate debía fallar (exit!=0) por 083/system_settings"
assert_cause_083 "$OUT3" "FASE 3"                 # causa exacta 083/system_settings
assert_no_reapply "$OUT3" "0(7[6-9]|8[0-2])" "FASE 3"   # ninguna de 076-082 se reaplica
assert_applied "076,077,078,079,080,081,082" "FASE 3"
assert_083_state "FASE 3"                          # total 8, aplicadas 7, pendiente ÚNICAMENTE 083

echo; echo "== VERIFICACIÓN de objetos y FK cruzada =="
V="$(mexec -N -e "SELECT
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='companies'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='cost_centers'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='labor_calendars'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='monthly_report_approvals'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='branches' AND COLUMN_NAME='company_id'),
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$DB_NAME' AND CONSTRAINT_NAME='fk_branches_company');" "$DB_NAME" | tr '\t' ' ')"
echo "   companies cost_centers labor_calendars mra branches.company_id fk_branches_company = $V"
[ "$V" = "1 1 1 1 1 1" ] || fail "verificación de objetos/FK esperada '1 1 1 1 1 1', obtenida '$V'"

echo; echo "== OK: comportamiento no monotónico + 081/082 antes de 076-080 + idempotencia 076-082, todo validado =="
echo "== (083 NO probada SQL-safe: falla por system_settings; #202/083 sigue NO-GO) =="
echo "DONE"
