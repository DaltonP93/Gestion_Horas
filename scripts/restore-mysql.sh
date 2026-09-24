#!/usr/bin/env bash
# Restore MySQL fail-closed. Nunca crea ni elimina la base destino.
set -Eeuo pipefail
umask 077

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

usage() {
  echo "Uso: DB_NAME=<destino> MYSQL_DEFAULTS_FILE=<0600.cnf> $0 <backup.sql.gz> [--yes]"
  echo "Para --yes tambien se exige RESTORE_CONFIRMATION=RESTORE:<destino>."
  exit 1
}

FILE="${1:-}"
NONINTERACTIVE="${2:-}"
[[ -n "$FILE" ]] || usage
[[ "$NONINTERACTIVE" == "" || "$NONINTERACTIVE" == "--yes" ]] || usage

DB_NAME="${DB_NAME:-}"
MYSQL_DEFAULTS_FILE="${MYSQL_DEFAULTS_FILE:-}"
RESTORE_MODE="${RESTORE_MODE:-manual}"
REQUIRE_SHA256="${REQUIRE_SHA256:-1}"
ALLOW_PRODUCTION_RESTORE="${ALLOW_PRODUCTION_RESTORE:-}"
PRODUCTION_DATABASES="${PRODUCTION_DATABASES:-}"

[[ -n "$DB_NAME" ]] || fail "DB_NAME es obligatorio; no existe un destino por defecto"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "DB_NAME invalido"
[[ -f "$FILE" && ! -L "$FILE" ]] || fail "backup inexistente o symlink no permitido"
[[ "$MYSQL_DEFAULTS_FILE" == /* ]] || fail "MYSQL_DEFAULTS_FILE debe ser absoluto"
[[ -f "$MYSQL_DEFAULTS_FILE" && ! -L "$MYSQL_DEFAULTS_FILE" ]] \
  || fail "MYSQL_DEFAULTS_FILE inexistente o symlink no permitido"
[[ "$REQUIRE_SHA256" == 0 || "$REQUIRE_SHA256" == 1 ]] \
  || fail "REQUIRE_SHA256 debe ser 0 o 1"

MODE=$(stat -c '%a' -- "$MYSQL_DEFAULTS_FILE")
OWNER=$(stat -c '%u' -- "$MYSQL_DEFAULTS_FILE")
PERM=$((8#$MODE))
[[ "$OWNER" -eq "$EUID" ]] || fail "MYSQL_DEFAULTS_FILE debe pertenecer al usuario ejecutor"
(( (PERM & 077) == 0 )) || fail "MYSQL_DEFAULTS_FILE debe tener modo 0600 o mas restrictivo"

for command_name in mysql gzip gunzip sha256sum stat grep; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "falta el comando requerido: $command_name"
done

[[ "$RESTORE_MODE" == "manual" || "$RESTORE_MODE" == "drill" ]] \
  || fail "RESTORE_MODE debe ser manual o drill"

PROTECTED=0
if [[ "$RESTORE_MODE" == "manual" ]]; then
  [[ -n "$PRODUCTION_DATABASES" ]] \
    || fail "PRODUCTION_DATABASES es obligatorio en modo manual"
  IFS=',' read -r -a protected_names <<< "$PRODUCTION_DATABASES"
  for protected_name in "${protected_names[@]}"; do
    [[ "$protected_name" =~ ^[A-Za-z0-9_]+$ ]] \
      || fail "PRODUCTION_DATABASES contiene un nombre invalido"
    [[ "$DB_NAME" == "$protected_name" ]] && PROTECTED=1
  done
else
  [[ "$DB_NAME" == sishoras_restore_drill_* ]] \
    || fail "RESTORE_MODE=drill exige prefijo sishoras_restore_drill_"
fi

if (( PROTECTED == 1 )); then
  [[ "$ALLOW_PRODUCTION_RESTORE" == "I_UNDERSTAND_THIS_OVERWRITES_PRODUCTION" ]] \
    || fail "restore sobre una base protegida bloqueado"
fi

SIDECAR="$FILE.sha256"
if [[ "$REQUIRE_SHA256" == 1 ]]; then
  [[ -f "$SIDECAR" && ! -L "$SIDECAR" ]] || fail "falta sidecar SHA-256"
fi
if [[ -f "$SIDECAR" ]]; then
  (cd "$(dirname -- "$FILE")" \
    && sha256sum -c --status "$(basename -- "$SIDECAR")") \
    || fail "checksum SHA-256 invalido"
fi
gzip -t -- "$FILE" || fail "backup gzip corrupto"

EXPECTED_CONFIRMATION="RESTORE:$DB_NAME"
if [[ "$NONINTERACTIVE" == "--yes" ]]; then
  [[ "${RESTORE_CONFIRMATION:-}" == "$EXPECTED_CONFIRMATION" ]] \
    || fail "RESTORE_CONFIRMATION no coincide"
else
  echo "Restore destructivo sobre la base destino: $DB_NAME"
  read -r -p "Escriba $EXPECTED_CONFIRMATION para continuar: " ACK
  [[ "$ACK" == "$EXPECTED_CONFIRMATION" ]] || fail "confirmacion incorrecta"
fi

STARTED=$(date +%s)
log "RESTORE_START database=$DB_NAME file=$(basename -- "$FILE")"
gunzip -c -- "$FILE" \
  | mysql --defaults-extra-file="$MYSQL_DEFAULTS_FILE" "$DB_NAME"
mysql --defaults-extra-file="$MYSQL_DEFAULTS_FILE" "$DB_NAME" \
  --batch --skip-column-names -e 'SELECT 1' | grep -qx 1
DURATION=$(( $(date +%s) - STARTED ))
log "RESTORE_OK database=$DB_NAME duration_seconds=$DURATION"
