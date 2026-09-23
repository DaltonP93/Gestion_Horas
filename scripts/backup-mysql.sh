#!/usr/bin/env bash
# Backup MySQL atomico y verificable para SisHoras.
# No acepta claves por argv ni por variables de password: usa un option file 0600.
set -Eeuo pipefail
umask 077

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "falta el comando requerido: $1"
}

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

BACKUP_DIR="${BACKUP_DIR:-}"
DB_NAME="${DB_NAME:-}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
MIN_FREE_KB="${MIN_FREE_KB:-1048576}"
MYSQL_DEFAULTS_FILE="${MYSQL_DEFAULTS_FILE:-}"
LOCK_FILE="${LOCK_FILE:-}"

[[ "$BACKUP_DIR" == /* ]] || fail "BACKUP_DIR debe ser absoluto y explicito"
[[ "$BACKUP_DIR" != "/" ]] || fail "BACKUP_DIR no puede ser /"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "DB_NAME debe ser explicito y valido"
[[ "$LOCK_FILE" == /* ]] || fail "LOCK_FILE debe ser absoluto y explicito"
is_uint "$RETENTION_DAYS" || fail "RETENTION_DAYS debe ser entero"
is_uint "$MIN_FREE_KB" || fail "MIN_FREE_KB debe ser entero"
[[ "$MYSQL_DEFAULTS_FILE" == /* ]] || fail "MYSQL_DEFAULTS_FILE debe ser absoluto"
[[ -f "$MYSQL_DEFAULTS_FILE" ]] || fail "no existe MYSQL_DEFAULTS_FILE"
[[ ! -L "$MYSQL_DEFAULTS_FILE" ]] || fail "MYSQL_DEFAULTS_FILE no puede ser symlink"

MODE=$(stat -c '%a' -- "$MYSQL_DEFAULTS_FILE")
OWNER=$(stat -c '%u' -- "$MYSQL_DEFAULTS_FILE")
PERM=$((8#$MODE))
[[ "$OWNER" -eq "$EUID" ]] || fail "MYSQL_DEFAULTS_FILE debe pertenecer al usuario ejecutor"
(( (PERM & 077) == 0 )) || fail "MYSQL_DEFAULTS_FILE debe tener modo 0600 o mas restrictivo"

for command_name in mysqldump gzip sha256sum flock df stat mktemp find; do
  require_command "$command_name"
done

mkdir -p -- "$BACKUP_DIR" "$(dirname -- "$LOCK_FILE")"
chmod 700 -- "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "ya existe otro backup en ejecucion"

AVAILABLE_KB=$(df -Pk -- "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')
is_uint "$AVAILABLE_KB" || fail "no se pudo determinar el espacio disponible"
(( AVAILABLE_KB >= MIN_FREE_KB )) || fail "espacio insuficiente para iniciar el backup"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE="${DB_NAME}_${STAMP}"
FINAL="$BACKUP_DIR/$BASE.sql.gz"
SIDECAR="$FINAL.sha256"
[[ ! -e "$FINAL" && ! -e "$SIDECAR" ]] || fail "ya existe el backup de este segundo"

TMP=$(mktemp "$BACKUP_DIR/.$BASE.XXXXXX.sql.gz.tmp")
SHA_TMP=$(mktemp "$BACKUP_DIR/.$BASE.XXXXXX.sha256.tmp")
cleanup() {
  rm -f -- "$TMP" "$SHA_TMP"
  if [[ -n "${FINAL:-}" && -n "${SIDECAR:-}" && ! -e "$FINAL" ]]; then
    rm -f -- "$SIDECAR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "BACKUP_START database=$DB_NAME"
mysqldump --defaults-extra-file="$MYSQL_DEFAULTS_FILE" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --hex-blob \
  --no-tablespaces \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -9 > "$TMP"

[[ -s "$TMP" ]] || fail "mysqldump produjo un archivo vacio"
gzip -t -- "$TMP"
SHA=$(sha256sum -- "$TMP" | awk '{print $1}')
printf '%s  %s\n' "$SHA" "$(basename -- "$FINAL")" > "$SHA_TMP"
chmod 600 -- "$TMP" "$SHA_TMP"

# Publicar primero el sidecar: un fallo nunca deja un dump final sin checksum.
mv -- "$SHA_TMP" "$SIDECAR"
mv -- "$TMP" "$FINAL"
trap - EXIT INT TERM

PURGED=0
if (( RETENTION_DAYS > 0 )); then
  while IFS= read -r -d '' old_backup; do
    old_sidecar="$old_backup.sha256"
    if [[ -f "$old_sidecar" ]] \
      && (cd "$(dirname -- "$old_backup")" \
          && sha256sum -c --status "$(basename -- "$old_sidecar")") \
      && gzip -t -- "$old_backup"; then
      rm -f -- "$old_backup" "$old_sidecar"
      PURGED=$((PURGED + 1))
    else
      log "RETENTION_SKIP_UNVERIFIED path=$old_backup"
    fi
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name "${DB_NAME}_[0-9]*Z.sql.gz" -mtime "+$RETENTION_DAYS" -print0)
fi

BYTES=$(stat -c '%s' -- "$FINAL")
log "BACKUP_OK path=$FINAL bytes=$BYTES sha256=$SHA purged=$PURGED"
