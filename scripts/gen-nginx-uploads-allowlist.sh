#!/usr/bin/env bash
# gen-nginx-uploads-allowlist.sh — genera la lista EXACTA de recursos públicos
# de marca que nginx puede servir bajo /uploads/ (todo lo demás: 404).
#
# nginx bloquea /uploads/ por defecto (deploy/nginx-sishoras.conf,
# deploy/nginx.compose.conf) e incluye el snippet que produce este script. Así
# la protección de fotos, firmas, sellos, selfies, documentos y adjuntos NO
# depende del código de la API: sigue vigente aunque se vuelva a una versión
# anterior (que servía /uploads completo o con reglas por prefijo).
#
# Los logos y las firmas comparten el formato de nombre (<epoch>_<hex>.<ext>):
# no se puede distinguir por prefijo; por eso la lista es por nombre EXACTO.
#
# Uso:
#   # desde la base (SÓLO lectura: un SELECT sobre notification_settings)
#   DB_NAME=asistencia MYSQL_DEFAULTS_FILE=/root/.sishoras-ro.cnf \
#     scripts/gen-nginx-uploads-allowlist.sh --upstream http://127.0.0.1:4000 \
#       -o /etc/nginx/snippets/sishoras-uploads-public.conf
#   # desde un archivo con una URL por línea (/uploads/<archivo>)
#   scripts/gen-nginx-uploads-allowlist.sh --upstream http://api:4000 --from-file urls.txt -o out.conf
#
# Fail-closed: si algún valor no es un recurso público válido (un segmento, sin
# puntos iniciales, extensión de imagen) NO escribe nada y sale con código 3,
# salvo --skip-invalid (lo omite y lo informa). La salida se escribe de forma
# atómica. No recarga nginx: validar con `nginx -t` y recargar es un paso
# manual de OPS.
set -Eeuo pipefail

fail() { echo "ERROR: $1" >&2; exit "${2:-1}"; }

UPSTREAM=""
FROM_FILE=""
OUT=""
SKIP_INVALID=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream) UPSTREAM="${2:-}"; shift 2 ;;
    --from-file) FROM_FILE="${2:-}"; shift 2 ;;
    -o|--output) OUT="${2:-}"; shift 2 ;;
    --skip-invalid) SKIP_INVALID=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) fail "argumento desconocido: $1" ;;
  esac
done

[[ "$UPSTREAM" =~ ^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$ ]] || fail "--upstream inválido (ej. http://127.0.0.1:4000)"

# Claves de ajustes que son públicas por diseño (mismas que PUBLIC_ASSET_KEYS
# en api/src/middleware/uploadsGuard.js). Firma y sello NO están.
KEYS="'system_logo_url','system_favicon_url','system_pwa_icon_url','system_login_bg_image'"

if [[ -n "$FROM_FILE" ]]; then
  [[ -f "$FROM_FILE" ]] || fail "no existe $FROM_FILE"
  VALUES=$(cat -- "$FROM_FILE")
else
  DB_NAME="${DB_NAME:-}"
  MYSQL_DEFAULTS_FILE="${MYSQL_DEFAULTS_FILE:-}"
  [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "DB_NAME debe ser explícito y válido"
  [[ "$MYSQL_DEFAULTS_FILE" == /* && -f "$MYSQL_DEFAULTS_FILE" && ! -L "$MYSQL_DEFAULTS_FILE" ]] \
    || fail "MYSQL_DEFAULTS_FILE debe ser un archivo absoluto (no symlink)"
  PERM=$(stat -c '%a' -- "$MYSQL_DEFAULTS_FILE")
  (( (8#$PERM & 077) == 0 )) || fail "MYSQL_DEFAULTS_FILE debe tener modo 0600 o más restrictivo"
  VALUES=$(mysql --defaults-extra-file="$MYSQL_DEFAULTS_FILE" -N -B "$DB_NAME" \
    -e "SELECT setting_value FROM notification_settings WHERE setting_key IN ($KEYS)")
fi

VALID_RE='^/uploads/[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.([Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Ww][Ee][Bb][Pp]|[Gg][Ii][Ff]|[Ii][Cc][Oo]|[Ss][Vv][Gg])$'
declare -A SEEN=()
NAMES=()
INVALID=0
while IFS= read -r raw; do
  v="${raw%$'\r'}"
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  [[ -z "$v" || "$v" == "NULL" ]] && continue
  if [[ ! "$v" =~ $VALID_RE || ${#v} -gt 220 ]]; then
    echo "INVALIDO (no se publica): $v" >&2
    INVALID=1
    continue
  fi
  name="${v#/uploads/}"
  [[ -n "${SEEN[$name]:-}" ]] && continue
  SEEN[$name]=1
  NAMES+=("$name")
done <<< "$VALUES"

if (( INVALID )) && (( ! SKIP_INVALID )); then
  fail "hay valores inválidos; no se escribió nada (use --skip-invalid para omitirlos)" 3
fi

render() {
  echo "# GENERADO por scripts/gen-nginx-uploads-allowlist.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# No editar a mano. Recursos públicos de marca: ${#NAMES[@]}. Todo lo demás en /uploads/ → 404."
  for n in "${NAMES[@]}"; do
    cat <<EOF
location = /uploads/$n {
    limit_except GET { deny all; }
    proxy_pass         $UPSTREAM/uploads/$n;
    proxy_http_version 1.1;
    proxy_set_header   Host \$host;
    proxy_no_cache     1;
    proxy_cache_bypass 1;
}
EOF
  done
}

if [[ -z "$OUT" ]]; then
  render
else
  TMP_OUT=$(mktemp "$(dirname -- "$OUT")/.uploads-allowlist.XXXXXX")
  render > "$TMP_OUT"
  chmod 0644 "$TMP_OUT"
  mv -f -- "$TMP_OUT" "$OUT"
  echo "Escrito $OUT (${#NAMES[@]} recurso(s) público(s)). Validar con 'nginx -t' y recargar." >&2
fi
