#!/usr/bin/env bash
# nginx-uploads-isolated.sh — prueba AISLADA de /uploads en nginx: despliegue
# (código nuevo) y recuperación (código anterior), con las configuraciones
# VERSIONADAS del repo.
#
# Levanta nginx sólo en 127.0.0.1 con puertos altos y archivos temporales,
# usando deploy/nginx.compose.conf (HTTP) y deploy/nginx-sishoras.conf (HTTPS,
# certificado autofirmado temporal) con los upstreams reemplazados por
# backends locales:
#   new        guard actual (lista positiva desde base simulada);
#   prev-pr    guard por prefijos de ef82b32 (si el objeto git está disponible);
#   prev-main  sin guard, express.static de todo /uploads (main 7638fa9).
# Para cada combinación verifica que sólo el logo/favicon públicos respondan
# 200 y que firma/sello con nombre numérico, fotos, selfies, documentos,
# justificativos, carpetas desconocidas y rutas con recorrido respondan 404.
#
# No toca ninguna configuración del sistema ni producción.
# Requiere: nginx, node, openssl, curl y api/node_modules instalado.
set -Eeuo pipefail

REPO=$(cd "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  [[ -f "$TMP/nginx.pid" ]] && nginx -p "$TMP" -c "$TMP/nginx.conf" -s stop 2>/dev/null || true
  case "$TMP" in /tmp/*) rm -rf -- "$TMP" ;; esac
}
trap cleanup EXIT

for bin in nginx node openssl curl; do command -v "$bin" >/dev/null || { echo "falta $bin" >&2; exit 2; }; done
[[ -d "$REPO/api/node_modules/express" ]] || { echo "falta api/node_modules (npm ci en api/)" >&2; exit 2; }

FAILS=0
ok()   { printf '  ok   %-58s %s\n' "$1" "$2"; }
bad()  { printf '  FAIL %-58s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

# ── Archivos sintéticos ─────────────────────────────────────────────────────
UP="$TMP/uploads"
mkdir -p "$UP/selfies" "$UP/employee-documents" "$UP/permissions" "$UP/nuevo" "$UP/faces"
PNG=$(printf '\x89PNG\r\n\x1a\n')
for f in 1700000000_ab12cd.png 1789990000000_ab12cd34.png 1789990000001_cd34ef56.png \
         signature_1789990000002.png avatar_7_ab12cd.png nuevo/x.png; do
  printf '%s-sintetico-%s' "$PNG" "$f" > "$UP/$f"
done
printf 'ICO-sintetico' > "$UP/1700000001_ffee00.ico"
printf '\xff\xd8\xff-selfie' > "$UP/selfies/selfie_7_1.jpg"
printf '\xff\xd8\xff-face' > "$UP/faces/face_7.jpg"
printf '%%PDF-1.7 doc %%%%EOF' > "$UP/employee-documents/doc_1_ab.pdf"
printf '%%PDF-1.7 perm %%%%EOF' > "$UP/permissions/perm_1_ab.pdf"

PUBLIC_URLS=$'/uploads/1700000000_ab12cd.png\n/uploads/1700000001_ffee00.ico'
printf '%s\n' "$PUBLIC_URLS" > "$TMP/public-urls.txt"
export PUBLIC_SETTINGS_JSON='{"system_logo_url":"/uploads/1700000000_ab12cd.png","system_favicon_url":"/uploads/1700000001_ffee00.ico"}'

# Guard anterior por prefijos (ef82b32), si el historial está disponible.
PREV_GUARD="$TMP/prev-guard/uploadsGuard.js"
mkdir -p "$TMP/prev-guard"
MODES=(new prev-main)
if git -C "$REPO" show ef82b32:api/src/middleware/uploadsGuard.js > "$PREV_GUARD" 2>/dev/null; then
  MODES=(new prev-pr prev-main)
else
  echo "(aviso) objeto ef82b32 no disponible: se omite el modo prev-pr" >&2
fi

# ── Backends ───────────────────────────────────────────────────────────────
declare -A BPORT=([new]=18401 [prev-pr]=18402 [prev-main]=18403)
WEB_PORT=18410
for m in "${MODES[@]}"; do
  node "$REPO/deploy/tests/uploads-backend.js" "$m" "${BPORT[$m]}" "$UP" "$PREV_GUARD" > "$TMP/backend-$m.log" 2>&1 &
  PIDS+=("$!")
done
node -e "require('http').createServer((q,r)=>{r.writeHead(200,{'content-type':'text/plain'});r.end('web-dummy')}).listen($WEB_PORT,'127.0.0.1')" &
PIDS+=("$!")
for m in "${MODES[@]}"; do
  for _ in $(seq 1 50); do grep -q ready "$TMP/backend-$m.log" 2>/dev/null && break; sleep 0.1; done
  grep -q ready "$TMP/backend-$m.log" || { cat "$TMP/backend-$m.log"; echo "backend $m no arrancó" >&2; exit 2; }
done

# ── Certificado autofirmado temporal para la config del host ───────────────
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout "$TMP/privkey.pem" -out "$TMP/fullchain.pem" >/dev/null 2>&1

HTTP_PORT=18480; HTTPS_PORT=18443; REDIR_PORT=18481
mkdir -p "$TMP/snippets" "$TMP/logs"

render_sites() { # $1 = puerto del backend
  local b="$1"
  "$REPO/scripts/gen-nginx-uploads-allowlist.sh" --upstream "http://127.0.0.1:$b" \
    --from-file "$TMP/public-urls.txt" -o "$TMP/snippets/sishoras-uploads-public.conf" 2>/dev/null
  sed -e "s#listen 80;#listen 127.0.0.1:$HTTP_PORT;#" -e '/listen \[::\]:80;/d' \
      -e "s#http://api:4000#http://127.0.0.1:$b#g" -e "s#http://web:3000#http://127.0.0.1:$WEB_PORT#g" \
      -e "s#http://analytics:5000#http://127.0.0.1:$WEB_PORT#g" \
      -e "s#/etc/nginx/snippets/#$TMP/snippets/#g" \
      "$REPO/deploy/nginx.compose.conf" > "$TMP/site-compose.conf"
  sed -e "s#listen 80;#listen 127.0.0.1:$REDIR_PORT;#" -e '/listen \[::\]:80;/d' \
      -e "s#listen 443 ssl;#listen 127.0.0.1:$HTTPS_PORT ssl;#" -e '/listen \[::\]:443 ssl;/d' \
      -e "s#/etc/ssl/sishoras/#$TMP/#g" \
      -e "s#http://127.0.0.1:4000#http://127.0.0.1:$b#g" -e "s#http://127.0.0.1:3000#http://127.0.0.1:$WEB_PORT#g" \
      -e "s#http://127.0.0.1:5000#http://127.0.0.1:$WEB_PORT#g" \
      -e "s#/etc/nginx/snippets/#$TMP/snippets/#g" \
      -e "s#/var/log/nginx/#$TMP/logs/#g" \
      "$REPO/deploy/nginx-sishoras.conf" > "$TMP/site-host.conf"
  local user_line=""
  [[ $EUID -eq 0 ]] && user_line="user root;"
  cat > "$TMP/nginx.conf" <<EOF
$user_line
worker_processes 1;
pid $TMP/nginx.pid;
error_log $TMP/logs/error.log warn;
events { worker_connections 64; }
http {
  access_log $TMP/logs/access.log;
  client_body_temp_path $TMP/cbt; proxy_temp_path $TMP/pt; fastcgi_temp_path $TMP/ft;
  uwsgi_temp_path $TMP/ut; scgi_temp_path $TMP/st;
  include $TMP/site-compose.conf;
  include $TMP/site-host.conf;
}
EOF
}

# code_of <url> [curl args...] → imprime "<status> <primeros bytes>"
code_of() {
  local url="$1"; shift
  local body="$TMP/body"
  local st
  st=$(curl -sk --path-as-is -o "$body" -w '%{http_code}' "$@" "$url" || echo 000)
  printf '%s %s' "$st" "$(head -c 12 "$body" 2>/dev/null | tr -c '[:print:]' '.')"
}
expect_status() { # label expected url [curl args]
  local label="$1" exp="$2" url="$3"; shift 3
  local r; r=$(code_of "$url" "$@")
  [[ "${r%% *}" == "$exp" ]] && ok "$label" "→ $r" || bad "$label" "→ $r (esperado $exp)"
}
expect_not_file() { # label url: cualquier respuesta que NO sea el archivo
  local label="$1" url="$2"
  local r; r=$(code_of "$url")
  if [[ "${r%% *}" == "200" && "$r" == *PNG* ]]; then bad "$label" "→ $r (sirvió el archivo)"; else ok "$label" "→ $r"; fi
}

PRIVATE=(
  "firma con nombre numérico|/uploads/1789990000000_ab12cd34.png"
  "sello con nombre numérico|/uploads/1789990000001_cd34ef56.png"
  "firma dibujada (signature_)|/uploads/signature_1789990000002.png"
  "foto de perfil (avatar_)|/uploads/avatar_7_ab12cd.png"
  "selfie de asistencia|/uploads/selfies/selfie_7_1.jpg"
  "foto facial|/uploads/faces/face_7.jpg"
  "documento de empleado|/uploads/employee-documents/doc_1_ab.pdf"
  "justificativo de licencia|/uploads/permissions/perm_1_ab.pdf"
  "carpeta desconocida|/uploads/nuevo/x.png"
  "recorrido codificado %2e%2e|/uploads/%2e%2e/uploads/1789990000000_ab12cd34.png"
  "recorrido literal x/..|/uploads/x/../1789990000000_ab12cd34.png"
  "recorrido desde un público|/uploads/1700000000_ab12cd.png/../1789990000000_ab12cd34.png"
  "doble barra|/uploads//1789990000000_ab12cd34.png"
  "barra codificada %2F|/uploads/selfies%2Fselfie_7_1.jpg"
  "archivo inexistente|/uploads/no-existe.png"
)

nginx_start() { nginx -p "$TMP" -c "$TMP/nginx.conf" -t -q && nginx -p "$TMP" -c "$TMP/nginx.conf"; sleep 0.3; }
nginx_stop()  { nginx -p "$TMP" -c "$TMP/nginx.conf" -s stop 2>/dev/null || true; for _ in $(seq 1 30); do [[ -f "$TMP/nginx.pid" ]] || break; sleep 0.1; done; }

for m in "${MODES[@]}"; do
  b=${BPORT[$m]}
  case "$m" in
    new) escenario="DESPLIEGUE (código nuevo)" ;;
    prev-pr) escenario="RECUPERACIÓN a ef82b32 (guard por prefijos)" ;;
    prev-main) escenario="RECUPERACIÓN a main 7638fa9 (sin guard)" ;;
  esac
  echo "== $escenario — backend $m =="
  # Referencia: qué entrega el backend SIN nginx (muestra el riesgo que cubre nginx).
  echo "  (directo al backend, sin nginx) firma numérica → $(code_of "http://127.0.0.1:$b/uploads/1789990000000_ab12cd34.png")"
  render_sites "$b"
  nginx_start
  for base in "http://127.0.0.1:$HTTP_PORT|compose" "https://127.0.0.1:$HTTPS_PORT|host"; do
    url="${base%%|*}"; tag="${base##*|}"
    expect_status "[$tag] logo público" 200 "$url/uploads/1700000000_ab12cd.png"
    expect_status "[$tag] favicon público" 200 "$url/uploads/1700000001_ffee00.ico"
    expect_status "[$tag] logo público con query string" 200 "$url/uploads/1700000000_ab12cd.png?v=2"
    expect_status "[$tag] POST al logo (sólo GET)" 403 "$url/uploads/1700000000_ab12cd.png" -X POST
    for item in "${PRIVATE[@]}"; do
      expect_status "[$tag] ${item%%|*}" 404 "$url${item##*|}"
    done
    expect_not_file "[$tag] mayúsculas /UPLOADS/ (va a la web, no al archivo)" "$url/UPLOADS/1789990000000_ab12cd34.png"
    cc=$(curl -sk -o /dev/null -D - "$url/uploads/1789990000000_ab12cd34.png" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
    [[ "$cc" == "no-store" ]] && ok "[$tag] 404 de /uploads con Cache-Control no-store" "" || bad "[$tag] 404 sin no-store" "($cc)"
  done
  nginx_stop
done

echo
if (( FAILS )); then echo "❌ $FAILS verificación(es) fallaron"; exit 1; fi
echo "✅ nginx aislado: sólo los recursos de marca listados responden; lo privado queda cerrado en despliegue y recuperación (${MODES[*]})."
