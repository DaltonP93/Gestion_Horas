#!/usr/bin/env bash
# nginx-uploads-isolated.sh — prueba AISLADA de /uploads y de los recursos de
# marca en nginx: despliegue (código nuevo) y recuperación (código anterior),
# con las configuraciones VERSIONADAS del repo.
#
# Levanta nginx sólo en 127.0.0.1 con puertos altos y archivos temporales,
# usando deploy/nginx.compose.conf (HTTP) y deploy/nginx-sishoras.conf (HTTPS,
# certificado autofirmado temporal) con los upstreams reemplazados por
# backends locales:
#   new        código actual: router REAL de ajustes (upload/PUT/reset/brand)
#              con JWT real y base simulada en memoria;
#   prev-pr    guard por prefijos de ef82b32 (si el objeto git está disponible);
#   prev-main  sin guard, express.static de todo /uploads (main 7638fa9).
#
# Con el backend nuevo, DESPUÉS de arrancar nginx y sin tocar su
# configuración, cambia cada recurso de marca desde el endpoint real,
# verifica que la URL anunciada funcione por nginx, lo reemplaza y restablece
# los valores por defecto; comprueba el logo heredado y que la firma no se
# pueda publicar. Luego, con cada backend anterior sobre el MISMO directorio,
# verifica que los recursos de marca nuevos sigan visibles y que firma, sello,
# fotos, selfies, documentos, justificativos, carpetas desconocidas y rutas con
# recorrido sigan en 404.
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
ok()   { printf '  ok   %-64s %s\n' "$1" "$2"; }
bad()  { printf '  FAIL %-64s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

# ── Archivos sintéticos ─────────────────────────────────────────────────────
UP="$TMP/uploads"
mkdir -p "$UP/selfies" "$UP/employee-documents" "$UP/permissions" "$UP/nuevo" "$UP/faces" "$UP/brand"
PNG=$(printf '\x89PNG\r\n\x1a\n')
for f in 1700000000_ab12cd.png 1789990000000_ab12cd34.png 1789990000001_cd34ef56.png \
         signature_1789990000002.png avatar_7_ab12cd.png nuevo/x.png; do
  printf '%s-sintetico-%s' "$PNG" "$f" > "$UP/$f"
done
printf '\xff\xd8\xff-selfie' > "$UP/selfies/selfie_7_1.jpg"
printf '\xff\xd8\xff-face' > "$UP/faces/face_7.jpg"
printf '%%PDF-1.7 doc %%%%EOF' > "$UP/employee-documents/doc_1_ab.pdf"
printf '%%PDF-1.7 perm %%%%EOF' > "$UP/permissions/perm_1_ab.pdf"
mkimg() { printf '%s-%s' "$PNG" "$1" > "$TMP/$1.png"; }

# Logo HEREDADO en la raíz (configuración previa a uploads/brand).
export SEED_SETTINGS_JSON='{"system_logo_url":"/uploads/1700000000_ab12cd.png"}'
export JWT_SECRET="nginx-isolated-test-secret-$(date +%s)"
TOKEN=$(cd "$REPO/api" && node -e "process.stdout.write(require('jsonwebtoken').sign({id:1,role:'admin'},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'10m'}))")

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
mkdir -p "$TMP/logs"
C="http://127.0.0.1:$HTTP_PORT"      # compose
H="https://127.0.0.1:$HTTPS_PORT"    # host

render_sites() { # $1 = puerto del backend
  local b="$1"
  sed -e "s#listen 80;#listen 127.0.0.1:$HTTP_PORT;#" -e '/listen \[::\]:80;/d' \
      -e "s#http://api:4000#http://127.0.0.1:$b#g" -e "s#http://web:3000#http://127.0.0.1:$WEB_PORT#g" \
      -e "s#http://analytics:5000#http://127.0.0.1:$WEB_PORT#g" \
      "$REPO/deploy/nginx.compose.conf" > "$TMP/site-compose.conf"
  sed -e "s#listen 80;#listen 127.0.0.1:$REDIR_PORT;#" -e '/listen \[::\]:80;/d' \
      -e "s#listen 443 ssl;#listen 127.0.0.1:$HTTPS_PORT ssl;#" -e '/listen \[::\]:443 ssl;/d' \
      -e "s#/etc/ssl/sishoras/#$TMP/#g" \
      -e "s#http://127.0.0.1:4000#http://127.0.0.1:$b#g" -e "s#http://127.0.0.1:3000#http://127.0.0.1:$WEB_PORT#g" \
      -e "s#http://127.0.0.1:5000#http://127.0.0.1:$WEB_PORT#g" \
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

# code_of <url> [curl args...] → "<status> <primeros bytes>"
code_of() {
  local url="$1"; shift
  local body="$TMP/body" st
  st=$(curl -sk --path-as-is -o "$body" -w '%{http_code}' "$@" "$url" || echo 000)
  printf '%s %s' "$st" "$(head -c 12 "$body" 2>/dev/null | tr -c '[:print:]' '.')"
}
expect_status() { # label expected url [curl args]
  local label="$1" exp="$2" url="$3"; shift 3
  local r; r=$(code_of "$url" "$@")
  [[ "${r%% *}" == "$exp" ]] && ok "$label" "→ $r" || bad "$label" "→ $r (esperado $exp)"
}
expect_body() { # label url archivo-esperado
  local label="$1" url="$2" want="$3"
  local st; st=$(curl -sk -o "$TMP/got" -w '%{http_code}' "$url" || echo 000)
  if [[ "$st" == 200 ]] && cmp -s "$TMP/got" "$want"; then ok "$label" "→ 200 (contenido idéntico)"; else bad "$label" "→ $st (contenido distinto o error)"; fi
}
expect_not_file() {
  local label="$1" url="$2" r; r=$(code_of "$url")
  if [[ "${r%% *}" == "200" && "$r" == *PNG* ]]; then bad "$label" "→ $r (sirvió el archivo)"; else ok "$label" "→ $r"; fi
}
json_field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j[process.argv[1]] ?? ''))})" "$1"; }
announced() { curl -sk "$C/api/settings" | json_field "$1"; }
upload() { # kind archivo → imprime la URL devuelta
  curl -sk -X POST -H "Authorization: Bearer $TOKEN" -F "file=@$2;type=image/png;filename=img.png" \
    "$C/api/settings/upload?kind=$1" | json_field url
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
  "recorrido desde brand/|/uploads/brand/../1789990000000_ab12cd34.png"
  "recorrido codificado desde brand/|/uploads/brand/%2e%2e/1789990000000_ab12cd34.png"
  "barra codificada en brand/|/uploads/brand%2F..%2F1789990000000_ab12cd34.png"
  "doble barra|/uploads//1789990000000_ab12cd34.png"
  "barra codificada %2F|/uploads/selfies%2Fselfie_7_1.jpg"
  "archivo inexistente|/uploads/no-existe.png"
  "archivo heredado de la raíz por /uploads|/uploads/1700000000_ab12cd.png"
)

nginx_start() { nginx -p "$TMP" -c "$TMP/nginx.conf" -t -q && nginx -p "$TMP" -c "$TMP/nginx.conf"; sleep 0.3; }
nginx_stop()  { nginx -p "$TMP" -c "$TMP/nginx.conf" -s stop 2>/dev/null || true; for _ in $(seq 1 30); do [[ -f "$TMP/nginx.pid" ]] || break; sleep 0.1; done; }

check_private() {
  for base in "$C|compose" "$H|host"; do
    local url="${base%%|*}" tag="${base##*|}"
    for item in "${PRIVATE[@]}"; do expect_status "[$tag] ${item%%|*}" 404 "$url${item##*|}"; done
    [[ -n "${SIG_URL:-}" ]] && expect_status "[$tag] firma subida desde Apariencia (por /uploads)" 404 "$url$SIG_URL"
    expect_status "[$tag] POST a un recurso de marca (sólo GET)" 403 "$url${BRAND_LAST:-/uploads/brand/x.png}" -X POST
    expect_not_file "[$tag] mayúsculas /UPLOADS/ (va a la web)" "$url/UPLOADS/1789990000000_ab12cd34.png"
    local cc
    cc=$(curl -sk -o /dev/null -D - "$url/uploads/1789990000000_ab12cd34.png" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
    [[ "$cc" == "no-store" ]] && ok "[$tag] 404 de /uploads con Cache-Control no-store" "" || bad "[$tag] 404 sin no-store" "($cc)"
  done
}

declare -A BRAND_URL=()
for m in "${MODES[@]}"; do
  b=${BPORT[$m]}
  case "$m" in
    new) escenario="DESPLIEGUE (código nuevo)" ;;
    prev-pr) escenario="RECUPERACIÓN a ef82b32 (guard por prefijos)" ;;
    prev-main) escenario="RECUPERACIÓN a main 7638fa9 (sin guard)" ;;
  esac
  echo "== $escenario — backend $m =="
  echo "  (directo al backend, sin nginx) firma numérica → $(code_of "http://127.0.0.1:$b/uploads/1789990000000_ab12cd34.png")"
  render_sites "$b"
  nginx_start

  if [[ "$m" == new ]]; then
    # Logo heredado: anunciado por la ruta estable de la API.
    L=$(announced system_logo_url)
    [[ "$L" == /api/settings/brand/logo\?v=* ]] && ok "logo heredado anunciado por la API" "→ $L" || bad "logo heredado anunciado" "→ $L"
    expect_body "[compose] logo heredado por la URL anunciada" "$C$L" "$UP/1700000000_ab12cd.png"
    expect_body "[host] logo heredado por la URL anunciada" "$H$L" "$UP/1700000000_ab12cd.png"

    # Cambios DESPUÉS del arranque, desde el endpoint real, sin tocar nginx.
    for kind in logo favicon pwa_icon login_bg; do
      case "$kind" in logo) key=system_logo_url ;; favicon) key=system_favicon_url ;; pwa_icon) key=system_pwa_icon_url ;; login_bg) key=system_login_bg_image ;; esac
      mkimg "$kind-a"; mkimg "$kind-b"
      u1=$(upload "$kind" "$TMP/$kind-a.png")
      [[ "$(announced $key)" == "$u1" && "$u1" == /uploads/brand/* ]] && ok "$kind: URL anunciada tras subir" "→ $u1" || bad "$kind: URL anunciada tras subir" "→ $u1 / $(announced $key)"
      expect_body "[compose] $kind subido" "$C$u1" "$TMP/$kind-a.png"
      expect_body "[host] $kind subido" "$H$u1" "$TMP/$kind-a.png"
      u2=$(upload "$kind" "$TMP/$kind-b.png")
      [[ "$(announced $key)" == "$u2" && "$u2" != "$u1" ]] && ok "$kind: URL anunciada tras reemplazar" "→ $u2" || bad "$kind: URL anunciada tras reemplazar" "→ $u2"
      expect_body "[compose] $kind reemplazado" "$C$u2" "$TMP/$kind-b.png"
      expect_body "[host] $kind reemplazado" "$H$u2" "$TMP/$kind-b.png"
      BRAND_URL[$kind]="$u2"; BRAND_LAST="$u2"
    done

    # La firma subida desde Apariencia no se publica, ni por /uploads ni por brand.
    mkimg firma
    SIG_URL=$(curl -sk -X POST -H "Authorization: Bearer $TOKEN" -F "file=@$TMP/firma.png;type=image/png;filename=f.png" \
      "$C/api/settings/upload?kind=signature" | json_field url)
    [[ "$SIG_URL" == /uploads/* && "$SIG_URL" != /uploads/brand/* ]] && ok "firma guardada fuera de uploads/brand" "→ $SIG_URL" || bad "firma guardada" "→ $SIG_URL"
    expect_status "[compose] /api/settings/brand/signature" 404 "$C/api/settings/brand/signature"
    st=$(curl -sk -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"system_logo_url\":\"$SIG_URL\"}" "$C/api/settings")
    [[ "$st" == 400 ]] && ok "PUT logo → archivo de firma rechazado" "→ 400" || bad "PUT logo → firma" "→ $st"
    [[ "$(announced system_logo_url)" == "${BRAND_URL[logo]}" ]] && ok "el logo anunciado no cambió" "" || bad "el logo anunciado cambió" "→ $(announced system_logo_url)"

    check_private

    # Restablecer valores por defecto desde el endpoint real.
    st=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$C/api/settings/reset")
    [[ "$st" == 200 ]] && ok "restablecer apariencia" "→ 200" || bad "restablecer apariencia" "→ $st"
    for key in system_logo_url system_favicon_url system_pwa_icon_url system_login_bg_image; do
      [[ -z "$(announced $key)" ]] && ok "tras restablecer: $key vacío" "" || bad "tras restablecer: $key" "→ $(announced $key)"
    done
  else
    # Recuperación: los recursos de marca nuevos siguen visibles; lo privado cerrado.
    for kind in logo favicon pwa_icon login_bg; do
      expect_body "[compose] $kind (subido con el código nuevo)" "$C${BRAND_URL[$kind]}" "$TMP/$kind-b.png"
      expect_body "[host] $kind (subido con el código nuevo)" "$H${BRAND_URL[$kind]}" "$TMP/$kind-b.png"
    done
    check_private
  fi
  nginx_stop
done

echo
if (( FAILS )); then echo "❌ $FAILS verificación(es) fallaron"; exit 1; fi
echo "✅ nginx aislado: la marca se administra desde la aplicación sin tocar nginx; lo privado queda cerrado en despliegue y recuperación (${MODES[*]})."
