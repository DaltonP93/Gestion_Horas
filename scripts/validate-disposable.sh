#!/usr/bin/env bash
# =============================================================================
# scripts/validate-disposable.sh — Validación DESCARTABLE de código + migraciones
# (Bloque 5 del procedimiento de validación controlada de SisHoras).
#
# QUÉ HACE (todo en un entorno descartable, NUNCA toca producción):
#   1. Crea un worktree temporal desde origin/main (o el ref indicado).
#   2. Corre el matrix de tests: api + bridge en 3 TZ (UTC/America-Asuncion/
#      Asia-Tokyo), web (test + build), analytics (venv + py_compile + import).
#   3. Corre el self-test de H1 (h1-preflight-evidence.sh --selftest).
#   4. Levanta un MySQL 8 EFÍMERO propio (nombre/puerto/clave/label únicos),
#      carga init.sql + prereqs, BASELINEA hasta 071 y aplica 072→080 de verdad,
#      verifica que quedaron aplicadas, reaplica (no-op) y compara el esquema.
#   5. Limpia SOLO lo que creó (contenedor + worktree + venv), por etiqueta/ruta.
#   6. Imprime un resumen PASS/FAIL y un veredicto GO/NO-GO para (A) código y
#      (B) migraciones. Sale != 0 si algo falló.
#
# LO QUE NO HACE (por diseño):
#   - No usa el .env productivo, ni la BD, ni la red, ni datos de producción.
#   - No corre pm2, no despliega, no migra prod, no toca flags, att2000 READ-ONLY.
#   - No imprime secretos: la clave del MySQL efímero se genera al vuelo, se pasa
#     por MYSQL_PWD y nunca se ecoa.
#
# REQUISITOS EN EL HOST: git, node+npm, python3 (venv), docker, y salida a
# npm/pip/registry. Correr como un usuario con acceso a docker.
#
# USO:
#   scripts/validate-disposable.sh
#   REPO_DIR=/var/www/html/Gestion_Horas BASE_REF=origin/main \
#     scripts/validate-disposable.sh
#
# VARIABLES (opcionales):
#   REPO_DIR   repo git desde donde sacar el worktree (default: raíz del repo
#              donde vive este script). Se le hace `git fetch origin` (permitido).
#   BASE_REF   ref a validar (default: origin/main).
#   WORKROOT   dir base para artefactos temporales (default: $(mktemp -d)).
#   KEEP=1     no limpiar al final (para depurar). Default: limpia siempre.
# =============================================================================
set -Euo pipefail

# ----- Config y etiqueta única ------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SELF_DIR/..")}"
BASE_REF="${BASE_REF:-origin/main}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RID="v${STAMP}-$$-${RANDOM}"                 # id único de esta corrida
VTAG="sishoras-validate-${RID}"              # prefijo/label para limpieza segura
WORKROOT="${WORKROOT:-$(mktemp -d "/tmp/${VTAG}.XXXXXX")}"
WT="${WORKROOT}/worktree"
VENV="${WORKROOT}/venv"
CID="${VTAG}-mysql"                          # nombre del contenedor MySQL efímero
DB_NAME="asistencia"
# Puerto efímero libre en loopback:
DBPORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
DBPASS="$(head -c18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c20)"  # NO se imprime

TZS=(UTC America/Asuncion Asia/Tokyo)
declare -a RESULTS=()   # "PASS|FASE" / "FAIL|FASE"
OVERALL=0

log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
record() { # record <PASS|FAIL> <nombre>
  RESULTS+=("$1|$2"); [ "$1" = "FAIL" ] && OVERALL=1 || true
  printf '   -> %s: %s\n' "$2" "$1"
}
# check <nombre> <cmd...> : ejecuta, registra PASS/FAIL, NO aborta el script.
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then record PASS "$name"; else record FAIL "$name"; fi
}

# ----- Limpieza segura (sólo lo creado por esta corrida) ----------------------
cleanup() {
  local rc=$?
  if [ "${KEEP:-0}" = "1" ]; then note "KEEP=1: no se limpia ($WORKROOT / $CID)"; return $rc; fi
  log "Limpieza (sólo artefactos de esta corrida: ${VTAG})"
  # Contenedor: sólo el que lleva nuestro label/nombre.
  if command -v docker >/dev/null 2>&1; then
    local ids; ids="$(docker ps -aq --filter "label=${VTAG}=1" 2>/dev/null || true)"
    [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
    # respaldo por nombre exacto:
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  # Worktree: removerlo del repo y podar.
  if [ -d "$WT" ]; then
    git -C "$REPO_DIR" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
    git -C "$REPO_DIR" worktree prune >/dev/null 2>&1 || true
  fi
  # Directorio temporal: sólo si es el nuestro (prefijo verificado).
  case "$WORKROOT" in
    /tmp/${VTAG}.*|/tmp/${VTAG}) rm -rf "$WORKROOT" >/dev/null 2>&1 || true ;;
    *) note "WORKROOT no coincide con el prefijo esperado; NO se borra: $WORKROOT" ;;
  esac
  return $rc
}
trap cleanup EXIT

# ----- Preflight de herramientas ---------------------------------------------
log "Validación descartable ${RID}"
note "REPO_DIR=$REPO_DIR   BASE_REF=$BASE_REF"
note "WORKROOT=$WORKROOT   MySQL efímero=$CID (127.0.0.1:$DBPORT)"
for t in git node npm python3; do command -v "$t" >/dev/null 2>&1 || { echo "FATAL: falta '$t'"; exit 2; }; done
HAVE_DOCKER=1; command -v docker >/dev/null 2>&1 || { HAVE_DOCKER=0; note "docker ausente → se SALTA la validación de migraciones (NO-GO para B)"; }

# ----- 0. Worktree descartable desde origin/main ------------------------------
log "0. Worktree temporal desde ${BASE_REF}"
git -C "$REPO_DIR" fetch origin --quiet
git -C "$REPO_DIR" worktree add --detach "$WT" "$BASE_REF" >/dev/null
VALIDATED_SHA="$(git -C "$WT" rev-parse HEAD)"
note "HEAD validado: $VALIDATED_SHA"
record PASS "worktree:checkout"

# ----- 1. API — tests en 3 TZ -------------------------------------------------
log "1. API — install + tests (3 TZ)"
( cd "$WT/api" && npm ci ) >/dev/null 2>&1 && record PASS "api:npm-ci" || { record FAIL "api:npm-ci"; }
for tz in "${TZS[@]}"; do
  check "api:test:TZ=$tz" bash -c "cd '$WT/api' && TZ='$tz' npm test"
done

# ----- 2. Bridge — tests en 3 TZ ---------------------------------------------
log "2. Bridge — install + tests (3 TZ)"
( cd "$WT/bridge" && npm ci ) >/dev/null 2>&1 && record PASS "bridge:npm-ci" || record FAIL "bridge:npm-ci"
for tz in "${TZS[@]}"; do
  check "bridge:test:TZ=$tz" bash -c "cd '$WT/bridge' && TZ='$tz' npm test"
done

# ----- 3. Web — test + build --------------------------------------------------
log "3. Web — install + test + build"
( cd "$WT/web" && npm ci ) >/dev/null 2>&1 && record PASS "web:npm-ci" || record FAIL "web:npm-ci"
check "web:test"  bash -c "cd '$WT/web' && npm test"
check "web:build" bash -c "cd '$WT/web' && NEXT_TELEMETRY_DISABLED=1 npm run build"

# ----- 4. Analytics — venv + py_compile + import ------------------------------
log "4. Analytics — venv + py_compile + import"
if python3 -m venv "$VENV" >/dev/null 2>&1 \
   && "$VENV/bin/pip" install --quiet --disable-pip-version-check -r "$WT/analytics/requirements.txt" >/dev/null 2>&1; then
  record PASS "analytics:venv+deps"
  check "analytics:py_compile" bash -c "'$VENV/bin/python' -m py_compile '$WT/analytics/main.py'"
  check "analytics:import"      bash -c "cd '$WT/analytics' && '$VENV/bin/python' -c 'import main; assert main.app'"
else
  record FAIL "analytics:venv+deps"
fi

# ----- 5. H1 preflight self-test ---------------------------------------------
log "5. H1 preflight — self-test"
if [ -f "$WT/api/scripts/h1-preflight-evidence.sh" ]; then
  check "h1:selftest" bash "$WT/api/scripts/h1-preflight-evidence.sh" --selftest
else
  record FAIL "h1:selftest(no-existe)"
fi

# ----- 6. Migraciones 072→080 en MySQL 8 efímero ------------------------------
log "6. Migraciones 072→080 (MySQL 8 efímero, descartable)"
if [ "$HAVE_DOCKER" = "1" ]; then
  export MYSQL_PWD="$DBPASS"   # usado por el cliente mysql; no se imprime
  MYSQL=(mysql -h 127.0.0.1 -P "$DBPORT" -u root "$DB_NAME")
  MYSQLNODB=(mysql -h 127.0.0.1 -P "$DBPORT" -u root)
  MIG_OK=1
  docker run -d --name "$CID" --label "${VTAG}=1" \
    -e MYSQL_ROOT_PASSWORD="$DBPASS" -e MYSQL_DATABASE="$DB_NAME" \
    -p "127.0.0.1:${DBPORT}:3306" mysql:8.0 >/dev/null 2>&1 || MIG_OK=0
  if [ "$MIG_OK" = "1" ]; then
    # Esperar readiness (SELECT 1 autenticado):
    note "esperando MySQL efímero…"
    for _ in $(seq 1 60); do "${MYSQLNODB[@]}" -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done
    "${MYSQLNODB[@]}" -e 'SELECT 1' >/dev/null 2>&1 || MIG_OK=0
  fi
  if [ "$MIG_OK" = "1" ]; then
    # Permitir rutinas con binlog (SÓLO en este contenedor descartable):
    "${MYSQLNODB[@]}" -e "SET GLOBAL log_bin_trust_function_creators=1" >/dev/null 2>&1 || true
    # Esquema previo: init.sql + prerequisitos que usa el harness FASE F.
    "${MYSQL[@]}" < "$WT/database/init.sql" >/dev/null 2>&1 || MIG_OK=0
    for m in 012_audit_events 015_branches 067_employee_documents; do
      "${MYSQL[@]}" < "$WT/database/migrations/${m}.sql" >/dev/null 2>&1 || true
    done
  fi
  if [ "$MIG_OK" = "1" ]; then
    ( cd "$WT/api" && npm ci ) >/dev/null 2>&1 || true   # runner + deps (ya instalado en fase 1, por si acaso)
    export DB_HOST=127.0.0.1 DB_PORT="$DBPORT" DB_USER=root DB_PASSWORD="$DBPASS" DB_NAME="$DB_NAME"
    # Baseline SÓLO hasta 071 → el runner aplica 072→ DE VERDAD:
    check "migrate:baseline<=071" bash -c "cd '$WT/api' && node scripts/migrate.js --baseline=071_repair_external_hr_sources.sql"
    check "migrate:apply-072-080" bash -c "cd '$WT/api' && node scripts/migrate.js"
    # 072→080 realmente aplicadas (registradas en schema_migrations):
    check "migrate:072-080-registradas" bash -c '
      for m in 072_employee_schedule_history 073_workday_profile_and_overlap_guard \
               074_daily_summary_status_unknown 075_workday_configuration_phase_c \
               076_governance_companies_cost_centers 077_audit_correlation_id \
               078_people_candidates_assignments 079_labor_calendars 080_payroll_base; do
        mysql -h 127.0.0.1 -P '"$DBPORT"' -u root '"$DB_NAME"' -N -B \
          -e "SELECT COUNT(*) FROM schema_migrations WHERE filename=\"$m.sql\"" | grep -q "^1$" || exit 1
      done'
    # Objetos representativos presentes:
    check "esquema:companies+company_id+correlation+payroll" bash -c '
      mysql -h 127.0.0.1 -P '"$DBPORT"' -u root '"$DB_NAME"' -N -B -e "
        SELECT
          (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema=\"'"$DB_NAME"'\" AND table_name=\"companies\") +
          (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=\"'"$DB_NAME"'\" AND table_name=\"branches\" AND column_name=\"company_id\") +
          (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=\"'"$DB_NAME"'\" AND table_name=\"audit_events\" AND column_name=\"correlation_id\") +
          (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema=\"'"$DB_NAME"'\" AND table_name=\"payroll_periods\")" | grep -q "^4$"'
    # Snapshot de esquema, reaplicar = no-op, comparar:
    SEL='SELECT table_name,column_name,column_type,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema="'"$DB_NAME"'" ORDER BY table_name,ordinal_position'
    "${MYSQL[@]}" -N -B -e "$SEL" > "$WORKROOT/schema_before.txt" 2>/dev/null || true
    check "migrate:reaplicar-no-op" bash -c "cd '$WT/api' && OUT=\$(node scripts/migrate.js); echo \"\$OUT\" | grep -q 'Nada por aplicar'"
    "${MYSQL[@]}" -N -B -e "$SEL" > "$WORKROOT/schema_after.txt" 2>/dev/null || true
    check "migrate:esquema-identico-tras-reaplicar" diff -q "$WORKROOT/schema_before.txt" "$WORKROOT/schema_after.txt"
    check "migrate:status-0-pendientes" bash -c "cd '$WT/api' && node scripts/migrate.js --status | grep -Eq '0 pendientes'"
  else
    record FAIL "migrate:mysql-efimero-no-arranco"
  fi
else
  record FAIL "migrate:sin-docker (NO-GO para migraciones)"
fi

# ----- 7. Resumen + veredicto -------------------------------------------------
log "7. Resumen"
printf '   %-42s %s\n' "FASE" "RESULTADO"
printf '   %-42s %s\n' "----" "---------"
CODE_FAIL=0; MIG_FAIL=0
for r in "${RESULTS[@]}"; do
  st="${r%%|*}"; nm="${r#*|}"
  printf '   %-42s %s\n' "$nm" "$st"
  if [ "$st" = "FAIL" ]; then
    # Fallos de migraciones/esquema pesan sobre el veredicto B; el resto sobre A.
    case "$nm" in
      migrate:*|esquema:*) MIG_FAIL=1 ;;
      *)                   CODE_FAIL=1 ;;
    esac
  fi
done

log "Veredicto (sólo sobre lo validable en descartable; NO reemplaza los bloques 1-4 en el host)"
printf '   HEAD validado           : %s\n' "$VALIDATED_SHA"
printf '   A) desplegar CÓDIGO      : %s\n' "$([ "$CODE_FAIL" = 0 ] && echo GO || echo NO-GO)"
printf '   B) aplicar MIGRACIONES   : %s\n' "$([ "$MIG_FAIL"  = 0 ] && echo GO || echo NO-GO)"
printf '   C) activar WRITERS       : fuera de alcance de esta validación (decisión operativa separada)\n'
note "Recordatorio: este script NO inspecciona el host de prod (PM2/flags/health/BD real)."
note "Los bloques 1-4 (estado del server, flags efectivos, health, MySQL de prod) se corren aparte EN el servidor."

exit "$OVERALL"
