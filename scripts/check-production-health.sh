#!/usr/bin/env bash
# Gate de salud sin secretos ni escrituras para SisHoras.
set -Eeuo pipefail

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

API_HEALTH_URL="${API_HEALTH_URL:-}"
WEB_HEALTH_URL="${WEB_HEALTH_URL:-}"
BRIDGE_HEALTH_URL="${BRIDGE_HEALTH_URL:-}"
ANALYTICS_HEALTH_URL="${ANALYTICS_HEALTH_URL:-}"
ANALYTICS_PROTECTED_URL="${ANALYTICS_PROTECTED_URL:-}"
EXTERNAL_HEALTH_URL="${EXTERNAL_HEALTH_URL:-}"
PM2_APP_NAMES="${PM2_APP_NAMES:-}"
EXPECTED_RELEASE_SHA="${EXPECTED_RELEASE_SHA:-}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-10}"
CHECK_BACKUP="${CHECK_BACKUP:-1}"
BACKUP_DIR="${BACKUP_DIR:-}"
DB_NAME="${DB_NAME:-}"
MAX_BACKUP_AGE_SECONDS="${MAX_BACKUP_AGE_SECONDS:-28800}"

[[ "$HTTP_TIMEOUT" =~ ^[0-9]+$ ]] && (( HTTP_TIMEOUT > 0 )) \
  || fail "HTTP_TIMEOUT debe ser entero positivo"
[[ "$CHECK_BACKUP" == 0 || "$CHECK_BACKUP" == 1 ]] || fail "CHECK_BACKUP debe ser 0 o 1"
[[ "$MAX_BACKUP_AGE_SECONDS" =~ ^[0-9]+$ ]] \
  || fail "MAX_BACKUP_AGE_SECONDS debe ser entero"
[[ "$PM2_APP_NAMES" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] \
  || fail "PM2_APP_NAMES debe ser una lista explicita y valida"
[[ -z "$EXPECTED_RELEASE_SHA" || "$EXPECTED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || fail "EXPECTED_RELEASE_SHA invalido"
for required_url in "$API_HEALTH_URL" "$WEB_HEALTH_URL" "$BRIDGE_HEALTH_URL" \
  "$ANALYTICS_HEALTH_URL" "$ANALYTICS_PROTECTED_URL"; do
  [[ "$required_url" =~ ^https?:// ]] || fail "los endpoints internos deben ser explicitos"
done
[[ -z "$EXTERNAL_HEALTH_URL" || "$EXTERNAL_HEALTH_URL" =~ ^https?:// ]] \
  || fail "EXTERNAL_HEALTH_URL invalido"

for command_name in pm2 node curl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "falta el comando requerido: $command_name"
done

PM2_RESULT=$(pm2 jlist | node -e '
const fs = require("node:fs");
const path = require("node:path");
const expectedSha = process.argv[1] || "";
const expectedNames = (process.argv[2] || "").split(",").filter(Boolean);
const names = new Set(expectedNames);
if (!expectedNames.length || names.size !== expectedNames.length) {
  throw new Error("PM2_APP_NAMES vacio o duplicado");
}
let raw = "";
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  const rows = JSON.parse(raw).filter(proc => names.has(proc.name));
  const seenNames = new Set(rows.map(proc => proc.name));
  if (rows.length !== expectedNames.length ||
      expectedNames.some(name => !seenNames.has(name))) {
    throw new Error("faltan procesos PM2 esperados o hay duplicados");
  }
  if (rows.some(proc => proc.pm2_env.status !== "online")) {
    throw new Error("hay procesos SisHoras fuera de linea");
  }
  const roots = new Set(rows.map(proc => path.dirname(proc.pm2_env.pm_cwd)));
  if (roots.size !== 1) throw new Error("los procesos apuntan a releases distintas");
  const root = [...roots][0];
  if (root.includes("/.prepare-")) throw new Error("PM2 apunta a una release temporal");
  if (rows.some(proc => !proc.pm2_env.pm_exec_path.startsWith(root + "/"))) {
    throw new Error("hay ejecutables fuera de la release activa");
  }
  const sha = fs.readFileSync(path.join(root, ".release-commit"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(".release-commit invalido");
  if (expectedSha && sha !== expectedSha) throw new Error("SHA activo no coincide con el esperado");
  const restarts = rows.reduce((sum, proc) => sum + Number(proc.pm2_env.restart_time || 0), 0);
  process.stdout.write("PM2_OK release_sha=" + sha + " restarts_total=" + restarts);
});
' "$EXPECTED_RELEASE_SHA" "$PM2_APP_NAMES") || fail "gate PM2 fallo"
log "$PM2_RESULT"

check_http() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time "$HTTP_TIMEOUT" "$url") || fail "$label no respondio"
  [[ "$code" == "$expected" ]] || fail "$label devolvio HTTP $code; esperado $expected"
  log "HTTP_OK name=$label code=$code"
}

check_http api "$API_HEALTH_URL" 200
check_http web "$WEB_HEALTH_URL" 200
check_http bridge "$BRIDGE_HEALTH_URL" 200
check_http analytics "$ANALYTICS_HEALTH_URL" 200
check_http analytics_without_key "$ANALYTICS_PROTECTED_URL" 401
if [[ -n "$EXTERNAL_HEALTH_URL" ]]; then
  check_http external "$EXTERNAL_HEALTH_URL" 200
fi

if [[ "$CHECK_BACKUP" == 1 ]]; then
  [[ "$BACKUP_DIR" == /* && "$BACKUP_DIR" != "/" ]] \
    || fail "BACKUP_DIR debe ser absoluto y explicito"
  [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] \
    || fail "DB_NAME debe ser explicito y valido"
  command -v gzip >/dev/null 2>&1 || fail "falta gzip"
  command -v sha256sum >/dev/null 2>&1 || fail "falta sha256sum"
  [[ -d "$BACKUP_DIR" ]] || fail "no existe BACKUP_DIR"

  LATEST=""
  LATEST_MTIME=0
  while IFS= read -r candidate; do
    base=$(basename -- "$candidate")
    if [[ "$base" =~ ^${DB_NAME}_[0-9]{8}T[0-9]{6}Z\.sql\.gz$ ]]; then
      mtime=$(stat -c '%Y' -- "$candidate")
      if (( mtime > LATEST_MTIME )); then
        LATEST="$candidate"
        LATEST_MTIME="$mtime"
      fi
    fi
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.sql.gz")

  [[ -n "$LATEST" ]] || fail "no existe backup programado verificable"
  SIDECAR="$LATEST.sha256"
  [[ -f "$SIDECAR" && ! -L "$SIDECAR" ]] || fail "el ultimo backup no tiene sidecar"
  (cd "$(dirname -- "$LATEST")" \
    && sha256sum -c --status "$(basename -- "$SIDECAR")") \
    || fail "checksum del ultimo backup invalido"
  gzip -t -- "$LATEST" || fail "gzip del ultimo backup invalido"

  AGE=$(( $(date +%s) - LATEST_MTIME ))
  (( AGE >= 0 && AGE <= MAX_BACKUP_AGE_SECONDS )) \
    || fail "ultimo backup fuera de RPO: age_seconds=$AGE"
  log "BACKUP_OK file=$(basename -- "$LATEST") age_seconds=$AGE"
fi

log "HEALTHCHECK_OK"
