#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "TEST_FAIL: $*" >&2
  exit 1
}

SCRIPT_ROOT=$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
BACKUP_SCRIPT="$SCRIPT_ROOT/backup-mysql.sh"
RESTORE_SCRIPT="$SCRIPT_ROOT/restore-mysql.sh"
HEALTH_SCRIPT="$SCRIPT_ROOT/check-production-health.sh"
TMP_ROOT=$(mktemp -d)
cleanup() {
  case "$TMP_ROOT" in
    /tmp/*) rm -rf -- "$TMP_ROOT" ;;
  esac
}
trap cleanup EXIT

MOCK_BIN="$TMP_ROOT/bin"
mkdir -p "$MOCK_BIN"
REAL_PATH="$PATH"

cat > "$MOCK_BIN/mysqldump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == --defaults-extra-file=* ]] || exit 21
printf '%s\n' 'CREATE TABLE test_backup (id INT);'
if [[ "${FAKE_DUMP_FAIL:-0}" == 1 ]]; then
  exit 42
fi
printf '%s\n' 'INSERT INTO test_backup VALUES (1);'
SH

cat > "$MOCK_BIN/mysql" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"SELECT 1"* ]]; then
  echo 1
else
  cat >/dev/null
  [[ -n "${FAKE_MYSQL_MARKER:-}" ]] && touch "$FAKE_MYSQL_MARKER"
fi
SH

cat > "$MOCK_BIN/pm2" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == jlist ]]
cat "$FAKE_PM2_FILE"
SH

cat > "$MOCK_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
code=200
[[ "$url" == *"/protected"* ]] && code=401
if [[ "${FAKE_API_FAIL:-0}" == 1 && "$url" == *"/api-health"* ]]; then
  code=500
fi
printf '%s' "$code"
SH
chmod 0755 "$MOCK_BIN"/*

CRED="$TMP_ROOT/client.cnf"
printf '[client]\nuser=test\npassword=test\n' > "$CRED"
chmod 0600 "$CRED"

SUCCESS_DIR="$TMP_ROOT/success"
mkdir "$SUCCESS_DIR"
PATH="$MOCK_BIN:$REAL_PATH" \
BACKUP_DIR="$SUCCESS_DIR" \
MYSQL_DEFAULTS_FILE="$CRED" \
DB_NAME=app_test \
MIN_FREE_KB=0 \
LOCK_FILE="$TMP_ROOT/success.lock" \
RETENTION_DAYS=30 \
  "$BACKUP_SCRIPT"

BACKUP_FILE=$(find "$SUCCESS_DIR" -maxdepth 1 -type f -name '*.sql.gz')
[[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE.sha256" ]] \
  || fail "backup exitoso sin artefactos"
(cd "$SUCCESS_DIR" && sha256sum -c --status "$(basename -- "$BACKUP_FILE.sha256")") \
  || fail "sidecar invalido"
gzip -t "$BACKUP_FILE" || fail "gzip invalido"
[[ -z "$(find "$SUCCESS_DIR" -maxdepth 1 -name '*.tmp' -print -quit)" ]] \
  || fail "quedaron temporales publicados"

FAIL_DIR="$TMP_ROOT/failure"
mkdir "$FAIL_DIR"
if PATH="$MOCK_BIN:$REAL_PATH" \
  FAKE_DUMP_FAIL=1 \
  BACKUP_DIR="$FAIL_DIR" \
  MYSQL_DEFAULTS_FILE="$CRED" \
  DB_NAME=app_test \
  MIN_FREE_KB=0 \
  LOCK_FILE="$TMP_ROOT/failure.lock" \
  "$BACKUP_SCRIPT"; then
  fail "backup parcial devolvio exito"
fi
[[ -z "$(find "$FAIL_DIR" -maxdepth 1 -name '*.sql.gz' -print -quit)" ]] \
  || fail "backup parcial fue publicado"

chmod 0644 "$CRED"
if PATH="$MOCK_BIN:$REAL_PATH" \
  BACKUP_DIR="$TMP_ROOT/insecure" \
  MYSQL_DEFAULTS_FILE="$CRED" \
  DB_NAME=app_test \
  MIN_FREE_KB=0 \
  LOCK_FILE="$TMP_ROOT/insecure.lock" \
  "$BACKUP_SCRIPT"; then
  fail "credencial insegura fue aceptada"
fi
chmod 0600 "$CRED"

MYSQL_MARKER="$TMP_ROOT/mysql-called"
if PATH="$MOCK_BIN:$REAL_PATH" \
  FAKE_MYSQL_MARKER="$MYSQL_MARKER" \
  DB_NAME=production_test \
  PRODUCTION_DATABASES=production_test \
  MYSQL_DEFAULTS_FILE="$CRED" \
  RESTORE_CONFIRMATION=RESTORE:production_test \
  "$RESTORE_SCRIPT" "$BACKUP_FILE" --yes; then
  fail "restore productivo no autorizado fue aceptado"
fi
[[ ! -e "$MYSQL_MARKER" ]] || fail "mysql fue invocado antes del guard productivo"

PATH="$MOCK_BIN:$REAL_PATH" \
FAKE_MYSQL_MARKER="$MYSQL_MARKER" \
DB_NAME=sishoras_restore_drill_test \
MYSQL_DEFAULTS_FILE="$CRED" \
RESTORE_MODE=drill \
RESTORE_CONFIRMATION=RESTORE:sishoras_restore_drill_test \
  "$RESTORE_SCRIPT" "$BACKUP_FILE" --yes
[[ -e "$MYSQL_MARKER" ]] || fail "restore de drill no invoco mysql"

RELEASE="$TMP_ROOT/release/0123456789abcdef0123456789abcdef01234567"
mkdir -p "$RELEASE"/{api,web,bridge,analytics}
printf '%s\n' 0123456789abcdef0123456789abcdef01234567 > "$RELEASE/.release-commit"
PM2_JSON="$TMP_ROOT/pm2.json"
cat > "$PM2_JSON" <<JSON
[
 {"name":"app-api","pm2_env":{"status":"online","restart_time":0,"pm_cwd":"$RELEASE/api","pm_exec_path":"$RELEASE/api/src/index.js"}},
 {"name":"app-worker","pm2_env":{"status":"online","restart_time":0,"pm_cwd":"$RELEASE/api","pm_exec_path":"$RELEASE/api/src/workers/syncWorker.js"}},
 {"name":"app-web","pm2_env":{"status":"online","restart_time":0,"pm_cwd":"$RELEASE/web","pm_exec_path":"$RELEASE/web/node_modules/.bin/next"}},
 {"name":"app-bridge","pm2_env":{"status":"online","restart_time":0,"pm_cwd":"$RELEASE/bridge","pm_exec_path":"$RELEASE/bridge/src/index.js"}},
 {"name":"app-analytics","pm2_env":{"status":"online","restart_time":0,"pm_cwd":"$RELEASE/analytics","pm_exec_path":"$RELEASE/analytics/.venv/bin/uvicorn"}}
]
JSON

PATH="$MOCK_BIN:$REAL_PATH" \
FAKE_PM2_FILE="$PM2_JSON" \
PM2_APP_NAMES=app-api,app-worker,app-web,app-bridge,app-analytics \
API_HEALTH_URL=http://test.invalid/api-health \
WEB_HEALTH_URL=http://test.invalid/web-health \
BRIDGE_HEALTH_URL=http://test.invalid/bridge-health \
ANALYTICS_HEALTH_URL=http://test.invalid/analytics-health \
ANALYTICS_PROTECTED_URL=http://test.invalid/protected \
CHECK_BACKUP=0 \
EXPECTED_RELEASE_SHA=0123456789abcdef0123456789abcdef01234567 \
  "$HEALTH_SCRIPT"

if PATH="$MOCK_BIN:$REAL_PATH" \
  FAKE_PM2_FILE="$PM2_JSON" \
  FAKE_API_FAIL=1 \
  PM2_APP_NAMES=app-api,app-worker,app-web,app-bridge,app-analytics \
  API_HEALTH_URL=http://test.invalid/api-health \
  WEB_HEALTH_URL=http://test.invalid/web-health \
  BRIDGE_HEALTH_URL=http://test.invalid/bridge-health \
  ANALYTICS_HEALTH_URL=http://test.invalid/analytics-health \
  ANALYTICS_PROTECTED_URL=http://test.invalid/protected \
  CHECK_BACKUP=0 \
  "$HEALTH_SCRIPT"; then
  fail "healthcheck acepto API en HTTP 500"
fi

echo "OPS_SCRIPT_TESTS=PASS"
