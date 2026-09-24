#!/usr/bin/env bash
# Restaura un backup real en un mysqld efimero, sin red y sin tocar produccion.
set -Eeuo pipefail
umask 077

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

BACKUP="${1:-}"
[[ -n "$BACKUP" ]] || fail "uso: $0 <backup.sql.gz>"
[[ -f "$BACKUP" && ! -L "$BACKUP" ]] || fail "backup inexistente o symlink no permitido"
[[ "$EUID" -eq 0 ]] || fail "el drill debe ejecutarse como root"

DRILL_ROOT="${DRILL_ROOT:-}"
REPORT_DIR="${REPORT_DIR:-}"
MIN_TABLES="${MIN_TABLES:-20}"
MYSQLD="${MYSQLD:-/usr/sbin/mysqld}"
SCRIPT_DIR=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RESTORE_SCRIPT="$SCRIPT_DIR/restore-mysql.sh"

[[ "$DRILL_ROOT" == /* && "$DRILL_ROOT" != "/" ]] || fail "DRILL_ROOT inseguro"
[[ "$REPORT_DIR" == /* && "$REPORT_DIR" != "/" ]] || fail "REPORT_DIR inseguro"
[[ "$MIN_TABLES" =~ ^[0-9]+$ ]] || fail "MIN_TABLES debe ser entero"
[[ -x "$MYSQLD" ]] || fail "mysqld no disponible"
[[ -x "$RESTORE_SCRIPT" ]] || fail "restore-mysql.sh no ejecutable"

for command_name in mysql mysqladmin mysqlcheck gzip sha256sum runuser install mktemp; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "falta el comando requerido: $command_name"
done
id mysql >/dev/null 2>&1 || fail "no existe el usuario mysql"

SIDECAR="$BACKUP.sha256"
[[ -f "$SIDECAR" && ! -L "$SIDECAR" ]] || fail "falta sidecar SHA-256"
(cd "$(dirname -- "$BACKUP")" \
  && sha256sum -c --status "$(basename -- "$SIDECAR")") \
  || fail "checksum SHA-256 invalido"
gzip -t -- "$BACKUP" || fail "backup gzip corrupto"
BACKUP_SHA=$(sha256sum -- "$BACKUP" | awk '{print $1}')

install -d -o mysql -g mysql -m 700 "$DRILL_ROOT"
install -d -m 700 "$REPORT_DIR"
WORK=$(mktemp -d "$DRILL_ROOT/run.XXXXXXXX")
case "$WORK" in
  "$DRILL_ROOT"/run.*) ;;
  *) fail "mktemp devolvio una ruta insegura" ;;
esac
chown mysql:mysql "$WORK"
chmod 700 "$WORK"

DATADIR="$WORK/data"
TMPDIR="$WORK/tmp"
SOCKET="$WORK/mysql.sock"
PIDFILE="$WORK/mysqld.pid"
MYSQL_LOG="$WORK/mysqld.log"
CLIENT_CNF="$WORK/client.cnf"
SERVER_STARTED=0

cleanup() {
  rc=$?
  trap - EXIT
  if [[ "$SERVER_STARTED" -eq 1 && -S "$SOCKET" ]]; then
    mysqladmin --defaults-extra-file="$CLIENT_CNF" shutdown >/dev/null 2>&1 || true
  fi
  if [[ "$rc" -ne 0 && -f "$MYSQL_LOG" ]]; then
    echo "Ultimas lineas del mysqld efimero:" >&2
    tail -n 30 "$MYSQL_LOG" >&2 || true
  fi
  case "$WORK" in
    "$DRILL_ROOT"/run.*) rm -rf -- "$WORK" ;;
    *) echo "Ruta temporal insegura; no se elimina: $WORK" >&2 ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -o mysql -g mysql -m 700 "$DATADIR" "$TMPDIR"
touch "$MYSQL_LOG"
chown mysql:mysql "$MYSQL_LOG"

STARTED_AT=$(date +%s)
log "DRILL_INIT backup=$(basename -- "$BACKUP")"
runuser -u mysql -- "$MYSQLD" --no-defaults \
  --initialize-insecure \
  --datadir="$DATADIR" \
  --log-error="$MYSQL_LOG"

runuser -u mysql -- "$MYSQLD" --no-defaults \
  --daemonize \
  --datadir="$DATADIR" \
  --socket="$SOCKET" \
  --pid-file="$PIDFILE" \
  --log-error="$MYSQL_LOG" \
  --tmpdir="$TMPDIR" \
  --skip-networking \
  --skip-log-bin \
  --performance-schema=OFF \
  --innodb-buffer-pool-size=128M
SERVER_STARTED=1

printf '[client]\nprotocol=socket\nsocket=%s\nuser=root\n' "$SOCKET" > "$CLIENT_CNF"
chmod 600 "$CLIENT_CNF"

READY=0
for _ in $(seq 1 60); do
  if mysqladmin --defaults-extra-file="$CLIENT_CNF" ping --silent >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" -eq 1 ]] || fail "mysqld efimero no alcanzo readiness"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DRILL_DB="sishoras_restore_drill_${STAMP}_$$"
mysql --defaults-extra-file="$CLIENT_CNF" -e \
  "CREATE DATABASE \`$DRILL_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

DB_NAME="$DRILL_DB" \
MYSQL_DEFAULTS_FILE="$CLIENT_CNF" \
RESTORE_MODE=drill \
RESTORE_CONFIRMATION="RESTORE:$DRILL_DB" \
  "$RESTORE_SCRIPT" "$BACKUP" --yes

TABLES=$(mysql --defaults-extra-file="$CLIENT_CNF" --batch --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DRILL_DB'")
[[ "$TABLES" =~ ^[0-9]+$ && "$TABLES" -ge "$MIN_TABLES" ]] \
  || fail "restore incompleto: tables=$TABLES min=$MIN_TABLES"

REQUIRED=$(mysql --defaults-extra-file="$CLIENT_CNF" --batch --skip-column-names \
  -e "SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema='$DRILL_DB'
        AND table_name IN ('employees','attendance_logs','schema_migrations')")
[[ "$REQUIRED" -eq 3 ]] || fail "faltan tablas criticas en el restore"

MIGRATIONS=$(mysql --defaults-extra-file="$CLIENT_CNF" "$DRILL_DB" \
  --batch --skip-column-names -e 'SELECT COUNT(*) FROM schema_migrations')
mysqlcheck --defaults-extra-file="$CLIENT_CNF" --check --silent "$DRILL_DB"

mysqladmin --defaults-extra-file="$CLIENT_CNF" shutdown
SERVER_STARTED=0
DURATION=$(( $(date +%s) - STARTED_AT ))

REPORT_TMP=$(mktemp "$REPORT_DIR/.restore-drill-${STAMP}.XXXXXX.tmp")
REPORT="$REPORT_DIR/restore-drill-${STAMP}.report"
printf 'status=PASS\ntimestamp_utc=%s\nbackup_sha256=%s\ntables=%s\nmigrations=%s\ncritical_tables=PASS\nmysqlcheck=PASS\nrto_seconds=%s\nnetwork=disabled\n' \
  "$STAMP" "$BACKUP_SHA" "$TABLES" "$MIGRATIONS" "$DURATION" > "$REPORT_TMP"
chmod 600 "$REPORT_TMP"
mv -- "$REPORT_TMP" "$REPORT"
log "RESTORE_DRILL_OK report=$REPORT tables=$TABLES migrations=$MIGRATIONS rto_seconds=$DURATION"
